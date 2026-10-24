import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { jwtSubject } from './network';
import { StorageManager } from './storage';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor, RecordedRequest } from './test-harness';

/**
 * Scan 6 (web) - the probes from that scan, lifted as regression tests, plus
 * the round-6 contract rules 61-63 and 65.
 */

const resetSingleton = () => {
  (JoryioSDK as any).instance = null;
};
let store: Map<string, string>;
beforeEach(() => {
  resetSingleton();
  store = installLocalStorage();
});
afterEach(async () => {
  const s = JoryioSDK.getInstance();
  if (s) await s.destroy().catch(() => undefined);
  resetSingleton();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

const jwtFor = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64').replace(/=+$/, '')}.s`;
const tokenSub = (req: RecordedRequest) => jwtSubject((req.init?.headers || {})['X-Joryio-Auth']);

/** A server that refuses (401) any request whose user ids are not the token's `sub`. */
const authServer = (down: () => boolean) => (req: RecordedRequest) => {
  if (down()) return { status: 503, body: {} };
  const token = (req.init?.headers || {})['X-Joryio-Auth'];
  const users = [req.body?.userId, req.body?.identify?.userId, ...(req.body?.events || []).map((e: any) => e.userId)].filter(Boolean);
  if (users.some((u: string) => jwtSubject(token) !== u)) {
    return { status: 401, body: { error: 'sdk_authentication_error', reason: token ? 'sub_mismatch' : 'missing' } };
  }
  return { status: 200, body: { success: true, identified: true } };
};

/** A fake window whose listeners a test can fire (storage events from "another tab"). */
function installWindow() {
  const listeners: Record<string, ((e?: any) => void)[]> = {};
  (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, readyState: 'complete', title: '', referrer: '', hidden: false };
  (globalThis as any).window = {
    addEventListener: (t: string, fn: any) => (listeners[t] = listeners[t] || []).push(fn),
    removeEventListener: () => undefined,
    location: { href: 'https://shop.test/', pathname: '/', search: '' },
  };
  return { fire: (type: string, event?: any) => (listeners[type] || []).forEach((fn) => fn(event)) };
}

const unsubscribes = (calls: RecordedRequest[]) => calls.filter((c) => c.path.endsWith('/v1/subscriptions/channel'));
const batchEvents = (calls: RecordedRequest[]) => calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events);

describe('S1 / rule 61: replacing the token retires the outgoing one', () => {
  it("Q1: B's token set BEFORE identify('B'): A's queued unsubscribe still carries A's token", async () => {
    let down = true;
    const calls = installFetch(authServer(() => down));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => unsubscribes(calls).length > 0);
    await settle(30);
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    sdk.identify('B');
    down = false;
    (sdk as any).outbox.kick();
    await settle(3000);
    const last = unsubscribes(calls).pop()!;
    expect(last.body.userId).toBe('A');
    expect(tokenSub(last)).toBe('A');
  }, 15000);

  it("Q1b: no outage - A tracks, B's token then identify('B'): A's event goes out with A's token", async () => {
    const calls = installFetch(authServer(() => false));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A', batchFlushInterval: 60000 } as any);
    await sdk.flush();
    await settle(20);
    sdk.track('A checkout');
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    sdk.identify('B');
    await settle(300);
    await sdk.flush();
    const batches = calls.filter((c) => c.path.endsWith('/v1/track/batch'));
    const okA = batches.some((c) => c.body.events.some((e: any) => e.type === 'A checkout') && tokenSub(c) === 'A');
    expect(okA).toBe(true);
  });

  it('the other order (identify then token) still works, and a refreshed token for the same user retires nothing', async () => {
    installFetch(authServer(() => false));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any);
    sdk.setSdkAuthenticationToken(jwtFor('A')); // refresh, same sub
    expect((sdk as any).network.retiredSdkAuthUsers()).toEqual([]);
    sdk.identify('B');
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    expect((sdk as any).network.retiredSdkAuthUsers()).toEqual(['A']);
    expect((sdk as any).network.getSdkAuthHeaders('A')['X-Joryio-Auth']).toBe(jwtFor('A'));
    expect((sdk as any).network.getSdkAuthHeaders('B')['X-Joryio-Auth']).toBe(jwtFor('B'));
  });

  it('a stored map with one malformed entry keeps the others', () => {
    installFetch();
    const probe = new StorageManager(BASE_CONFIG.sdkKey, { debug() {}, info() {}, warn() {}, error() {} } as any);
    probe.set('retired_sdk_auth_tokens', { A: jwtFor('A'), B: 42, C: { token: jwtFor('C'), at: 'x' }, D: { token: jwtFor('D'), at: Date.now() } });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true } as any);
    expect((sdk as any).network.retiredSdkAuthUsers().sort()).toEqual(['A', 'D']);
  });

  it('a retired token is attached on a page view that did not enable SDK authentication', async () => {
    let down = true;
    const calls = installFetch(authServer(() => down));
    let sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => unsubscribes(calls).length > 0);
    await sdk.reset();
    await sdk.destroy();
    resetSingleton();
    down = false;
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any); // no enableSdkAuthentication
    await waitFor(() => (sdk as any).outbox.size() === 0);
    const last = unsubscribes(calls).pop()!;
    expect(last.body.userId).toBe('A');
    expect(tokenSub(last)).toBe('A');
  });

  it('a retired token is forgotten after 30 days even with leftovers', () => {
    installFetch();
    const probe = new StorageManager(BASE_CONFIG.sdkKey, { debug() {}, info() {}, warn() {}, error() {} } as any);
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    probe.set('retired_sdk_auth_tokens', { A: { token: jwtFor('A'), at: old }, B: { token: jwtFor('B'), at: Date.now() } });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true } as any);
    expect((sdk as any).network.retiredSdkAuthUsers()).toEqual(['B']);
  });

  it('a retired token with nothing left queued survives a one-minute grace period, then goes', async () => {
    installFetch(authServer(() => false));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any);
    await sdk.reset();
    // A's last item (the push_permission attribute) settles...
    await waitFor(() => (sdk as any).identity.pending.isEmpty());
    await settle(100);
    // ...and A's token is still kept: within the grace period
    const network = (sdk as any).network;
    expect(network.retiredSdkAuthUsers()).toEqual(['A']);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      (sdk as any).pruneRetiredTokens();
      expect(network.retiredSdkAuthUsers()).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('S2 / rule 62: cross-tab retired tokens', () => {
  it("Q7: another tab's prune never deletes a retired token this tab still needs", async () => {
    let down = false;
    const calls = installFetch(authServer(() => down));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any;
    // tab B (other tab), then tab A
    const winB = installWindow();
    const tabB = new JoryioSDK(cfg);
    await settle(2500);
    down = true;
    resetSingleton();
    installWindow();
    const tabA = new JoryioSDK(cfg);
    tabA.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED); // API down: kept, persisted
    await waitFor(() => unsubscribes(calls).length > 0);
    await tabA.reset(); // logout in tab A: A's token retired + persisted (D-a)
    const storageB = (tabB as any).storage as StorageManager;
    expect(Object.keys(storageB.get<any>('retired_sdk_auth_tokens'))).toEqual(['A']);
    winB.fire('storage', { key: storageB.storageKeyFor('anonymous_id') }); // tab B follows the logout
    (tabA as any).outbox.destroy();
    (tabA as any).queue.stop();
    down = false;
    tabB.track('next visitor in tab B');
    await tabB.flush().catch(() => undefined);
    await settle(50);
    (tabB as any).pruneRetiredTokens();
    // tab A is reloaded: A's token is still there for A's unsubscribe
    resetSingleton();
    installWindow();
    new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true } as any);
    await settle(1500);
    const last = unsubscribes(calls).pop()!;
    expect(last.body.userId).toBe('A');
    expect(tokenSub(last)).toBe('A');
    await tabB.destroy();
  }, 30000);

  it("saving this tab's map merges another tab's entries instead of overwriting them", () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: jwtFor('A'), userId: 'A' } as any);
    const storage = (sdk as any).storage as StorageManager;
    // another tab retired Z's token after this tab loaded
    storage.set('retired_sdk_auth_tokens', { Z: { token: jwtFor('Z'), at: Date.now() } });
    sdk.identify('B'); // retires A here
    const stored = storage.get<any>('retired_sdk_auth_tokens');
    expect(Object.keys(stored).sort()).toEqual(['A', 'Z']);
  });
});

