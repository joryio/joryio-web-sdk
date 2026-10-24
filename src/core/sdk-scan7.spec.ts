import * as fs from 'fs';
import * as path from 'path';
import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { NetworkClient, jwtSubject, SDK_AUTH_HEADER } from './network';
import { StorageManager } from './storage';
import { installSnippetQueue } from '../index';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor, RecordedRequest } from './test-harness';

/**
 * Scan 7 (web) - the probes from that scan lifted as regression tests, plus
 * the round-7 contract rules 72-78 as they apply to the web SDK.
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
  jest.restoreAllMocks();
});

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

/** Open another "tab": a new SDK instance on the same localStorage, with its own window. */
function openTab(config: any) {
  resetSingleton();
  const win = installWindow();
  const sdk = new JoryioSDK(config);
  return { sdk, win };
}

/** Run `act` and deliver a storage event to `win` for every key it changed (in key order). */
function relay(win: { fire: (t: string, e?: any) => void }, act: () => void, keyFirst?: (k: string) => number): string[] {
  const before = new Map(store);
  act();
  let changed = Array.from(new Set([...store.keys(), ...before.keys()])).filter((k) => store.get(k) !== before.get(k));
  if (keyFirst) changed = changed.sort((a, b) => keyFirst(a) - keyFirst(b));
  for (const key of changed) win.fire('storage', { key });
  return changed;
}

/**
 * Run `act`, then replay its localStorage writes one by one into the shared
 * store, delivering each write's storage event to `win` right after it - the
 * way a browser that applies another tab's changes key by key would.
 */
function relayKeyByKey(win: { fire: (t: string, e?: any) => void }, act: () => void): void {
  const ls: any = (globalThis as any).localStorage;
  const ops: [string, string, string | null][] = [];
  const set = ls.setItem;
  const remove = ls.removeItem;
  const before = new Map(store);
  ls.setItem = (k: string, v: string) => {
    ops.push(['set', k, String(v)]);
    set(k, v);
  };
  ls.removeItem = (k: string) => {
    ops.push(['remove', k, null]);
    remove(k);
  };
  try {
    act();
  } finally {
    ls.setItem = set;
    ls.removeItem = remove;
  }
  const after = new Map(store);
  store.clear();
  before.forEach((v, k) => store.set(k, v));
  for (const [op, key, value] of ops) {
    if (op === 'set') store.set(key, value!);
    else store.delete(key);
    win.fire('storage', { key });
  }
  // Whatever the replay did not reproduce (nothing, normally).
  after.forEach((v, k) => store.set(k, v));
}

const jwtFor = (sub: string, claims: Record<string, unknown> = {}) =>
  `h.${Buffer.from(JSON.stringify({ sub, ...claims })).toString('base64').replace(/=+$/, '')}.s`;
const tokenOf = (req: RecordedRequest) => (req.init?.headers || {})[SDK_AUTH_HEADER];
const subs = (calls: RecordedRequest[]) => calls.filter((c) => c.path.endsWith('/v1/subscriptions/channel'));
const batchEvents = (calls: RecordedRequest[]) => calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events);
const markers = (calls: RecordedRequest[]) =>
  calls.filter((c) => c.path.endsWith('/v1/attributes') && c.body?.attributes && 'tracking_opted_out' in c.body.attributes);

