import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { NetworkClient, jwtSubject } from './network';
import { Logger } from '../utils/logger';
import { StorageManager } from './storage';
import { SessionManager } from './session';
import { resolveConfig } from './config';
import { valueProblem } from './values';
import { escapeStyleText } from './inapp';
import { installSnippetQueue } from '../index';
import {
  installLocalStorage,
  installFetch,
  installFakeDocument,
  uninstallFakeDocument,
  BASE_CONFIG,
  settle,
  waitFor,
  RecordedRequest,
} from './test-harness';

/**
 * Scan 5 (web) and the round-5 shared rules (contract v5, 49-60, D-a, D-b).
 * Every test here fails on 44379f8e1.
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
});

/** SDK-auth server: every user id in the body must carry `tok-<user>`. */
const authServer =
  (opts: { down?: () => boolean; campaignsFor?: (userId?: string) => any[] } = {}) =>
  (req: RecordedRequest) => {
    if (opts.down?.()) return { status: 503, body: {} };
    const token = (req.init?.headers || {})['X-Joryio-Auth'];
    const users = [req.body?.userId, req.body?.identify?.userId, ...(req.body?.events || []).map((e: any) => e.userId)].filter(Boolean);
    if (users.some((u: string) => `tok-${u}` !== token && jwtSubject(token) !== u)) {
      return { status: 401, body: { error: 'sdk_authentication_error', reason: token ? 'sub_mismatch' : 'missing' } };
    }
    if (req.path.endsWith('/v1/in-app/sync')) {
      return { status: 200, body: { success: true, campaigns: opts.campaignsFor ? opts.campaignsFor(req.body.userId) : [] } };
    }
    return { status: 200, body: { success: true, identified: true } };
  };