describe('S3 / rule 63: the held (D-b) user', () => {
  it('Q2: A signed in, optOut, identify(B), optIn: the new Session Start is not attributed to A', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: true, userId: 'A' } as any);
    await sdk.flush();
    sdk.optOut();
    (sdk as any).session.resetSession(); // a new session began while opted out
    sdk.identify('B');
    sdk.optIn();
    await sdk.flush();
    await settle(50);
    await sdk.flush();
    const starts = batchEvents(calls).filter((e: any) => e.type === 'Session Start');
    expect(starts[starts.length - 1].userId).toBe('B');
  });

  it('Q2b: stored held user B, stored user A, granted at init: Session Start is not A', async () => {
    const calls = installFetch();
    let sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any);
    sdk.updateConsent('denied');
    sdk.identify('B');
    await sdk.destroy();
    resetSingleton();
    const ls = (globalThis as any).localStorage;
    ls.removeItem(Array.from({ length: ls.length }, (_, i) => ls.key(i)).find((k: string) => k.endsWith('session_id')));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: true, trackingConsent: 'granted' } as any);
    await sdk.flush();
    await settle(50);
    await sdk.flush();
    const start = batchEvents(calls).find((e: any) => e.type === 'Session Start');
    expect(sdk.getUserId()).toBe('B');
    expect(start.userId).not.toBe('A');
  });

  it('Q6: an anonymous unsubscribe queued (API down) just before identify(B) while denied goes to B', async () => {
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => unsubscribes(calls).length > 0);
    sdk.identify('B');
    down = false;
    (sdk as any).outbox.kick();
    await settle(2500);
    expect(unsubscribes(calls).pop()!.body.userId).toBe('B');
  }, 10000);

  it('an explicit init userId wins over a stored held user', async () => {
    const calls = installFetch();
    let sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.identify('B'); // held (denied)
    await sdk.destroy();
    resetSingleton();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any); // still denied (stored)
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => unsubscribes(calls).length > 0);
    expect(unsubscribes(calls).pop()!.body.userId).toBe('A');
  });
});