describe('S2 / rule 77: a write another tab settled or replaced is never sent', () => {
  it('P1: tab A older subscribe (backoff) does not land after tab B newer unsubscribe (B opened after)', async () => {
    let aDown = true;
    const calls = installFetch((req) => (aDown && req.body?.status === 'subscribed' ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any;
    const { sdk: tabA } = openTab(cfg);
    tabA.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    await settle(30);
    const { sdk: tabB } = openTab(cfg);
    tabB.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).some((c) => c.body.status === 'unsubscribed'));
    await settle(50);
    aDown = false;
    const ent = (tabA as any).outbox.entries[0];
    if (ent) ent.notBefore = 0;
    (tabA as any).outbox.kick();
    await settle(300);
    expect(subs(calls).map((c) => c.body.status)).toEqual(['subscribed', 'unsubscribed']);
    expect((tabA as any).outbox.size()).toBe(0);
    await tabB.destroy();
    await tabA.destroy();
  }, 20000);

  it('P1b: the same when tab B was opened BEFORE tab A queued its subscribe', async () => {
    let aDown = true;
    const calls = installFetch((req) => (aDown && req.body?.status === 'subscribed' ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any;
    const { sdk: tabB } = openTab(cfg);
    const { sdk: tabA } = openTab(cfg);
    tabA.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    await settle(30);
    tabB.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).some((c) => c.body.status === 'unsubscribed'));
    await settle(50);
    aDown = false;
    const ent = (tabA as any).outbox.entries[0];
    if (ent) ent.notBefore = 0;
    (tabA as any).outbox.kick();
    await settle(300);
    expect(subs(calls).map((c) => c.body.status)).toEqual(['subscribed', 'unsubscribed']);
    await tabA.destroy();
    await tabB.destroy();
  }, 20000);

  it('two tabs that loaded one stored write send it once: the second sees it settled', async () => {
    // An earlier page view left an unsubscribe waiting.
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any;
    const { sdk: first } = openTab(cfg);
    first.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    await first.destroy();
    // Two tabs open and both load it. Tab B's first attempt fails...
    const { sdk: tabB } = openTab(cfg);
    await settle(50);
    (tabB as any).outbox.entries[0].notBefore = Date.now() + 60_000;
    // ...and tab A delivers it.
    down = false;
    const { sdk: tabA } = openTab(cfg);
    await waitFor(() => (tabA as any).outbox.size() === 0);
    const sent = subs(calls).length;
    expect(subs(calls)[sent - 1].body.status).toBe('unsubscribed');
    // Tab B's own attempt comes later: it must not resend.
    (tabB as any).outbox.entries[0].notBefore = 0;
    (tabB as any).outbox.kick();
    await settle(200);
    expect(subs(calls).length).toBe(sent);
    expect((tabB as any).outbox.size()).toBe(0);
    await tabA.destroy();
    await tabB.destroy();
  }, 20000);
});

describe('S3 / rule 77: the storage listener follows withdrawal_user_id', () => {
  it("P3: tab A keeps B for withdrawals (denied); tab B's unsubscribe goes to B, not A", async () => {
    const calls = installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A', trackingConsent: 'denied' } as any;
    const { sdk: tabB, win: winB } = openTab(cfg);
    const { sdk: tabA } = openTab({ ...cfg, userId: undefined });
    relay(winB, () => tabA.identify('B'));
    tabB.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    expect(subs(calls)[0].body.userId).toBe('B');
    await tabA.destroy();
    await tabB.destroy();
  }, 20000);

  it("the held user's withdrawal carries the held user's retired token (rule 72)", async () => {
    const calls = installFetch();
    const cfg = {
      ...BASE_CONFIG,
      trackSessionStart: false,
      userId: 'B',
      enableSdkAuthentication: true,
      sdkAuthenticationToken: jwtFor('B'),
    } as any;
    const { sdk: tabB } = openTab(cfg);
    // Tab A: B logged out with a queued item kept B's token; the visitor is denied and identifies as B again.
    tabB.updateConsent('denied');
    tabB.identify('C');
    tabB.identify('B');
    tabB.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    const req = subs(calls)[0];
    expect(req.body.userId).toBe('B');
    expect(jwtSubject(tokenOf(req))).toBe('B');
  }, 20000);
});

