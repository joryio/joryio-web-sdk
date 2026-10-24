import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { SDK_AUTH_HEADER } from './network';
import { installSnippetQueue } from '../index';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor } from './test-harness';

/**
 * Scan 9 (web), contract v9 rules 89, 90, 91, 92. The scan's probes
 * (scan9-web/probes p9.spec.ts R2-R4, p9b.spec.ts R5, R5b) lifted as
 * regression tests, plus the rule-91 snippet cases.
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
  jest.restoreAllMocks();
});

const jwtFor = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64').replace(/=+$/, '')}.s`;
const batchEvents = (calls: any[]) => calls.filter((c) => c.path.endsWith('/v1/track/batch')).flatMap((c) => c.body.events);
const subs = (calls: any[]) => calls.filter((c) => c.path.endsWith('/v1/subscriptions/channel'));
const retiredStored = (): Record<string, any> => {
  const raw = Array.from(store.entries()).find(([k]) => k.includes('retired_sdk_auth'))?.[1];
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed;
};

async function runSnippet(queue: any[]) {
  const calls = installFetch();
  const win: any = { joryio: queue };
  installSnippetQueue(win);
  const sdk = win.joryio as JoryioSDK;
  if (typeof (sdk as any).flush === 'function') await sdk.flush();
  await settle(30);
  return { calls, types: batchEvents(calls).map((e: any) => e.type) };
}

describe('rule 89: a token adopted from standby is the user\'s own - wipeData() keeps it for their withdrawals', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true } as any;

  it('R5: the erased user\'s unsubscribe waiting in a backoff over the wipe still carries their token', async () => {
    let down = true;
    const calls = installFetch((req) => {
      if (!req.path.endsWith('/v1/subscriptions/channel')) return { status: 200, body: { success: true } };
      if (down) return { status: 503, body: {} };
      return req.init.headers?.[SDK_AUTH_HEADER] === jwtFor('E')
        ? { status: 200, body: { success: true } }
        : { status: 401, body: { error: 'sdk_authentication_error', reason: 'missing' } };
    });
    // Page 1: the host sets E's token before E signs in, reset() -> standby for E; then E signs in.
    const page1 = new JoryioSDK({ ...cfg });
    page1.setSdkAuthenticationToken(jwtFor('E'));
    await page1.reset();
    page1.identify('E');
    await settle(20);
    await page1.destroy();
    // Page 2 (restart): E signed in from storage, no token set on this page yet.
    resetSingleton();
    const page2 = new JoryioSDK({ ...cfg });
    expect(page2.getUserId()).toBe('E');
    // Adopted at init: no longer flagged standby, in memory or in storage.
    expect(retiredStored().E?.standby).toBeUndefined();
    page2.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => subs(calls).length > 0);
    expect(subs(calls)[0].init.headers[SDK_AUTH_HEADER]).toBe(jwtFor('E'));
    await page2.wipeData();
    down = false;
    (page2 as any).outbox.kick();
    await waitFor(() => subs(calls).length > 1, 15000);
    await settle(50);
    const last = subs(calls)[subs(calls).length - 1];
    expect(last.body.userId).toBe('E');
    expect(last.init.headers[SDK_AUTH_HEADER]).toBe(jwtFor('E'));
  }, 30000);

  it('R5b: unsubscribe then wipeData() in one click - the unsubscribe carries E\'s token and is delivered', async () => {
    const calls = installFetch((req) => {
      if (!req.path.endsWith('/v1/subscriptions/channel')) return { status: 200, body: { success: true } };
      return req.init.headers?.[SDK_AUTH_HEADER] === jwtFor('E')
        ? { status: 200, body: { success: true } }
        : { status: 401, body: { error: 'sdk_authentication_error', reason: 'missing' } };
    });
    const page1 = new JoryioSDK({ ...cfg, userId: 'A' });
    page1.setSdkAuthenticationToken(jwtFor('E'));
    await page1.reset();
    page1.identify('E');
    await settle(20);
    await page1.destroy();
    resetSingleton();
    const page2 = new JoryioSDK({ ...cfg });
    expect(page2.getUserId()).toBe('E');
    page2.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await page2.wipeData();
    await waitFor(() => subs(calls).length > 0);
    await settle(100);
    expect(subs(calls)[0].init.headers[SDK_AUTH_HEADER]).toBe(jwtFor('E'));
    expect((page2 as any).outbox.size()).toBe(0);
  }, 30000);

  it('identify() adopting a standby token clears its flag (memory and storage)', async () => {
    installFetch();
    const sdk = new JoryioSDK({ ...cfg });
    sdk.setSdkAuthenticationToken(jwtFor('E'));
    await sdk.reset();
    expect(retiredStored().E?.standby).toBe(true);
    sdk.identify('E');
    await settle(10);
    expect(retiredStored().E?.standby).toBeUndefined();
  });

  it('control: a true standby token (nobody signed in, nothing queued) is still deleted by wipeData()', async () => {
    installFetch();
    const sdk = new JoryioSDK({ ...cfg, userId: 'A' });
    sdk.setSdkAuthenticationToken(jwtFor('B'));
    await sdk.reset();
    expect(retiredStored().B?.standby).toBe(true);
    await sdk.wipeData();
    expect(retiredStored().B).toBeUndefined();
    expect((sdk as any).network.retiredSdkAuthUsers()).not.toContain('B');
  });
});

describe('rule 90: a Session Start already on the wire when the visitor denies is settled by its answer', () => {
  function holdingFetch() {
    const calls: any[] = [];
    const ctl = { hold: true, status: 200, release: null as null | (() => void) };
    (globalThis as any).fetch = jest.fn(async (url: string, init: any = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path, body, init });
      let status = 200;
      if (ctl.hold && path.endsWith('/v1/track/batch')) {
        await new Promise<void>((r) => (ctl.release = r));
        status = ctl.status;
      }
      const resBody = path.endsWith('/v1/track/batch') ? { success: true, processed: body?.events?.length ?? 0 } : { success: true };
      return { ok: status < 300, status, statusText: 'X', headers: { get: () => 'application/json' }, json: async () => resBody, text: async () => JSON.stringify(resBody), clone() { return this; } };
    });
    return { calls, ctl };
  }
  const cfg = { ...BASE_CONFIG, trackSessionStart: true, trackPageViews: false, persistQueue: true, batchFlushInterval: 600000 } as any;

  async function denyWhileInFlight(answer: number) {
    const { calls, ctl } = holdingFetch();
    const first = new JoryioSDK({ ...cfg });
    const session = first.getSessionInfo().sessionId;
    void first.flush();
    await settle(20);
    expect(batchEvents(calls).filter((e: any) => e.type === 'Session Start')).toHaveLength(1);
    first.updateConsent('denied');
    ctl.hold = false;
    ctl.status = answer;
    ctl.release!();
    await settle(20);
    await first.destroy();
    resetSingleton();
    const second = new JoryioSDK({ ...cfg, trackingConsent: 'granted' });
    expect(second.getSessionInfo().sessionId).toBe(session);
    await second.flush();
    await settle(20);
    await second.destroy();
    return batchEvents(calls).filter((e: any) => e.type === 'Session Start' && e.sessionId === session).length;
  }

  it('R3: stored by the server (200) - the next page with consent granted sends no second one', async () => {
    expect(await denyWhileInFlight(200)).toBe(1);
  });

  it('not stored (400) - the next page with consent granted announces the session', async () => {
    expect(await denyWhileInFlight(400)).toBe(2);
  });

  it('control: a Session Start still waiting in the queue (consent pending) is owed - the next granted page sends it', async () => {
    const calls = installFetch();
    const first = new JoryioSDK({ ...cfg, trackingConsent: 'pending' });
    const session = first.getSessionInfo().sessionId;
    first.updateConsent('denied');
    await first.destroy();
    resetSingleton();
    const second = new JoryioSDK({ ...cfg, trackingConsent: 'granted' });
    await second.flush();
    await settle(20);
    expect(batchEvents(calls).filter((e: any) => e.type === 'Session Start' && e.sessionId === session)).toHaveLength(1);
  });
});

describe('rule 92: the ready() data gate is per reason', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, batchFlushInterval: 600000 } as any;

  it('R2a: queued while OPTED OUT - its own updateConsent(granted) does not lift the opt-out gate', async () => {
    const { types } = await runSnippet([
      ['optOut'],
      ['ready', (s: JoryioSDK) => { s.updateConsent('granted'); s.track('made while opted out'); }],
      ['optIn'],
      ['init', cfg],
    ]);
    expect(types).not.toContain('made while opted out');
  });

  it('R2b control: no decision inside the callback - dropped', async () => {
    const { types } = await runSnippet([['optOut'], ['ready', (s: JoryioSDK) => s.track('made while opted out')], ['optIn'], ['init', cfg]]);
    expect(types).not.toContain('made while opted out');
  });

  it('R2c: queued while DENIED - its own optIn() does not lift the denial gate', async () => {
    const { types } = await runSnippet([
      ['updateConsent', 'denied'],
      ['ready', (s: JoryioSDK) => { s.optIn(); s.track('made while denied'); }],
      ['updateConsent', 'granted'],
      ['init', cfg],
    ]);
    expect(types).not.toContain('made while denied');
  });

  it('R2d: queued BEFORE a queued optOut - its own grant does not lift the purge', async () => {
    const { types } = await runSnippet([
      ['ready', (s: JoryioSDK) => { s.updateConsent('granted'); s.track('before the opt-out'); }],
      ['optOut'],
      ['optIn'],
      ['init', cfg],
    ]);
    expect(types).not.toContain('before the opt-out');
  });

  it('matching decisions still lift: optIn() after an opt-out, a grant after a denial', async () => {
    const { types } = await runSnippet([
      ['optOut'],
      ['ready', (s: JoryioSDK) => { s.optIn(); s.track('opted back in'); }],
      ['init', cfg],
    ]);
    expect(types).toContain('opted back in');
    resetSingleton();
    store.clear();
    const second = await runSnippet([
      ['updateConsent', 'denied'],
      ['ready', (s: JoryioSDK) => { s.updateConsent('granted'); s.track('granted again'); }],
      ['init', cfg],
    ]);
    expect(second.types).toContain('granted again');
  });

  it('R4: a ready() queued before a pre-init wipeData() (tracking never off) is not gated', async () => {
    const { types } = await runSnippet([['ready', (s: JoryioSDK) => s.track('page setup')], ['wipeData'], ['init', cfg]]);
    expect(types).toContain('page setup');
  });

  it('control: a track() queued before a pre-init wipeData() is still purged', async () => {
    const { types } = await runSnippet([['track', 'before wipe'], ['wipeData'], ['init', cfg]]);
    expect(types).not.toContain('before wipe');
  });
});

describe('rule 91: the queued init config decides for the calls queued with it', () => {
  const cfg = { ...BASE_CONFIG, trackSessionStart: false, trackPageViews: false, batchFlushInterval: 600000 } as any;
  async function storedDecision(fn: (s: JoryioSDK) => void) {
    installFetch();
    const s = new JoryioSDK({ ...cfg });
    fn(s);
    await s.destroy();
    resetSingleton();
  }

  it('init({trackingConsent: granted}) over a stored denial: a queued track() is sent', async () => {
    await storedDecision((s) => s.updateConsent('denied'));
    const { types } = await runSnippet([['track', 'after grant'], ['init', { ...cfg, trackingConsent: 'granted' }], ['track', 'after init']]);
    expect(types).toEqual(expect.arrayContaining(['after grant', 'after init']));
  });

  it('init({trackingConsent: denied}): a queued track() is refused', async () => {
    const { types } = await runSnippet([['track', 'x'], ['init', { ...cfg, trackingConsent: 'denied' }]]);
    expect(types).not.toContain('x');
  });

  it('init({optOut: true}): a queued track() is refused', async () => {
    const { types } = await runSnippet([['track', 'x'], ['init', { ...cfg, optOut: true }]]);
    expect(types).not.toContain('x');
  });

  it('init({optOut: false}) lifts no stored opt-out', async () => {
    await storedDecision((s) => s.optOut());
    const { types } = await runSnippet([['track', 'x'], ['init', { ...cfg, optOut: false }]]);
    expect(types).not.toContain('x');
  });
});