describe('S4 / rule 62: following another tab\'s logout is a full reset()', () => {
  it("Q3: this tab adopts the new visitor AND the other tab's new session", async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any);
    const storage = (sdk as any).storage as StorageManager;
    const oldSession = sdk.getSessionInfo().sessionId;
    // what the other tab's reset() writes
    storage.remove('user_id');
    storage.set('anonymous_id', 'anon-2');
    storage.set('session_id', 'sess-2');
    win.fire('storage', { key: storage.storageKeyFor('anonymous_id') });
    sdk.track('After logout elsewhere');
    await sdk.flush();
    const ev = batchEvents(calls)[0];
    expect(ev.anonymousId).toBe('anon-2');
    expect(ev.sessionId).not.toBe(oldSession);
  });

  it('Q4: an unsent anonymous write is pinned to the user it became before the identity moves on', async () => {
    const win = installWindow();
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true, identified: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const storage = (sdk as any).storage as StorageManager;
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED); // anonymous X
    await waitFor(() => unsubscribes(calls).length > 0);
    sdk.identify('A');
    storage.remove('user_id');
    storage.set('anonymous_id', 'anon-2');
    win.fire('storage', { key: storage.storageKeyFor('anonymous_id') });
    down = false;
    (sdk as any).outbox.kick();
    await settle(2500);
    expect(unsubscribes(calls).pop()!.body.userId).toBe('A');
  }, 10000);
});