describe('N1 / rule 77: clear() then an explicit grant or opt-in in one tab is not undone by another', () => {
  it('P2: consent - both tabs end granted', async () => {
    installFetch();
    const cfgD = { ...BASE_CONFIG, trackSessionStart: false } as any;
    const { sdk: tabB, win: winB } = openTab({ ...cfgD, trackingConsent: 'denied' });
    const { sdk: tabC, win: winC } = openTab(cfgD);
    expect(tabC.getTrackingConsent()).toBe('denied');
    store.clear();
    const before = new Map(store);
    tabC.updateConsent('granted');
    const changedByC = Array.from(store.keys()).filter((k) => store.get(k) !== before.get(k));
    winB.fire('storage', { key: null });
    for (const key of changedByC) winB.fire('storage', { key });
    const changedByB = Array.from(store.keys()).filter((k) => store.get(k) !== before.get(k) && !changedByC.includes(k));
    expect(changedByB.length).toBeGreaterThan(0); // tab B did store its denial again
    for (const key of changedByB) winC.fire('storage', { key });
    expect(tabC.getTrackingConsent()).toBe('granted');
    expect(tabB.getTrackingConsent()).toBe('granted');
    // And the next page view: granted.
    await tabB.destroy();
    await tabC.destroy();
    const { sdk: next } = openTab(cfgD);
    expect(next.getTrackingConsent()).toBe('granted');
  });

  it('opt-out - optIn() right after the clear wins in both tabs and on the next page view', async () => {
    installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: false } as any;
    const { sdk: tabB, win: winB } = openTab({ ...cfg, optOut: true });
    const { sdk: tabC, win: winC } = openTab(cfg);
    expect(tabC.isUserOptedOut()).toBe(true);
    store.clear();
    const before = new Map(store);
    tabC.optIn();
    const changedByC = Array.from(store.keys()).filter((k) => store.get(k) !== before.get(k));
    winB.fire('storage', { key: null });
    for (const key of changedByC) winB.fire('storage', { key });
    const changedByB = Array.from(store.keys()).filter((k) => store.get(k) !== before.get(k) && !changedByC.includes(k));
    for (const key of changedByB) winC.fire('storage', { key });
    expect(tabC.isUserOptedOut()).toBe(false);
    expect(tabB.isUserOptedOut()).toBe(false);
    await tabB.destroy();
    await tabC.destroy();
    const { sdk: next } = openTab(cfg);
    expect(next.isUserOptedOut()).toBe(false);
  });

  it('a clear with NO later decision still keeps the denial and the opt-out (rule 62 unchanged)', async () => {
    installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: false } as any;
    const { sdk: tabB, win: winB } = openTab({ ...cfg, trackingConsent: 'denied', optOut: true });
    store.clear();
    winB.fire('storage', { key: null });
    await tabB.destroy();
    const { sdk: next } = openTab(cfg);
    expect(next.getTrackingConsent()).toBe('denied');
    expect(next.isUserOptedOut()).toBe(true);
  });

  it('a denial made AFTER a grant still wins', async () => {
    installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: false } as any;
    const { sdk: tab } = openTab(cfg);
    tab.updateConsent('granted');
    tab.updateConsent('denied');
    await tab.destroy();
    const { sdk: next } = openTab(cfg);
    expect(next.getTrackingConsent()).toBe('denied');
  });
});

describe('N2 / rule 77: the retired-token merge keeps the NEWER token per user', () => {
  it("a tab following a logout does not replace the other tab's fresher token with its older one", () => {
    const box: { v: Record<string, unknown> | null } = { v: null };
    const storeOf = () => ({ load: () => box.v, update: (m: (s: Record<string, unknown>) => Record<string, unknown>) => (box.v = m(box.v || {})) });
    const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
    const mk = () => {
      const c = new NetworkClient('jry_sdk_test', logger, { maxRetries: 0, backoffMs: 0 });
      c.setRetiredTokenStore(storeOf());
      c.setSdkAuthenticationEnabled(true);
      c.setCurrentUserId('A');
      return c;
    };
    const old = jwtFor('A', { iat: 100, exp: 1000 });
    const fresh = jwtFor('A', { iat: 900, exp: 1900 });
    const tabB = mk();
    tabB.setSdkAuthenticationToken(old); // loaded with A's first token
    const tabA = mk();
    tabA.setSdkAuthenticationToken(fresh); // refreshed since
    let now = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    tabA.retireSdkAuthToken(); // tab A logs out
    now += 1000;
    tabB.switchUser(null); // tab B follows, later
    expect((box.v as any).A.token).toBe(fresh);
    // ...and tab B itself now attaches the fresh one to A's leftovers.
    expect(tabB.getSdkAuthHeaders('A')[SDK_AUTH_HEADER]).toBe(fresh);
  });
});