/** A JWT-shaped token whose payload names `sub` (unsigned: the SDK never verifies). */
const jwtFor = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub })).toString('base64').replace(/=+$/, '')}.s`;

const isUnsub = (c: RecordedRequest) => c.path.endsWith('/v1/subscriptions/channel') && c.body.status === 'unsubscribed';

let createdDocument = false;
afterEach(() => {
  if (createdDocument) delete (globalThis as any).document;
  createdDocument = false;
});

/** A minimal browser window whose listeners the test can fire. */
function installWindow(extra: Record<string, any> = {}) {
  const listeners: Record<string, ((e?: any) => void)[]> = {};
  if (!(globalThis as any).document) {
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, readyState: 'complete', title: '', referrer: '', hidden: false };
    createdDocument = true;
  }
  (globalThis as any).window = {
    addEventListener: (t: string, fn: any) => (listeners[t] = listeners[t] || []).push(fn),
    removeEventListener: (t: string, fn: any) => {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
    location: { href: 'https://shop.test/', pathname: '/', search: '' },
    open: jest.fn(),
    ...extra,
  };
  return { fire: (type: string, event?: any) => (listeners[type] || []).forEach((fn) => fn(event)), listeners };
}

// ---------------------------------------------------------------------------

describe('S1 / rule 50: a 402 never stops withdrawals', () => {
  it('an unsubscribe made after an ordinary write got 402 is still sent this page view (probe P1)', async () => {
    const calls = installFetch((req) => {
      if (req.path.endsWith('/v1/subscriptions/channel') && req.body.status !== 'unsubscribed') {
        return { status: 402, body: { code: 'SDK_INGESTION_SUSPENDED' } };
      }
      return { status: 200, body: { success: true } };
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/subscriptions/channel')));
    await settle(50);
    sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    await settle(300);
    expect(calls.filter(isUnsub).length).toBe(1);
    // The refused subscribe is kept (held while the workspace is paused), never dropped.
    expect((sdk as any).outbox.records().map((r: any) => r.payload.status)).toEqual(['subscribed']);
  });

  it('a 402 never counts toward a write\'s attempt cap, and never stops the retries', async () => {
    const calls = installFetch(() => ({ status: 402, body: { code: 'SDK_INGESTION_SUSPENDED' } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED); // a withdrawal: sent even when paused
    const outbox = (sdk as any).outbox;
    for (let i = 0; i < 15; i++) {
      await waitFor(() => outbox.inFlight === null);
      outbox.entries.forEach((e: any) => (e.notBefore = 0));
      outbox.kick();
      await settle(5);
    }
    await waitFor(() => outbox.inFlight === null);
    expect(outbox.size()).toBe(1);
    expect(outbox.entries[0].attempts).toBe(0);
    expect(calls.filter(isUnsub).length).toBeGreaterThan(10);
  });
});

describe('D-b: identify() while tracking is off is kept locally for withdrawals', () => {
  it('an unsubscribe after identify() under denied consent carries that user id (probe P2)', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.identify('user-B');
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/subscriptions/channel')));
    const unsub = calls.find((c) => c.path.endsWith('/v1/subscriptions/channel'))!;
    expect(unsub.body.userId).toBe('user-B');
    // Nothing else left the device: no identify, no event.
    expect(calls.filter((c) => c.path.endsWith('/v1/track/batch') || c.path.endsWith('/v1/identify'))).toEqual([]);
    expect(sdk.getUserId()).toBeNull();
  });

  it('the opt-out marker after identify() while opted out goes to that user', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.optOut();
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/attributes')));
    calls.length = 0;
    // A marker queued before identify keeps its ids; a fresh unsubscribe after it uses the kept user.
    sdk.identify('user-C');
    sdk.user.removeFromSubscriptionGroup('list-1');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/subscriptions/group')));
    expect(calls.find((c) => c.path.endsWith('/v1/subscriptions/group'))!.body.userId).toBe('user-C');
  });

  it('survives a reload, and the normal identify runs once consent is granted', async () => {
    const calls = installFetch();
    let sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, persistQueue: true, trackingConsent: 'denied' } as any);
    sdk.identify('user-B');
    await sdk.destroy();
    resetSingleton();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, persistQueue: true } as any); // stored denial holds
    sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => calls.some(isUnsub));
    expect(calls.find(isUnsub)!.body.userId).toBe('user-B');
    sdk.updateConsent('granted');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/track/batch') && c.body.identify));
    expect(calls.find((c) => c.path.endsWith('/v1/track/batch') && c.body.identify)!.body.identify.userId).toBe('user-B');
    expect(sdk.getUserId()).toBe('user-B');
  });

  it('reset() forgets the kept user id', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.identify('user-B');
    await sdk.reset();
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => calls.some(isUnsub));
    expect(calls.find(isUnsub)!.body.userId).toBeUndefined();
  });
});

describe('S3: reset() never fires the host auth handler for the logged-out user', () => {
  beforeEach(() => {
    installFakeDocument();
    Object.assign((globalThis as any).document, { addEventListener() {}, removeEventListener() {}, readyState: 'complete', title: '', referrer: '' });
    installWindow();
  });
  afterEach(() => uninstallFakeDocument());

  it("A's dismissal at logout goes with A's token, and the handler is not called (probe P3)", async () => {
    const calls = installFetch(
      authServer({
        campaignsFor: (u) =>
          u === 'A' ? [{ id: 'c1', name: 'n', type: 'modal', triggers: [{ type: 'immediate' }], content: { kind: 'native', title: 'Hi', body: 'B' } }] : [],
      }),
    );
    const handler = jest.fn();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', enableSdkAuthentication: true, sdkAuthenticationToken: 'tok-A', inApp: { enabled: true } } as any);
    sdk.setSdkAuthenticationErrorCallback(handler);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/in-app/track') && c.body.displayedAt));
    await sdk.reset();
    await settle(50);
    const dismissal = calls.find((c) => c.path.endsWith('/v1/in-app/track') && c.body.dismissedAt)!;
    expect(dismissal.body.userId).toBe('A');
    expect((dismissal.init.headers || {})['X-Joryio-Auth']).toBe('tok-A');
    expect(handler.mock.calls).toEqual([]);
  });

  it("an in-app 401 for a user who is no longer current does not reach the handler", async () => {
    const handler = jest.fn();
    const network = new NetworkClient('jry_sdk_test', new Logger(false), { maxRetries: 0, backoffMs: 1 });
    network.setSdkAuthenticationEnabled(true);
    network.setSdkAuthenticationFailureCallback(handler);
    network.setCurrentUserId('A');
    network.setSdkAuthenticationToken('tok-A');
    network.retireSdkAuthToken();
    network.setCurrentUserId(null);
    // The old user's request carries the old user's token...
    expect(network.getSdkAuthHeaders('A')).toEqual({ 'X-Joryio-Auth': 'tok-A' });
    // ...and the next visitor's never does.
    expect(network.getSdkAuthHeaders(null)).toEqual({});
  });
});

describe("D-a: a logged-out user's token is persisted with their queued items", () => {
  it("A's unsubscribe queued during an outage is delivered with A's token after logout and reload (probe P4)", async () => {
    let down = true;
    const calls = installFetch(authServer({ down: () => down }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true } as any;
    let sdk = new JoryioSDK({ ...cfg, userId: 'A', sdkAuthenticationToken: 'tok-A' });
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await settle(50);
    await sdk.reset();
    await sdk.destroy();
    resetSingleton();
    down = false;
    sdk = new JoryioSDK(cfg);
    await waitFor(() => (sdk as any).outbox.size() === 0);
    const last = calls.filter(isUnsub).pop()!;
    expect({ userId: last.body.userId, token: (last.init.headers || {})['X-Joryio-Auth'] }).toEqual({ userId: 'A', token: 'tok-A' });
  });

  it("the stored token is deleted once that user's last item settled", async () => {
    installFetch(authServer());
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, userId: 'A', sdkAuthenticationToken: 'tok-A' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await sdk.reset();
    // Kept while A still has something queued (the unsubscribe, A's last attribute write)...
    expect((sdk as any).network.retiredSdkAuthUsers()).toEqual(['A']);
    expect([...store.keys()].some((k) => k.endsWith('retired_sdk_auth_tokens'))).toBe(true);
    // ...and gone once the last of it settled - after the one-minute grace
    // period of rule 61 (round 6), which keeps it for a write queued right
    // after the logout or by another tab.
    await waitFor(() => (sdk as any).outbox.size() === 0 && (sdk as any).identity.pending.isEmpty());
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      (sdk as any).pruneRetiredTokens();
    } finally {
      Date.now = realNow;
    }
    expect((sdk as any).network.retiredSdkAuthUsers()).toEqual([]);
    expect([...store.keys()].some((k) => k.endsWith('retired_sdk_auth_tokens'))).toBe(false);
  });
});

describe("S5 / rule 53: identify('B') without reset() retires A's token", () => {
  it("A's queued unsubscribe still goes with A's token (probe P6)", async () => {
    let down = true;
    const calls = installFetch((req) => {
      if (down && req.path.endsWith('/v1/subscriptions/channel')) return { status: 503, body: {} };
      return authServer()(req);
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, userId: 'A', sdkAuthenticationToken: 'tok-A' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/subscriptions/channel')));
    sdk.identify('B');
    sdk.setSdkAuthenticationToken('tok-B');
    down = false;
    await waitFor(() => (sdk as any).outbox.inFlight === null);
    (sdk as any).outbox.entries.forEach((e: any) => (e.notBefore = 0));
    (sdk as any).outbox.kick();
    await settle(100);
    const last = calls.filter((c) => c.path.endsWith('/v1/subscriptions/channel')).pop()!;
    expect({ user: last.body.userId, token: last.init.headers['X-Joryio-Auth'], queued: (sdk as any).outbox.size() }).toEqual({ user: 'A', token: 'tok-A', queued: 0 });
  });

  it("a token the host already set for B (its sub is B) is not retired to A", async () => {
    const calls = installFetch(authServer());
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, userId: 'A', sdkAuthenticationToken: jwtFor('A') } as any);
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    sdk.identify('B');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/track/batch') && c.body.identify));
    const batch = calls.find((c) => c.path.endsWith('/v1/track/batch') && c.body.identify)!;
    expect(batch.init.headers['X-Joryio-Auth']).toBe(jwtFor('B'));
  });

  it("A's cached in-app campaigns are gone the moment B is identified (N6)", () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', inApp: { enabled: true } } as any);
    (sdk as any).inapp.campaigns.set('c-A', { id: 'c-A', name: 'A only', type: 'modal', triggers: [] });
    sdk.identify('B');
    expect(sdk.getInAppCampaigns()).toEqual([]);
  });
});

describe('S6: the unload hand-off never loses events', () => {
  function storedQueueLength(): number {
    let n = 0;
    for (const [k, v] of store) if (k.endsWith('_event_queue') || k.endsWith('_event_queue_inflight')) n += (JSON.parse(v).value || []).length;
    return n;
  }
  const keepaliveRequest = () => {
    (globalThis as any).Request = function Request() {};
    (globalThis as any).Request.prototype.keepalive = false;
  };
  afterEach(() => {
    delete (globalThis as any).Request;
  });

  it('during an outage the events stay stored for the next page view (probe P5a)', async () => {
    keepaliveRequest();
    (globalThis as any).fetch = jest.fn(async (_u: string, init: any) => {
      if (init.keepalive) throw new TypeError('Failed to fetch');
      return { ok: false, status: 503, statusText: '', headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '' };
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, persistQueue: true, trackSessionStart: false } as any);
    for (let i = 0; i < 10; i++) sdk.track('E' + i, { i });
    await sdk.flush().catch(() => undefined);
    expect(storedQueueLength()).toBe(10);
    (sdk as any).handlePageUnload();
    expect(storedQueueLength()).toBe(10);
  });

  it('offline, nothing is handed off', async () => {
    keepaliveRequest();
    const calls = installFetch();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const nav = { onLine: true, language: 'en', userAgent: 'test' };
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    try {
      const sdk = new JoryioSDK({ ...BASE_CONFIG, persistQueue: true, trackSessionStart: false, batchSize: 1000, batchFlushInterval: 60000 } as any);
      for (let i = 0; i < 5; i++) sdk.track('E' + i);
      nav.onLine = false;
      (sdk as any).handlePageUnload();
      expect(calls.filter((c) => c.init.keepalive)).toEqual([]);
      expect(storedQueueLength()).toBe(5);
      nav.onLine = true;
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as any).navigator;
    }
  });

  it('beforeunload + pagehide share ONE 64 KiB keepalive budget; nothing past it leaves storage (probe P5b)', async () => {
    keepaliveRequest();
    let inflight = 0;
    let refused = 0;
    (globalThis as any).fetch = jest.fn((_u: string, init: any) => {
      if (init.keepalive) {
        const size = String(init.body).length;
        if (inflight + size > 64 * 1024) {
          refused++;
          return Promise.reject(new TypeError('keepalive quota exceeded'));
        }
        inflight += size;
        return new Promise(() => undefined); // the page dies first
      }
      return Promise.resolve({ ok: true, status: 200, statusText: '', headers: { get: () => 'application/json' }, json: async () => ({ success: true }), text: async () => '' });
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, persistQueue: true, trackSessionStart: false, batchSize: 1000, batchFlushInterval: 60000 } as any);
    for (let i = 0; i < 150; i++) sdk.track('E' + i, { pad: 'x'.repeat(700) });
    (sdk as any).queue.persistNow();
    const before = storedQueueLength();
    (sdk as any).handlePageUnload(); // beforeunload
    const afterFirst = storedQueueLength();
    (sdk as any).handlePageUnload(); // pagehide
    await Promise.resolve();
    const afterSecond = storedQueueLength();
    expect(before).toBe(150);
    expect(afterFirst).toBeLessThan(150); // the first hand-off took what fits
    expect(afterSecond).toBe(afterFirst); // the second had no budget left: nothing removed
    expect(refused).toBe(0); // and nothing was handed to the browser past its quota
  });
});

describe('S7 / rule 49: a value JSON cannot carry never blocks other writes', () => {
  it('a circular attribute value is dropped; the other attributes go (probe P7)', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const circular: any = { a: 1 };
    circular.self = circular;
    sdk.setAttribute('profile', circular);
    sdk.setAttribute('plan', 'pro');
    sdk.setAttributes({ big: BigInt(1) as any, nan: NaN, inf: -Infinity, fn: () => 1, lang: 'en' });
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/attributes') && c.body.attributes?.lang));
    const sent = Object.assign({}, ...calls.filter((c) => c.path.endsWith('/v1/attributes')).map((c) => c.body.attributes || {}));
    expect(sent).toEqual(expect.objectContaining({ plan: 'pro', lang: 'en' }));
    for (const bad of ['profile', 'big', 'nan', 'inf', 'fn']) expect(sent).not.toHaveProperty(bad);
  });

  it('addToArray / removeFromArray with such a value are ignored', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.addToArray('tags', NaN);
    sdk.removeFromArray('tags', BigInt(2) as any);
    sdk.addToArray('tags', 'vip');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/attributes')));
    expect(calls.filter((c) => c.path.endsWith('/v1/attributes')).map((c) => c.body)).toEqual([{ append: { tags: ['vip'] } } as any].map((b) => expect.objectContaining(b)));
  });

  it('an event property of NaN / Infinity / BigInt / circular is dropped and the event is sent', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const circular: any = {};
    circular.me = circular;
    sdk.track('Viewed', { price: NaN, total: Infinity, big: BigInt(3) as any, loop: circular, ok: 1, nested: { x: NaN } });
    await sdk.flush();
    const event = calls.find((c) => c.path.endsWith('/v1/track/batch'))!.body.events[0];
    expect(event.type).toBe('Viewed');
    expect(Object.keys(event.properties).filter((k) => !k.startsWith('$'))).toEqual(['ok']);
  });

  it('a request body that cannot be serialized is refused for good (400), never retried as "offline"', async () => {
    installFetch();
    const network = new NetworkClient('jry_sdk_test', new Logger(false), { maxRetries: 2, backoffMs: 1 });
    const body: any = { a: BigInt(1) };
    const res = await network.request({ url: 'https://api.example/api/v1/attributes', body });
    expect(res).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('valueProblem names each kind', () => {
    expect(valueProblem(1)).toBeNull();
    expect(valueProblem({ a: [1, 'x', null, { b: true }] })).toBeNull();
    expect(valueProblem(new Date())).toBeNull();
    expect(valueProblem(NaN)).toMatch(/non-finite/);
    expect(valueProblem([1, Infinity])).toMatch(/non-finite/);
    expect(valueProblem(BigInt(1))).toMatch(/BigInt/);
    const c: any = [];
    c.push(c);
    expect(valueProblem(c)).toMatch(/circular/);
    const shared = { x: 1 };
    expect(valueProblem({ a: shared, b: shared })).toBeNull(); // shared, not circular
  });
});

describe('S8: another tab\'s opt-out, consent and logout apply here at once', () => {
  it('an opt-out made in another tab stops this tab from tracking', async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    // The other tab (same localStorage) opts out.
    const storage = (sdk as any).storage as StorageManager;
    storage.set('tracking_opted_out', true);
    win.fire('storage', { key: storage.storageKeyFor('tracking_opted_out') });
    sdk.track('After');
    await sdk.flush();
    expect(calls.filter((c) => c.path.endsWith('/v1/track/batch'))).toEqual([]);
    expect(sdk.isUserOptedOut()).toBe(true);
  });

  it('a denial made in another tab stops this tab; a grant there lifts it', async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const storage = (sdk as any).storage as StorageManager;
    storage.set('tracking_consent', 'denied');
    win.fire('storage', { key: storage.storageKeyFor('tracking_consent') });
    expect(sdk.getTrackingConsent()).toBe('denied');
    sdk.track('Denied');
    storage.remove('tracking_consent');
    win.fire('storage', { key: storage.storageKeyFor('tracking_consent') });
    expect(sdk.getTrackingConsent()).toBe('granted');
    sdk.track('Granted');
    await sdk.flush();
    const types = calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events.map((e: any) => e.type));
    expect(types).toEqual(['Granted']);
  });

  it('a logout in another tab is followed here: no event goes out as the logged-out user', async () => {
    const win = installWindow();
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any);
    const storage = (sdk as any).storage as StorageManager;
    storage.remove('user_id');
    storage.set('anonymous_id', 'anon-from-other-tab');
    win.fire('storage', { key: storage.storageKeyFor('user_id') });
    sdk.track('Next');
    await sdk.flush();
    const event = calls.find((c) => c.path.endsWith('/v1/track/batch'))!.body.events[0];
    expect({ userId: event.userId, anonymousId: event.anonymousId }).toEqual({ userId: null, anonymousId: 'anon-from-other-tab' });
  });
});

describe('rule 57: in-app HTML may only load its own document', () => {
  beforeEach(() => {
    installFakeDocument();
    Object.assign((globalThis as any).document, { addEventListener() {}, removeEventListener() {}, readyState: 'complete', title: '', referrer: '' });
    installWindow({ innerWidth: 1024 });
  });
  afterEach(() => uninstallFakeDocument());

  it('author CSS cannot close <style>', () => {
    expect(escapeStyleText('a{}</style><meta http-equiv="refresh" content="0;url=https://evil.test">')).toBe(
      'a{}<\\/style><meta http-equiv="refresh" content="0;url=https://evil.test">',
    );
    expect(escapeStyleText('</STYLE>')).not.toMatch(/<\/STYLE/i);
  });

  it('the frame is sandboxed without top navigation, its CSS is escaped, and a second load closes the message', async () => {
    const iframes: any[] = [];
    const doc = (globalThis as any).document;
    const create = doc.createElement;
    doc.createElement = (tag: string) => {
      const el = create(tag);
      if (tag === 'iframe') {
        el.attrs = {};
        el.setAttribute = (k: string, v: string) => (el.attrs[k] = v);
        iframes.push(el);
      }
      return el;
    };
    const calls = installFetch((req) => {
      if (req.path.endsWith('/v1/in-app/sync')) {
        return {
          status: 200,
          body: {
            success: true,
            campaigns: [{
              id: 'h1', name: 'html', type: 'modal', triggers: [{ type: 'immediate' }],
              content: { kind: 'html', html: '<p>Hi</p>', css: 'p{}</style><meta http-equiv="refresh" content="0;url=https://evil.test">' },
            }],
          },
        };
      }
      return { status: 200, body: { success: true } };
    });
    new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, inApp: { enabled: true, allowHtmlJsInAppMessages: true } } as any);
    await waitFor(() => iframes.length === 1 && calls.some((c) => c.path.endsWith('/v1/in-app/track') && c.body.displayedAt));
    const frame = iframes[0];
    expect(frame.attrs.sandbox).toBe('allow-scripts allow-same-origin allow-popups');
    expect(frame.srcdoc).not.toContain('</style><meta');
    expect(frame.srcdoc).toContain('p{}<\\/style><meta');
    frame.on_load(); // its own document
    await settle(10);
    expect(calls.some((c) => c.path.endsWith('/v1/in-app/track') && c.body.dismissedAt)).toBe(false);
    frame.on_load(); // it navigated away
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/in-app/track') && c.body.dismissedAt));
  });
});

describe('rules 54, 55, 58, 60', () => {
  it('55: event timestamps are ISO 8601 UTC with milliseconds', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.track('Clock');
    await sdk.flush();
    const ts = calls.find((c) => c.path.endsWith('/v1/track/batch'))!.body.events[0].timestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('58: enableDebug alone logs at debug; an explicit logLevel wins', () => {
    expect(resolveConfig({ sdkKey: 'jry_sdk_web_x', enableDebug: true } as any).logLevel).toBe('debug');
    expect(resolveConfig({ sdkKey: 'jry_sdk_web_x', enableDebug: true, logLevel: 'warn' } as any).logLevel).toBe('warn');
    expect(resolveConfig({ sdkKey: 'jry_sdk_web_x' } as any).logLevel).toBe('error');
  });

  it('54: reading the session id never starts a session', () => {
    const storage = new StorageManager('jry_sdk_web_x', new Logger(false));
    const session = new SessionManager(storage, new Logger(false));
    const started = jest.fn();
    session.onNewSession(started);
    session.clear();
    expect(session.getSessionId()).toBe('');
    expect(session.getSessionInfo().sessionId).toBe('');
    expect(session.getSessionId()).toBe('');
    expect(started).not.toHaveBeenCalled();
    // The lifecycle path starts one - and announces it.
    const id = session.ensureSession();
    expect(id).not.toBe('');
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('54: after wipeData() the next event starts a session with exactly one Session Start', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG } as any);
    await sdk.flush();
    calls.length = 0;
    (sdk as any).session.clear();
    (sdk as any).storage.remove('session_start_sent');
    sdk.track('First');
    await sdk.flush();
    const types = calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events.map((e: any) => e.type));
    expect(types).toEqual(['Session Start', 'First']);
  });

  it('60: a mobile app key is refused on the web; web and store keys work', async () => {
    const calls = installFetch();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const key of ['jry_sdk_ios_abc', 'jry_sdk_android_abc']) {
      const inert = new JoryioSDK({ ...BASE_CONFIG, sdkKey: key, trackSessionStart: false } as any);
      inert.track('X');
      await inert.flush();
    }
    expect(calls).toEqual([]);
    expect(errors.mock.calls.join(' ')).toMatch(/mobile app key/);
    errors.mockRestore();
    const store = new JoryioSDK({ ...BASE_CONFIG, sdkKey: 'jry_sdk_shopify_abc', trackSessionStart: false } as any);
    store.track('Y');
    await store.flush();
    expect(calls.some((c) => c.path.endsWith('/v1/track/batch'))).toBe(true);
  });
});

describe('rule 51 / N1, N2: the pre-init queue', () => {
  function runSnippet() {
    const win: any = {};
    const src = fs.readFileSync(path.join(__dirname, '..', 'snippet', 'loader.js'), 'utf8');
    vm.runInNewContext(src, {
      window: win,
      document: { createElement: () => ({}), getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }] },
      console,
    });
    return win;
  }

  it('the stub cap never drops a privacy decision, however many calls follow', () => {
    const win = runSnippet();
    win.joryio.optOut();
    win.joryio.updateConsent('denied');
    for (let i = 0; i < 1500; i++) win.joryio.track('E' + i);
    const methods = win.joryio.map((c: any[]) => c[0]);
    expect(methods.length).toBe(1000);
    expect(methods.slice(0, 2)).toEqual(['optOut', 'updateConsent']);
  });

  it('a getter called before load returns undefined, not the (truthy) queue', () => {
    const win = runSnippet();
    expect(win.joryio.isUserOptedOut()).toBeUndefined();
    expect(win.joryio.getUserId()).toBeUndefined();
    expect(win.joryio.track('x')).toBe(win.joryio);
  });

  it('the loaded bundle waiting for a late init keeps privacy decisions too', () => {
    installFetch();
    const queue: any[] = [];
    const win: any = { joryio: queue };
    installSnippetQueue(win);
    win.joryio.push(['optOut']);
    for (let i = 0; i < 1200; i++) win.joryio.push(['track', 'E' + i]);
    expect(queue.length).toBe(1000);
    expect(queue[0]).toEqual(['optOut']);
  });
});

describe('NICE fixes', () => {
  it('N5: a failed localStorage write removes the stale stored value', () => {
    const storage = new StorageManager('jry_sdk_web_x', new Logger(false));
    storage.set('k', 'old');
    const ls = (globalThis as any).localStorage;
    const setItem = ls.setItem;
    ls.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    storage.set('k', 'new');
    ls.setItem = setItem;
    expect(storage.get('k')).toBe('new');
  });

  it("N7: coming back online sends attributes waiting out their backoff", async () => {
    const win = installWindow();
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.setAttribute('plan', 'pro');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/attributes')));
    await waitFor(() => !(sdk as any).attributeFlushInFlight);
    down = false;
    const before = calls.length;
    win.fire('online');
    await waitFor(() => calls.slice(before).some((c) => c.path.endsWith('/v1/attributes')), 2000);
  });

  it('N9: push_permission is reported right after push.subscribe() settles', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/attributes')));
    const before = calls.length;
    jest.spyOn((sdk as any)._push, 'getPermissionState').mockReturnValue('granted');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sdk.push.subscribe();
    await waitFor(() => calls.slice(before).some((c) => c.path.endsWith('/v1/attributes') && c.body.attributes?.push_permission === 'granted'));
  });
});

describe('v5 51 (integration): a stored outbox over the bound keeps its withdrawals', () => {
  it('loading more than 200 stored writes drops the oldest non-withdrawal, never the unsubscribe', async () => {
    // Fails before: load() kept only the newest 200 (slice(-200)), so the
    // oldest entry - here the unsubscribe - was dropped unread when another
    // tab had stored more than the bound.
    installFetch(() => ({ status: 503, body: {} }));
    const first = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    first.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await settle(50);
    (first as any).outbox.destroy();
    const key = [...store.keys()].find((k) => k.endsWith('write_outbox'))!;
    const saved = JSON.parse(store.get(key)!);
    const unsubscribe = saved.value[0];
    const anonymousId = unsubscribe.record.payload.anonymousId;
    const aliases = Array.from({ length: 250 }, (_, i) => ({
      id: `a${i}`,
      record: { kind: 'alias', payload: { anonymousId, aliasLabel: 'crm', aliasName: `C-${i}` } },
      attempts: 0,
    }));
    store.set(key, JSON.stringify({ ...saved, value: [unsubscribe, ...aliases] }));
    resetSingleton();

    const calls = installFetch(() => ({ status: 503, body: {} }));
    const second = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const entries = (second as any).outbox.entries as any[];
    expect(entries).toHaveLength(200);
    expect(entries.some((e) => e.withdrawal && e.record.payload.channel === 'email')).toBe(true);
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/subscriptions/channel') && c.body?.status === 'unsubscribed'));
  });
});