describe('rule 62: localStorage.clear() and consent across tabs', () => {
  it('Q5: another tab calling localStorage.clear() does not lift a denial here', async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    store.clear();
    win.fire('storage', { key: null });
    sdk.track('After clear');
    await sdk.flush();
    expect(sdk.getTrackingConsent()).toBe('denied');
    expect(calls.filter((c) => c.path.endsWith('/v1/track/batch'))).toEqual([]);
    // ...and the decision is stored again, for the next page view
    expect((sdk as any).storage.get('tracking_consent')).toBe('denied');
  });

  it('localStorage.clear() does not lift an opt-out either, and it is re-persisted', () => {
    const win = installWindow();
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.optOut();
    store.clear();
    win.fire('storage', { key: null });
    expect(sdk.isUserOptedOut()).toBe(true);
    expect((sdk as any).storage.get('tracking_opted_out')).toBe(true);
  });

  it("a grant in another tab reaches a tab holding in 'pending'", async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' } as any);
    sdk.track('Held');
    const storage = (sdk as any).storage as StorageManager;
    // what the other tab's updateConsent('granted') writes
    const before = new Map(store);
    // Simulate the other tab: a second instance cannot coexist, so write the same keys it would.
    (sdk as any).writeGrant();
    const changed = Array.from(store.keys()).filter((k) => store.get(k) !== before.get(k));
    expect(changed.length).toBeGreaterThan(0);
    for (const key of changed) win.fire('storage', { key });
    await settle(20);
    await sdk.flush();
    expect(sdk.getTrackingConsent()).toBe('granted');
    expect(batchEvents(calls).map((e: any) => e.type)).toContain('Held');
    void storage;
  });
});

describe('outbox: merge on write across tabs (scan 5 N8)', () => {
  it("persisting this tab's outbox keeps another tab's withdrawal", async () => {
    installWindow();
    const calls = installFetch(() => ({ status: 503, body: {} }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const storage = (sdk as any).storage as StorageManager;
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => unsubscribes(calls).length > 0);
    // another tab queued its own opt-out marker after this tab loaded
    const stored = storage.get<any[]>('write_outbox')!;
    const foreign = { ...stored[0], id: 'other-tab-1', record: { kind: 'marker', payload: { value: true, anonymousId: 'anon-other' } } };
    storage.set('write_outbox', [...stored, foreign]);
    // this tab writes its outbox again (a new write)
    sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    const after = storage.get<any[]>('write_outbox')!;
    expect(after.map((e) => e.id)).toContain('other-tab-1');
  });
});

describe('rule 63: the held (D-b) user on every withdrawal - push unregister', () => {
  let navDescriptor: PropertyDescriptor | undefined;
  afterEach(() => {
    delete (globalThis as any).Notification;
    if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
    navDescriptor = undefined;
  });

  it('push.unsubscribe() after identify(B) while denied tells the server it was B', async () => {
    const calls = installFetch();
    const sub = { endpoint: 'https://push.example/1', options: {}, toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => true };
    installWindow();
    Object.assign((globalThis as any).window, { PushManager: {}, Notification: {} });
    (globalThis as any).Notification = { permission: 'granted' };
    navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }) } },
      configurable: true,
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.identify('B'); // kept on the device for withdrawals only
    await sdk.push.unsubscribe();
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/push/unregister')));
    expect(calls.find((c) => c.path.endsWith('/v1/push/unregister'))!.body.userId).toBe('B');
  });
});

describe('NICE-4: a pre-init wipeData() keeps the init config token', () => {
  it("the config user's requests still carry the config token", () => {
    installFetch();
    const sdk = new JoryioSDK(
      { ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, userId: 'A', sdkAuthenticationToken: jwtFor('A') } as any,
      [{ method: 'wipeData' }],
    );
    expect(sdk.getUserId()).toBe('A');
    expect((sdk as any).network.sdkAuthToken).toBe(jwtFor('A'));
  });
});