describe('N3: the merged outbox bound drops the oldest non-withdrawal, whichever tab made it', () => {
  it("a closed tab's newer write is kept over this tab's older one", async () => {
    installFetch(() => ({ status: 503, body: {} }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A', batchFlushInterval: 600000 } as any;
    const { sdk } = openTab(cfg);
    (sdk as any).outbox.destroy(); // nothing sent: just bookkeeping
    const ob = (sdk as any).outbox;
    ob.destroyed = false;
    ob.stopped = true;
    sdk.addAlias('crm', 'mine'); // the oldest write overall
    const mine = ob.entries[0];
    mine.createdAt = 1;
    ob.persistNow();
    // A tab that has since closed stored 200 newer aliases.
    const stored = JSON.parse(store.get(Array.from(store.keys()).find((k) => k.endsWith('write_outbox'))!)!);
    const raw = stored.value[0];
    const theirs = Array.from({ length: 200 }, (_, i) => ({ ...raw, id: `closed-${i}`, createdAt: 1000 + i, record: { ...raw.record, payload: { ...raw.record.payload, aliasName: `c${i}` } } }));
    const key = Array.from(store.keys()).find((k) => k.endsWith('write_outbox'))!;
    store.set(key, JSON.stringify({ ...stored, value: [...stored.value, ...theirs] }));
    ob.persistNow();
    const after = JSON.parse(store.get(key)!).value;
    expect(after.length).toBe(200);
    expect(after.some((e: any) => e.id === mine.id)).toBe(false);
    expect(after.some((e: any) => e.id === 'closed-0')).toBe(true);
  });
});

describe("N6: wipeData() in one tab discards every tab's non-withdrawals", () => {
  it("tab B's waiting subscribe is not sent after tab A's wipe; withdrawals still are", async () => {
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any;
    const { sdk: tabB, win: winB } = openTab(cfg);
    tabB.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    tabB.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).length >= 1);
    await settle(50);
    const { sdk: tabA } = openTab(cfg);
    (tabA as any).outbox.stopped = true; // tab A only wipes
    relay(winB, () => {
      void tabA.wipeData();
    });
    await settle(20);
    down = false;
    const sentBefore = subs(calls).length;
    for (const e of (tabB as any).outbox.entries) e.notBefore = 0;
    (tabB as any).outbox.kick();
    await settle(400);
    const after = subs(calls).slice(sentBefore);
    expect(after.some((c) => c.body.status === 'subscribed')).toBe(false);
    expect(after.some((c) => c.body.channel === 'sms' && c.body.status === 'unsubscribed')).toBe(true);
    await tabA.destroy();
    await tabB.destroy();
  }, 20000);
});

describe('N4: following another tab\'s logout adopts the session it stores AFTER the new anonymous id', () => {
  it('session_id stored after anonymous_id (key-by-key dispatch): this tab ends on the new session', async () => {
    installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any;
    const { sdk: tabB, win: winB } = openTab(cfg);
    const { sdk: tabA } = openTab(cfg);
    const oldSession = tabB.getSessionInfo().sessionId;
    // reset() writes the new anonymous id, then the new session: tab B
    // hears (and sees) them one at a time.
    relayKeyByKey(winB, () => void tabA.reset());
    await settle(20);
    expect(tabA.getSessionInfo().sessionId).not.toBe(oldSession);
    expect(tabB.getAnonymousId()).toBe(tabA.getAnonymousId());
    expect(tabB.getSessionInfo().sessionId).toBe(tabA.getSessionInfo().sessionId);
    await tabA.destroy();
    await tabB.destroy();
  });
});

