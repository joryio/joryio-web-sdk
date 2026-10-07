import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { NetworkClient, SDK_AUTH_HEADER } from './network';
import { installSnippetQueue } from '../index';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor } from './test-harness';

/**
 * Scan 8 (web), contract v8 rules 82, 83, 85 and rule 72 on every route.
 * The scan's probes (scan8-web/probes/p1.spec.ts) lifted as regression tests.
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
  delete (globalThis as any).Request;
  jest.restoreAllMocks();
});

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
function openTab(config: any) {
  resetSingleton();
  const win = installWindow();
  const sdk = new JoryioSDK(config);
  return { sdk, win };
}
const supportKeepalive = () => {
  (globalThis as any).Request = function () {};
  (globalThis as any).Request.prototype.keepalive = true;
};
const subs = (calls: any[]) => calls.filter((c) => c.path.endsWith('/v1/subscriptions/channel'));
const batchEvents = (calls: any[]) => calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events);
const jwtFor = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64').replace(/=+$/, '')}.s`;

describe('rule 85 / S1: page unload never hands off a write another tab settled or replaced', () => {
  async function twoTabsSubscribeThenUnsubscribe() {
    supportKeepalive();
    let aDown = true;
    const calls = installFetch((req) =>
      aDown && req.body?.status === 'subscribed' ? { status: 503, body: {} } : { status: 200, body: { success: true } },
    );
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, userId: 'A' } as any;
    const { sdk: tabA, win: winA } = openTab(cfg);
    tabA.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    await settle(30);
    const { sdk: tabB } = openTab(cfg);
    tabB.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).some((c) => c.body.status === 'unsubscribed'));
    await settle(50);
    aDown = false;
    return { calls, tabA, winA, tabB };
  }

  it('tab A closing does not land its older subscribe (in backoff) after tab B delivered the newer unsubscribe', async () => {
    const { calls, tabA, winA, tabB } = await twoTabsSubscribeThenUnsubscribe();
    winA.fire('pagehide');
    await settle(50);
    expect(subs(calls).map((c) => c.body.status)).toEqual(['subscribed', 'unsubscribed']);
    expect(subs(calls).some((c) => c.init.keepalive)).toBe(false);
    await tabB.destroy();
    await tabA.destroy();
  }, 20000);

  it('a write no other tab touched is still handed to keepalive at unload (control)', async () => {
    supportKeepalive();
    let down = true;
    const calls = installFetch((req) =>
      down && req.body?.status === 'subscribed' ? { status: 503, body: {} } : { status: 200, body: { success: true } },
    );
    const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, userId: 'A' } as any;
    const { sdk: tab, win } = openTab(cfg);
    tab.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    await settle(30);
    down = false;
    win.fire('pagehide');
    await settle(50);
    const last = subs(calls)[subs(calls).length - 1];
    expect(subs(calls)).toHaveLength(2);
    expect(last.body.status).toBe('subscribed');
    expect(last.init.keepalive).toBe(true);
    await tab.destroy();
  }, 20000);
});

describe('rule 85 / S2: a Session Start dropped by a denial or opt-out is sent on the next allowed page', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: true, trackPageViews: false, persistQueue: true, batchFlushInterval: 600000 } as any;
  const starts = (calls: any[]) => batchEvents(calls).filter((e: any) => e.type === 'Session Start');

  it('denied, then trackingConsent granted at init on the next page view: one Session Start for the resumed session', async () => {
    const calls = installFetch();
    const first = new JoryioSDK({ ...cfg, trackingConsent: 'pending' });
    const session = first.getSessionInfo().sessionId;
    first.updateConsent('denied');
    await first.destroy();
    resetSingleton();
    const second = new JoryioSDK({ ...cfg, trackingConsent: 'granted' });
    expect(second.getSessionInfo().sessionId).toBe(session);
    await second.flush();
    await settle(20);
    expect(starts(calls)).toHaveLength(1);
    expect(starts(calls)[0].sessionId).toBe(session);
  });

  it('opted out, then a queued pre-init optIn() on the next page view (snippet): one Session Start', async () => {
    const calls = installFetch();
    const first = new JoryioSDK({ ...cfg, trackingConsent: 'pending' });
    first.optOut();
    await first.destroy();
    resetSingleton();
    const win: any = { joryio: [['optIn'], ['init', cfg]] };
    installSnippetQueue(win);
    const second = win.joryio as JoryioSDK;
    await second.flush();
    await settle(20);
    expect(starts(calls)).toHaveLength(1);
  });

  it('a sent Session Start is not repeated after a later opt-out and reload (control)', async () => {
    const calls = installFetch();
    const first = new JoryioSDK({ ...cfg });
    await first.flush();
    await settle(20);
    first.optOut();
    first.optIn();
    await first.destroy();
    resetSingleton();
    const second = new JoryioSDK({ ...cfg });
    await second.flush();
    await settle(20);
    expect(starts(calls)).toHaveLength(1);
  });
});

describe('rule 82: standby tokens for a next user', () => {
  it('N1: wipeData() deletes a token set for the next user (standby) - stored and in memory', async () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, userId: 'A', enableSdkAuthentication: true } as any);
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    await sdk.wipeData();
    await settle(20);
    const stored = store.get('joryio_retired_sdk_auth_tokens') ?? Array.from(store.entries()).find(([k]) => k.includes('retired'))?.[1];
    expect(stored && stored.includes(jwtFor('B'))).toBeFalsy();
    expect((sdk as any).network.retiredSdkAuthUsers()).not.toContain('B');
  });

  it('N1: wipeData() keeps the erased user\'s own retired token for their withdrawals (not standby)', () => {
    const client = new NetworkClient('jry_sdk_test', { error() {}, warn() {}, info() {}, debug() {} } as any, { maxRetries: 0, backoffMs: 0 });
    client.setSdkAuthenticationEnabled(true);
    client.setCurrentUserId('A');
    client.setSdkAuthenticationToken(jwtFor('A'));
    client.retireSdkAuthToken();
    client.dropStandbySdkAuthTokens();
    expect(client.getSdkAuthHeaders('A')[SDK_AUTH_HEADER]).toBe(jwtFor('A'));
  });

  it('a held (D-b) user\'s own token survives wipeData() for their withdrawals (same as iOS and Android)', () => {
    const client = new NetworkClient('jry_sdk_test', { error() {}, warn() {}, info() {}, debug() {} } as any, { maxRetries: 0, backoffMs: 0 });
    client.setSdkAuthenticationEnabled(true);
    client.setCurrentUserId(null);
    client.switchUser('H'); // identify('H') while opted out: deferIdentify() makes H the withdrawal user
    client.setSdkAuthenticationToken(jwtFor('H'));
    client.retireSdkAuthToken(); // wipeData()
    client.dropStandbySdkAuthTokens();
    expect(client.retiredSdkAuthUsers()).toContain('H');
    expect(client.getSdkAuthHeaders('H')[SDK_AUTH_HEADER]).toBe(jwtFor('H'));
  });

  it('N3: a token set for B while anonymous, then reset(), is kept on standby past the grace and adopted by identify(B)', () => {
    const client = new NetworkClient('jry_sdk_test', { error() {}, warn() {}, info() {}, debug() {} } as any, { maxRetries: 0, backoffMs: 0 });
    client.setSdkAuthenticationEnabled(true);
    client.setCurrentUserId(null);
    client.setSdkAuthenticationToken(jwtFor('B'));
    client.retireSdkAuthToken(); // reset() while anonymous
    client.forgetRetiredSdkAuthTokensExcept(new Set(), Date.now() + 5 * 60_000); // well past the 1-minute grace
    expect(client.retiredSdkAuthUsers()).toContain('B');
    client.switchUser('B');
    expect(client.getSdkAuthHeaders('B')[SDK_AUTH_HEADER]).toBe(jwtFor('B'));
  });
});

describe('rule 72: every route attaches only a sub-matching token', () => {
  const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;

  it('a keepalive hand-off (page unload) about A never carries the token set for B', async () => {
    supportKeepalive();
    const calls = installFetch();
    const client = new NetworkClient('jry_sdk_test', logger, { maxRetries: 0, backoffMs: 0 });
    client.setSdkAuthenticationEnabled(true);
    client.setCurrentUserId('A');
    client.setSdkAuthenticationToken(jwtFor('B'));
    await client.postKeepalive('https://api.example/api/v1/attributes', { userId: 'A', anonymousId: 'anon', attributes: { x: 1 } });
    await client.postKeepalive('https://api.example/api/v1/attributes', { anonymousId: 'anon', attributes: { x: 1 } });
    await client.postKeepalive('https://api.example/api/v1/attributes', { userId: 'B', anonymousId: 'anon', attributes: { x: 1 } });
    expect(calls.map((c) => c.init.headers[SDK_AUTH_HEADER])).toEqual([undefined, undefined, jwtFor('B')]);
    expect(calls.every((c) => c.init.keepalive)).toBe(true);
  });

  it('the service worker push click and delivered beacons carry no SDK-auth token or credentials at all', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'joryio-sw.js'), 'utf8');
    const handlers: Record<string, (event: any) => void> = {};
    const fetchMock = jest.fn(async (..._args: any[]) => ({ ok: true }));
    const self: any = {
      addEventListener: (type: string, fn: (event: any) => void) => (handlers[type] = fn),
      registration: { showNotification: jest.fn(async () => undefined) },
      clients: { matchAll: jest.fn(async () => []), openWindow: jest.fn(async () => undefined) },
    };
    vm.runInNewContext(source, { self, fetch: fetchMock, URL, Promise, console, encodeURIComponent });
    const waits: Promise<unknown>[] = [];
    const data = { trackingId: 't-1', jry_api_origin: 'https://api.example/api' };
    handlers.push({ data: { json: () => ({ title: 'Hi', body: 'x', data }), text: () => '' }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    handlers.notificationclick({ notification: { close: jest.fn(), data }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    const beacons = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/track/push/'));
    expect(beacons.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of beacons) {
      expect(JSON.stringify(init.headers || {})).not.toMatch(/auth/i);
      expect(init.credentials).not.toBe('include');
    }
  });
});

describe('rule 83: the snippet pre-init purge', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, batchFlushInterval: 600000 } as any;
  async function replay(queue: any[]) {
    const calls = installFetch();
    const win: any = { joryio: queue };
    installSnippetQueue(win);
    const sdk = win.joryio as JoryioSDK;
    await sdk.flush();
    await settle(30);
    return { calls, sdk, types: batchEvents(calls).map((e: any) => e.type) };
  }

  it('a track() queued BEFORE a queued optOut() is dropped, even when a later queued optIn() follows', async () => {
    const { types } = await replay([['track', 'before opt-out'], ['optOut'], ['optIn'], ['init', cfg], ['track', 'after opt-in']]);
    expect(types).not.toContain('before opt-out');
    expect(types).toContain('after opt-in');
  });

  it('a data call queued before a queued denial is dropped, even when a later grant follows', async () => {
    const { types, calls } = await replay([
      ['track', 'before denial'],
      ['setAttribute', 'plan', 'pro'],
      ['updateConsent', 'denied'],
      ['updateConsent', 'granted'],
      ['init', cfg],
    ]);
    expect(types).not.toContain('before denial');
    expect(calls.filter((c) => c.path.endsWith('/v1/attributes'))).toHaveLength(0);
  });

  it('a data call queued before a pre-init wipeData() is not collected for the fresh visitor', async () => {
    const { types } = await replay([['track', 'before wipe'], ['wipeData'], ['init', cfg], ['track', 'after wipe']]);
    expect(types).not.toContain('before wipe');
    expect(types).toContain('after wipe');
  });

  it('with no decision queued, every queued data call is replayed (control)', async () => {
    const { types } = await replay([['track', 'kept'], ['init', cfg]]);
    expect(types).toContain('kept');
  });
});

describe('rule 83 / N2: a ready() callback queued while tracking was off runs data-gated', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, batchFlushInterval: 600000 } as any;

  it('its track() is dropped although a later queued optIn() opens tracking', async () => {
    const calls = installFetch();
    const win: any = {
      joryio: [['optOut'], ['ready', (s: JoryioSDK) => s.track('made while opted out')], ['optIn'], ['init', cfg]],
    };
    installSnippetQueue(win);
    const sdk = win.joryio as JoryioSDK;
    await sdk.flush();
    await settle(30);
    expect(batchEvents(calls).map((e: any) => e.type)).not.toContain('made while opted out');
  });

  it('it still runs: reads work, a subscribe is dropped, an unsubscribe (withdrawal) is delivered', async () => {
    const calls = installFetch();
    let ran = false;
    let anon = '';
    const win: any = {
      joryio: [
        ['updateConsent', 'denied'],
        [
          'ready',
          (s: JoryioSDK) => {
            ran = true;
            anon = s.getAnonymousId();
            s.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
            s.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
            s.ecommerce().viewProduct({ productId: 'p1', name: 'P', price: 1 } as any);
          },
        ],
        ['updateConsent', 'granted'],
        ['init', { ...cfg, userId: 'U' }],
      ],
    };
    installSnippetQueue(win);
    const sdk = win.joryio as JoryioSDK;
    await waitFor(() => subs(calls).length > 0);
    await sdk.flush();
    await settle(50);
    expect(ran).toBe(true);
    expect(anon).toBe(sdk.getAnonymousId());
    expect(subs(calls).map((c) => [c.body.channel, c.body.status])).toEqual([['sms', 'unsubscribed']]);
    expect(batchEvents(calls).map((e: any) => e.type)).not.toContain('Product Viewed');
  });

  it('only while it runs: the instance it kept tracks normally afterwards, under the real state', async () => {
    const calls = installFetch();
    let kept: JoryioSDK | null = null;
    const win: any = { joryio: [['optOut'], ['ready', (s: JoryioSDK) => (kept = s)], ['optIn'], ['init', cfg]] };
    installSnippetQueue(win);
    kept!.track('clicked later');
    await kept!.flush();
    await settle(30);
    expect(batchEvents(calls).map((e: any) => e.type)).toContain('clicked later');
  });

  it('an optIn() the callback itself makes lifts the gate for the rest of it', async () => {
    const calls = installFetch();
    const win: any = {
      joryio: [
        ['optOut'],
        [
          'ready',
          (s: JoryioSDK) => {
            s.track('before its own optIn');
            s.optIn();
            s.track('after its own optIn');
          },
        ],
        ['init', cfg],
      ],
    };
    installSnippetQueue(win);
    const sdk = win.joryio as JoryioSDK;
    await sdk.flush();
    await settle(30);
    const types = batchEvents(calls).map((e: any) => e.type);
    expect(types).not.toContain('before its own optIn');
    expect(types).toContain('after its own optIn');
  });

  it('a ready() callback queued while tracking was on sends normally (control)', async () => {
    const calls = installFetch();
    const win: any = { joryio: [['ready', (s: JoryioSDK) => s.track('made while on')], ['init', cfg]] };
    installSnippetQueue(win);
    const sdk = win.joryio as JoryioSDK;
    await sdk.flush();
    await settle(30);
    expect(batchEvents(calls).map((e: any) => e.type)).toContain('made while on');
  });
});
