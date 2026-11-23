import { FlagsManager, FLAG_EXPOSURE_FLUSH_MS, flagsStorageKey } from './flags';
import { installFetch, installLocalStorage, uninstallLocalStorage, settle, RecordedRequest } from './test-harness';

/**
 * Feature flags on the web (Joryio BACKLOG D446): typed getters with in-code
 * defaults, one evaluate call, the localStorage answer kept for the same
 * visitor only, etag / notModified, exposures once per flag-variant per
 * session in one batched request, nothing without consent, onFlagsUpdated.
 */
const ANSWER = {
  flags: {
    new_checkout: { value: true, variant: 'on', valueType: 'boolean', reason: 'rule', version: 3, logExposure: true },
    banner: { value: 'Hello', variant: 'b', valueType: 'string', reason: 'default', version: 1, logExposure: false },
    limit: { value: 5, variant: 'five', valueType: 'number', reason: 'default', version: 1, logExposure: true },
    pricing: { value: { tiers: [1, 2] }, variant: 'control', valueType: 'json', reason: 'default', version: 2, logExposure: true },
  },
  etag: 'etag-1',
  ttlSeconds: 300,
};

const made: FlagsManager[] = [];
function make(opts: { canSend?: () => boolean; userId?: string | null; sdkKey?: string } = {}) {
  let userId = opts.userId ?? null;
  const identity = { getUserId: () => userId, getAnonymousId: () => 'anon-1' } as any;
  const session = { getSessionId: () => 'sess-1' } as any;
  const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
  const m = new FlagsManager('https://api.test', opts.sdkKey ?? 'sdk-key', identity, session, logger, { canSend: opts.canSend ?? (() => true) });
  made.push(m);
  return { m, setUser: (u: string | null) => (userId = u) };
}

