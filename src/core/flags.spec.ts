import { FlagsManager, FLAG_EXPOSURE_FLUSH_MS, FLAG_EXPOSURE_MARKS_MAX, exposureBatchSettled, flagExposuresStorageKey, flagsStorageKey } from './flags';
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
    // 1.4.0-beta.12: the batch's idempotencyKey (a lowercase UUID, as on iOS and Android).
    expect(ex[0].body.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

/**
 * BACKLOG D479: the "already sent" exposure marks of the current session are
 * kept in localStorage, so a page reload in the same session sends no
 * duplicate; another session sends again; reset / another person clears them.
 */
describe('FlagsManager (web): exposure marks survive a reload within the session', () => {
  let calls: RecordedRequest[];
  let sessionId = 'sess-1';
  const live: FlagsManager[] = [];
  const page = (userId: string | null = null) => {
    const identity = { getUserId: () => userId, getAnonymousId: () => 'anon-1' } as any;
    const session = { getSessionId: () => sessionId } as any;
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
    const m = new FlagsManager('https://api.test', 'sdk-key', identity, session, logger, { canSend: () => true });
    live.push(m);
    return m;
  };
  const exposuresSent = () => calls.filter((c) => c.path === '/v1/flags/exposures').flatMap((c) => c.body.exposures);
  const readAndFlush = async (m: FlagsManager) => {
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    await settle(FLAG_EXPOSURE_FLUSH_MS + 50);
  };

  beforeEach(() => {
    jest.useRealTimers();
    sessionId = 'sess-1';
    installLocalStorage();
    calls = installFetch((req) =>
      req.path === '/v1/flags/evaluate' ? { status: 200, body: ANSWER } : { status: 200, body: { success: true, accepted: 1, dropped: 0 } },
    );
  });
  afterEach(() => {
    live.splice(0).forEach((m) => m.destroy());
    uninstallLocalStorage();
  });

  it('a reload in the same session sends no duplicate exposure', async () => {
    await readAndFlush(page());
    expect(exposuresSent()).toEqual([{ key: 'new_checkout', variant: 'on' }]);
    // The page reloads: a new FlagsManager over the same localStorage, same session.
    await readAndFlush(page());
    expect(exposuresSent()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(flagExposuresStorageKey('sdk-key'))!)).toEqual({
      sessionId: 'sess-1',
      marks: ['sess-1||anon-1|new_checkout|on'],
    });
  });

  it('a new session sends again, and keeps only the new session\'s marks', async () => {
    await readAndFlush(page());
    sessionId = 'sess-2';
    await readAndFlush(page());
    expect(exposuresSent()).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(flagExposuresStorageKey('sdk-key'))!).marks).toEqual(['sess-2||anon-1|new_checkout|on']);
  });

  it('clearExposureMarks (reset, identify of a different person) clears the marks: the next read is sent again', async () => {
    const m = page('customer-1');
    await readAndFlush(m);
    m.clearExposureMarks();
    expect(localStorage.getItem(flagExposuresStorageKey('sdk-key'))).toBeNull();
    await readAndFlush(page('customer-1'));
    expect(exposuresSent()).toHaveLength(2);
  });

  it(`keeps at most ${FLAG_EXPOSURE_MARKS_MAX} marks, the oldest dropped first`, async () => {
    const marks = Array.from({ length: FLAG_EXPOSURE_MARKS_MAX }, (_, i) => `sess-1||anon-1|flag_${i}|on`);
    localStorage.setItem(flagExposuresStorageKey('sdk-key'), JSON.stringify({ sessionId: 'sess-1', marks }));
    await readAndFlush(page());
    const kept = JSON.parse(localStorage.getItem(flagExposuresStorageKey('sdk-key'))!).marks;
    expect(kept).toHaveLength(FLAG_EXPOSURE_MARKS_MAX);
    expect(kept[0]).toBe('sess-1||anon-1|flag_1|on');
    expect(kept[kept.length - 1]).toBe('sess-1||anon-1|new_checkout|on');
  });

  it('a mark is stored when its batch is sent: a page closed before the flush sends it after the reload', async () => {
    const m = page();
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    expect(localStorage.getItem(flagExposuresStorageKey('sdk-key'))).toBeNull();
    m.destroy(); // closed within the flush delay: nothing sent
    await readAndFlush(page());
    expect(exposuresSent()).toEqual([{ key: 'new_checkout', variant: 'on' }]);
  });

  it('unreadable or blocked storage falls back to memory (still once per page)', async () => {
    localStorage.setItem(flagExposuresStorageKey('sdk-key'), '{not json');
    const m = page();
    await readAndFlush(m);
    m.getBoolFlag('new_checkout', false);
    await settle(FLAG_EXPOSURE_FLUSH_MS + 50);
    expect(exposuresSent()).toHaveLength(1);
  });
});