describe('rule 72: a request carries only a token whose sub is its user', () => {
  it("setToken(B) before identify('B') when A had no token: A's events carry no token, B's carry B's", async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', enableSdkAuthentication: true, batchFlushInterval: 600000 } as any);
    sdk.track('As event');
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    await sdk.flush();
    sdk.identify('B');
    sdk.track('Bs event');
    await sdk.flush();
    await settle(20);
    const batches = calls.filter((c) => c.path.endsWith('/v1/track/batch'));
    const aBatch = batches.find((c) => c.body.events.some((e: any) => e.type === 'As event'))!;
    expect(aBatch.body.events.every((e: any) => e.userId === 'A')).toBe(true);
    expect(tokenOf(aBatch)).toBeUndefined();
    const bBatch = batches.find((c) => c.body.events.some((e: any) => e.type === 'Bs event'))!;
    expect(jwtSubject(tokenOf(bBatch))).toBe('B');
  });

  it("setToken(B) -> reset() -> identify('B'): B's requests keep B's token, even after the retired copy is pruned", async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', enableSdkAuthentication: true, batchFlushInterval: 600000 } as any);
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    await sdk.reset();
    sdk.identify('B');
    await sdk.flush();
    // Nothing of B is queued any more: the retired copy goes.
    (sdk as any).network.forgetRetiredSdkAuthTokensExcept(new Set(), Date.now() + 120_000);
    sdk.track('Later');
    await sdk.flush();
    await settle(20);
    const later = calls.filter((c) => c.path.endsWith('/v1/track/batch')).find((c) => c.body.events.some((e: any) => e.type === 'Later'))!;
    expect(later.body.events[0].userId).toBe('B');
    expect(jwtSubject(tokenOf(later))).toBe('B');
  });

  it('an anonymous request carries no token (the server checks none, and none names this visitor)', () => {
    const c = new NetworkClient('jry_sdk_test', { error() {}, warn() {}, info() {}, debug() {} } as any, { maxRetries: 0, backoffMs: 0 });
    c.setSdkAuthenticationEnabled(true);
    c.setSdkAuthenticationToken(jwtFor('B'));
    expect(c.getSdkAuthHeaders(null)).toEqual({});
    expect(c.getSdkAuthHeaders()).toEqual({});
    c.setCurrentUserId('A');
    expect(c.getSdkAuthHeaders('A')).toEqual({});
    expect(c.getSdkAuthHeaders('B')[SDK_AUTH_HEADER]).toBe(jwtFor('B'));
  });
});