describe('FlagsManager (web)', () => {
  let calls: RecordedRequest[];
  beforeEach(() => {
    jest.useRealTimers();
    installLocalStorage();
    calls = installFetch((req) => {
      if (req.path === '/v1/flags/evaluate') {
        return req.body?.etag === 'etag-1' ? { status: 200, body: { flags: {}, etag: 'etag-1', notModified: true } } : { status: 200, body: ANSWER };
      }
      return { status: 200, body: { success: true, accepted: 1, dropped: 0 } };
    });
  });
  afterEach(() => {
    // Pending exposure timers belong to their test.
    made.splice(0).forEach((m) => m.destroy());
    uninstallLocalStorage();
  });

  it('the stored answer is per workspace: another SDK key on this origin never reads it, and the old unscoped key is dropped', async () => {
    localStorage.setItem('jry_flags', JSON.stringify({ subject: 'customer-1|anon-1', etag: 'x', fetchedAt: 0, flags: { new_checkout: ANSWER.flags.new_checkout } }));
    const a = make({ userId: 'customer-1', sdkKey: 'jry_live_workspace_a' });
    // The legacy key is not trusted (any workspace could have written it).
    expect(a.m.getBoolFlag('new_checkout', false)).toBe(false);
    expect(localStorage.getItem('jry_flags')).toBeNull();
    await a.m.refreshFlags();
    expect(localStorage.getItem(flagsStorageKey('jry_live_workspace_a'))).toContain('new_checkout');
    // Same person, same origin, another workspace: starts from its defaults.
    const b = make({ userId: 'customer-1', sdkKey: 'jry_live_workspace_b' });
    expect(flagsStorageKey('jry_live_workspace_a')).not.toBe(flagsStorageKey('jry_live_workspace_b'));
    expect(b.m.getBoolFlag('new_checkout', false)).toBe(false);
    // Workspace A, reloaded, still has its own.
    const a2 = make({ userId: 'customer-1', sdkKey: 'jry_live_workspace_a' });
    expect(a2.m.getBoolFlag('new_checkout', false)).toBe(true);
  });

  it('returns the in-code default before the first answer, then the typed values', async () => {
    const { m } = make();
    expect(m.getBoolFlag('new_checkout', false)).toBe(false);
    await m.refreshFlags();
    expect(m.getBoolFlag('new_checkout', false)).toBe(true);
    expect(m.getStringFlag('banner', 'x')).toBe('Hello');
    expect(m.getNumberFlag('limit', 0)).toBe(5);
    expect(m.getJsonFlag('pricing', null)).toEqual({ tiers: [1, 2] });
    expect(m.getFlag('missing', 'fallback')).toBe('fallback');
    // A getter of the wrong type gets the default.
    expect(m.getNumberFlag('banner', 7)).toBe(7);
    expect(m.getAllFlags()).toEqual({ new_checkout: true, banner: 'Hello', limit: 5, pricing: { tiers: [1, 2] } });
  });

  it('one evaluate call names the visitor, with the SDK key and context', async () => {
    const { m } = make({ userId: 'customer-1' });
    await m.refreshFlags();
    const ev = calls.filter((c) => c.path === '/v1/flags/evaluate');
    expect(ev).toHaveLength(1);
    expect(ev[0].init.headers['X-SDK-Key']).toBe('sdk-key');
    expect(ev[0].body).toMatchObject({ userId: 'customer-1', anonymousId: 'anon-1', sessionId: 'sess-1', context: { platform: 'web' } });
  });

  it('keeps the answer in localStorage for the same visitor only, and sends its etag back', async () => {
    const a = make();
    await a.m.refreshFlags();
    const b = make();
    expect(b.m.getBoolFlag('new_checkout', false)).toBe(true);
    await b.m.refreshFlags();
    expect(calls.filter((c) => c.path === '/v1/flags/evaluate').pop()!.body.etag).toBe('etag-1');
    expect(b.m.getBoolFlag('new_checkout', false)).toBe(true); // notModified keeps the held answer
    const other = make({ userId: 'someone-else' });
    expect(other.m.getBoolFlag('new_checkout', false)).toBe(false);
  });

  it('logs one exposure per flag-variant per session, batched, and none for a sampled-out flag', async () => {
    const { m } = make();
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    m.getBoolFlag('new_checkout', false);
    m.getStringFlag('banner', ''); // logExposure: false
    m.getNumberFlag('limit', 0);
    m.getAllFlags(); // logs nothing
    await settle(FLAG_EXPOSURE_FLUSH_MS + 50);
    const ex = calls.filter((c) => c.path === '/v1/flags/exposures');
    expect(ex).toHaveLength(1);
    expect(ex[0].body.exposures).toEqual([
      { key: 'new_checkout', variant: 'on' },
      { key: 'limit', variant: 'five' },
    ]);
    expect(ex[0].body).toMatchObject({ anonymousId: 'anon-1', sessionId: 'sess-1' });
  });

  it('without consent nothing is sent and the defaults are returned', async () => {
    let allowed = true;
    const { m } = make({ canSend: () => allowed });
    await m.refreshFlags();
    allowed = false;
    expect(m.getBoolFlag('new_checkout', false)).toBe(false);
    expect(m.getAllFlags()).toEqual({});
    const before = calls.length;
    await m.refreshFlags();
    await settle(FLAG_EXPOSURE_FLUSH_MS + 50);
    expect(calls.length).toBe(before);
  });

  it('an identity change drops the held answer, tells the listeners and fetches again', async () => {
    const { m, setUser } = make();
    await m.refreshFlags();
    const seen: string[][] = [];
    const off = m.onFlagsUpdated((keys) => seen.push(keys));
    setUser('customer-2');
    m.onIdentityChanged();
    expect(m.getBoolFlag('new_checkout', false)).toBe(false);
    await settle(10);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(m.getBoolFlag('new_checkout', false)).toBe(true);
    // A JoryioSubscription: cancel() stops it, calling it is the same, twice is harmless.
    expect(typeof off.cancel).toBe('function');
    off.cancel();
    off();
    const count = seen.length;
    setUser('customer-3');
    m.onIdentityChanged();
    await settle(10);
    expect(seen.length).toBe(count);
  });

  it('exposures read as A are sent as A after identify(B), never as B', async () => {
    const { m, setUser } = make({ userId: 'person-a' });
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false); // queued as A
    setUser('person-b');
    m.onIdentityChanged(); // flushes A's batch with A's snapshot
    await settle(10);
    m.getNumberFlag('limit', 0); // read as B (after B's answer arrived)
    m.flush();
    await settle(10);
    const ex = calls.filter((c) => c.path === '/v1/flags/exposures');
    const asA = ex.filter((c) => c.body.userId === 'person-a');
    const asB = ex.filter((c) => c.body.userId === 'person-b');
    expect(asA).toHaveLength(1);
    expect(asA[0].body.exposures).toEqual([{ key: 'new_checkout', variant: 'on' }]);
    // B's request carries only what B read.
    expect(asB.flatMap((c) => c.body.exposures)).toEqual([{ key: 'limit', variant: 'five' }]);
  });

  it('the same flag read by the next person in the same session is their exposure too', async () => {
    const { m, setUser } = make({ userId: 'person-a' });
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    setUser('person-b');
    m.onIdentityChanged();
    await settle(10);
    m.getBoolFlag('new_checkout', false);
    m.flush();
    await settle(10);
    const asB = calls.filter((c) => c.path === '/v1/flags/exposures' && c.body.userId === 'person-b');
    expect(asB.flatMap((c) => c.body.exposures)).toEqual([{ key: 'new_checkout', variant: 'on' }]);
  });

  it('an answer in flight for the previous visitor is dropped and the next one is fetched', async () => {
    const { m, setUser } = make({ userId: 'person-a' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const asked: any[] = [];
    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      asked.push(JSON.parse(init.body));
      if (asked.length === 1) await gate;
      return { ok: true, status: 200, json: async () => ANSWER };
    });
    const first = m.refreshFlags();
    setUser('person-b');
    m.onIdentityChanged();
    release();
    await first;
    await settle(10);
    expect(asked.map((b) => b.userId)).toEqual(['person-a', 'person-b']);
    expect(m.getBoolFlag('new_checkout', false)).toBe(true);
  });

  it('exposures queued before consent was withdrawn are dropped', async () => {
    let allowed = true;
    const { m } = make({ canSend: () => allowed });
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    allowed = false;
    m.onIdentityChanged();
    await settle(FLAG_EXPOSURE_FLUSH_MS + 50);
    expect(calls.filter((c) => c.path === '/v1/flags/exposures')).toHaveLength(0);
  });

  it('a failed refresh keeps the held flags', async () => {
    const { m } = make();
    await m.refreshFlags();
    installFetch(() => ({ status: 503, body: {} }));
    await m.refreshFlags();
    expect(m.getBoolFlag('new_checkout', false)).toBe(true);
  });
});