/**
 * 1.4.0-beta.13: a mark is "sent" only once the server took its batch. A
 * batch that got no answer, a 5xx, a 408 or a 429 goes to the SDK's write
 * outbox (here a fake one) with the same body and idempotencyKey; while it
 * waits there it counts as already exposed; its marks are stored when the
 * outbox settles it. The real outbox is covered in flags-exposure-marks-sdk.spec.ts.
 */
describe('FlagsManager (web): an exposure batch is marked sent only once the server takes it', () => {
  let calls: RecordedRequest[];
  /** What the next exposures requests answer: a status, or 'network' for no answer. Then 200. */
  let answers: Array<number | 'network'>;
  /** The fake write outbox: what was handed to it. */
  let outbox: Array<Record<string, any>>;
  let canSend = true;
  const live: FlagsManager[] = [];
  const page = () => {
    const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1' } as any;
    const session = { getSessionId: () => 'sess-1' } as any;
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
    const m = new FlagsManager('https://api.test', 'sdk-key', identity, session, logger, {
      canSend: () => canSend,
      enqueueExposures: (body) => outbox.push(body),
      pendingExposures: () => outbox,
    });
    live.push(m);
    return m;
  };
  const exposureCalls = () => calls.filter((c) => c.path === '/v1/flags/exposures');
  const storedMarks = () => JSON.parse(localStorage.getItem(flagExposuresStorageKey('sdk-key')) || '{"marks":[]}').marks;

  beforeEach(() => {
    jest.useFakeTimers();
    answers = [];
    outbox = [];
    canSend = true;
    installLocalStorage();
    calls = installFetch((req) => (req.path === '/v1/flags/evaluate' ? { status: 200, body: ANSWER } : { status: 200, body: { success: true } }));
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const res = await inner(url, init);
      if (!String(url).endsWith('/v1/flags/exposures') || !answers.length) return res;
      const next = answers.shift()!;
      if (next === 'network') throw new TypeError('Failed to fetch');
      return { ...res, ok: next >= 200 && next < 300, status: next, json: async () => ({}) };
    });
  });
  afterEach(() => {
    live.splice(0).forEach((m) => m.destroy());
    uninstallLocalStorage();
    jest.useRealTimers();
  });

  const readOnce = async (m: FlagsManager, key = 'new_checkout') => {
    await m.refreshFlags();
    m.getFlag(key, null);
    await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
  };

  it('the rule: 2xx and a 4xx other than 408 / 429 settle a batch; no answer, 5xx, 408 and 429 keep it', () => {
    expect([200, 202, 400, 401, 403, 404, 413, 422].map(exposureBatchSettled)).toEqual(Array(8).fill(true));
    expect([0, 408, 429, 500, 502, 503].map(exposureBatchSettled)).toEqual(Array(6).fill(false));
  });

  it.each([['a network error', 'network' as const], ['a 503', 503], ['a 429', 429]])(
    'after %s the batch goes to the outbox as it was sent; waiting there counts as exposed, across a reload; marked when the outbox settles it',
    async (_label, failure) => {
      answers = [failure];
      const m = page();
      await readOnce(m);
      expect(exposureCalls()).toHaveLength(1);
      expect(storedMarks()).toEqual([]);
      expect(outbox).toEqual([exposureCalls()[0].body]); // the same body, the same idempotencyKey
      // Another read, and a reload with the batch still waiting: no second copy.
      m.getBoolFlag('new_checkout', false);
      await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
      live.splice(0).forEach((x) => x.destroy());
      const reloaded = page();
      await readOnce(reloaded);
      expect(exposureCalls()).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      // The outbox delivered it.
      reloaded.exposuresSettled(outbox[0]);
      expect(storedMarks()).toEqual(['sess-1||anon-1|new_checkout|on']);
    },
  );

  it('a 2xx marks the batch; nothing goes to the outbox', async () => {
    await readOnce(page());
    expect(storedMarks()).toEqual(['sess-1||anon-1|new_checkout|on']);
    expect(outbox).toEqual([]);
  });

  it('a permanent 4xx marks the batch: no retry, nothing to the outbox', async () => {
    answers = [400];
    await readOnce(page());
    expect(storedMarks()).toEqual(['sess-1||anon-1|new_checkout|on']);
    expect(outbox).toEqual([]);
    expect(exposureCalls()).toHaveLength(1);
  });

  it('150 exposures go as two requests of at most 100, each its own key; a failed second one alone goes to the outbox', async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) many[`f${i}`] = { value: true, variant: 'on', valueType: 'boolean', reason: 'rule', version: 1, logExposure: true };
    const m = page();
    await m.refreshFlags();
    (m as any).flags = many;
    answers = [200, 503];
    for (let i = 0; i < 150; i++) m.getBoolFlag(`f${i}`, false);
    await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
    expect(exposureCalls().map((c) => c.body.exposures.length)).toEqual([100, 50]);
    expect(exposureCalls()[0].body.idempotencyKey).not.toBe(exposureCalls()[1].body.idempotencyKey);
    expect(exposureCalls().flatMap((c) => c.body.exposures.map((e: any) => e.key))).toEqual(Array.from({ length: 150 }, (_, i) => `f${i}`));
    expect(storedMarks()).toHaveLength(100); // only the request the server took
    expect(outbox).toEqual([exposureCalls()[1].body]);
    m.exposuresSettled(outbox[0]);
    expect(storedMarks()).toHaveLength(150);
  });

  it('wipe(): a queued batch is never sent, and one whose failed answer arrives after it is not handed to the outbox', async () => {
    const m = page();
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    m.wipe();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(exposureCalls()).toHaveLength(0);
    // On the wire when the wipe happens.
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    const inner = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const res = await inner(url, init);
      if (!String(url).endsWith('/v1/flags/exposures')) return res;
      await gate;
      return { ...res, ok: false, status: 503, json: async () => ({}) };
    });
    m.getNumberFlag('limit', 0);
    await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
    expect(exposureCalls()).toHaveLength(1);
    m.wipe();
    release();
    await jest.advanceTimersByTimeAsync(10);
    expect(outbox).toEqual([]);
    expect(storedMarks()).toEqual([]);
  });

  it('a failed batch is not handed to the outbox once sending stopped (opt-out, consent)', async () => {
    answers = [503];
    const m = page();
    await m.refreshFlags();
    m.getBoolFlag('new_checkout', false);
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const res = await inner(url, init);
      if (String(url).endsWith('/v1/flags/exposures')) canSend = false; // opted out while it was on the wire
      return { ...res, ok: false, status: 503, json: async () => ({}) };
    });
    await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
    expect(exposureCalls()).toHaveLength(1);
    expect(outbox).toEqual([]);
  });

  it('a flag answer without logExposure is logged, like on iOS and Android', async () => {
    const { logExposure: _omit, ...noField } = ANSWER.flags.new_checkout;
    const m = page();
    await m.refreshFlags();
    (m as any).flags = { new_checkout: noField };
    m.getBoolFlag('new_checkout', false);
    await jest.advanceTimersByTimeAsync(FLAG_EXPOSURE_FLUSH_MS + 10);
    expect(exposureCalls().flatMap((c) => c.body.exposures)).toEqual([{ key: 'new_checkout', variant: 'on' }]);
  });
});