describe('rule 74: the opt-out marker keeps the identity it was made for', () => {
  it("a logged-out user's queued marker is sent with that user's ids after reset() and a re-sync", async () => {
    let down = true;
    const calls = installFetch(() => (down ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A' } as any);
    const anonA = sdk.getAnonymousId();
    sdk.optOut();
    await waitFor(() => markers(calls).length > 0);
    await sdk.reset();
    (sdk as any).syncOptOutMarker();
    down = false;
    for (const e of (sdk as any).outbox.entries) e.notBefore = 0;
    (sdk as any).outbox.kick();
    await waitFor(() => markers(calls).filter((c) => c.init && !down).length >= 2, 5000).catch(() => undefined);
    await settle(200);
    const delivered = markers(calls).slice(1);
    const forA = delivered.find((c) => c.body.userId === 'A');
    expect(forA).toBeDefined();
    expect(forA!.body.attributes.tracking_opted_out).toBe(true);
    // Never re-addressed to the next visitor.
    expect(delivered.filter((c) => c.body.userId === 'A').length).toBeGreaterThanOrEqual(1);
    expect(delivered.every((c) => c.body.userId === 'A' || c.body.anonymousId !== anonA)).toBe(true);
  }, 20000);

  it('the marker goes after a 402 on other writes, and waits out a server Retry-After even on an online kick', async () => {
    let markerAnswers = 0;
    const calls = installFetch((req) => {
      if (req.path.endsWith('/v1/attributes') && req.body?.attributes?.tracking_opted_out === true) {
        markerAnswers++;
        return markerAnswers === 1 ? { status: 429, body: {}, headers: { 'retry-after': '30' } } : { status: 200, body: { success: true } };
      }
      return { status: 402, body: { code: 'SDK_INGESTION_SUSPENDED' } };
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', batchFlushInterval: 600000 } as any);
    sdk.addAlias('crm', 'x');
    await waitFor(() => calls.some((c) => c.path.endsWith('/v1/alias/add')));
    await settle(30);
    expect((sdk as any).network.isSuspended()).toBe(true);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    sdk.optOut();
    await waitFor(() => markers(calls).length === 1);
    await settle(30);
    // Back online: the SDK's own backoff may be skipped, never the server's Retry-After.
    (sdk as any).boundHandleOnline?.();
    (sdk as any).outbox.kick();
    await settle(200);
    expect(markers(calls).length).toBe(1);
    const entry = (sdk as any).outbox.entries.find((e: any) => e.record.kind === 'marker');
    expect(entry.notBefore - Date.now()).toBeGreaterThan(20_000);
  }, 20000);
});

describe('rule 75: Session Start after a wipe survives a reload', () => {
  it("wipe while denied, reload with trackingConsent: 'granted': the post-wipe session gets its Session Start", async () => {
    const calls = installFetch();
    const cfg = { ...BASE_CONFIG, trackSessionStart: true, persistQueue: true, batchFlushInterval: 600000 } as any;
    const first = new JoryioSDK({ ...cfg, trackingConsent: 'denied' });
    await first.wipeData();
    const session = first.getSessionInfo().sessionId;
    await first.destroy();
    resetSingleton();
    const second = new JoryioSDK({ ...cfg, trackingConsent: 'granted' });
    expect(second.getSessionInfo().sessionId).toBe(session); // resumed, not new
    await second.flush();
    await settle(20);
    const starts = batchEvents(calls).filter((e: any) => e.type === 'Session Start');
    expect(starts.length).toBe(1);
    expect(starts[0].sessionId).toBe(session);
  });
});

describe('rule 73: snippet - data calls made while opted out or denied are dropped, not replayed after a later yes', () => {
  const run = (queue: any[]) => {
    const win: any = { joryio: queue };
    installSnippetQueue(win);
    return win.joryio as JoryioSDK;
  };
  const init = ['init', { ...BASE_CONFIG, trackSessionStart: false, batchFlushInterval: 600000 }];

  it('optOut(); track(x); optIn(); init -> x never sent; a track after optIn is', async () => {
    const calls = installFetch();
    const sdk = run([['optOut'], ['track', 'x'], ['setAttribute', 'k', 1], ['optIn'], ['track', 'after'], init]);
    await sdk.flush();
    await settle(50);
    const types = batchEvents(calls).map((e: any) => e.type);
    expect(types).not.toContain('x');
    expect(types).toContain('after');
    expect(calls.some((c) => c.path.endsWith('/v1/attributes') && c.body?.attributes?.k !== undefined)).toBe(false);
  });

  it("updateConsent('denied'); track(x); updateConsent('granted') -> x never sent", async () => {
    const calls = installFetch();
    const sdk = run([init, ['updateConsent', 'denied'], ['track', 'x'], ['updateConsent', 'granted'], ['track', 'y']]);
    await sdk.flush();
    await settle(50);
    const types = batchEvents(calls).map((e: any) => e.type);
    expect(types).not.toContain('x');
    expect(types).toContain('y');
  });

  it('a stored opt-out counts: track(x); optIn() before load -> x never sent', async () => {
    const calls = installFetch();
    const s = new StorageManager('jry_sdk_test', { error() {}, warn() {}, info() {}, debug() {} } as any);
    s.set('tracking_opted_out', true);
    const sdk = run([['track', 'x'], ['optIn'], init]);
    await sdk.flush();
    await settle(50);
    expect(batchEvents(calls).map((e: any) => e.type)).not.toContain('x');
  });

  it('withdrawals and identify made while opted out are kept (D-b)', async () => {
    const calls = installFetch();
    const sdk = run([['optOut'], ['identify', 'U'], ['ready', (x: JoryioSDK) => x.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED)], init]);
    await waitFor(() => subs(calls).length > 0);
    expect(subs(calls)[0].body.userId).toBe('U');
    void sdk;
  });
});

describe('rule 78: one file for import and require in bundlers', () => {
  it('exports["."] lists a "module" condition first, pointing at the ESM build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const dot = pkg.exports['.'];
    expect(Object.keys(dot)[0]).toBe('module');
    expect(dot.module.default).toBe('./dist/joryio.mjs');
    expect(dot.import.default).toBe('./dist/joryio.mjs');
    expect(dot.require.default).toBe('./dist/joryio.cjs.js');
  });
});
