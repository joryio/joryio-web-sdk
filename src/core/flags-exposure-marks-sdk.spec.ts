import { JoryioSDK } from './sdk';
import { flagExposuresStorageKey, FLAG_EXPOSURE_FLUSH_MS } from './flags';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, settle, RecordedRequest } from './test-harness';

/**
 * BACKLOG D479 through the public SDK: the session's "already sent" exposure
 * marks survive a reload (a new SDK over the same localStorage, the session
 * resumed), and reset() / identify() of a different person clear them - the
 * same rule as the attributes (1.4.0-beta.11).
 */
let sdks: JoryioSDK[] = [];
let calls: RecordedRequest[] = [];
const ANSWER = {
  flags: { new_checkout: { value: true, variant: 'on', valueType: 'boolean', reason: 'rule', version: 3, logExposure: true } },
  etag: 'e',
  ttlSeconds: 300,
};

beforeEach(() => {
  installLocalStorage();
  calls = installFetch((req) => {
    if (req.path.endsWith('/v1/flags/evaluate')) return { status: 200, body: ANSWER };
    return { status: 200, body: { success: true, accepted: 1, dropped: 0 } };
  });
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location: { href: 'https://shop.example/', origin: 'https://shop.example', pathname: '/', search: '' }, ...listeners };
  (globalThis as any).document = { referrer: '', readyState: 'complete', visibilityState: 'visible', ...listeners };
});

afterEach(async () => {
  for (const s of sdks.splice(0)) await s.destroy();
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

const open = () => {
  const s = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
  sdks.push(s);
  return s;
};
const exposureCalls = () => calls.filter((c) => c.path.endsWith('/v1/flags/exposures'));
const read = async (s: JoryioSDK) => {
  await s.refreshFlags();
  s.getBoolFlag('new_checkout', false);
  await settle(FLAG_EXPOSURE_FLUSH_MS + 100);
};

describe('flag exposure marks across a reload (D479)', () => {
  it('a reload in the same session sends no duplicate; the wire is unchanged', async () => {
    const first = open();
    await read(first);
    expect(exposureCalls()).toHaveLength(1);
    const sent = exposureCalls()[0].body;
    expect(Object.keys(sent).sort()).toEqual(['anonymousId', 'attributes', 'context', 'exposures', 'idempotencyKey', 'sessionId']);
    await first.destroy();
    sdks = [];
    const reloaded = open();
    await read(reloaded);
    expect(exposureCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith('/v1/flags/exposures')).pop()!.body.sessionId).toBe(sent.sessionId);
  });

  it('reset() clears the marks: the next visitor\'s read is sent', async () => {
    const s = open();
    await read(s);
    await s.reset();
    expect(localStorage.getItem(flagExposuresStorageKey(BASE_CONFIG.sdkKey))).toBeNull();
    await read(s);
    expect(exposureCalls()).toHaveLength(2);
  });

  it('identify() of a different person clears them; the same person again does not', async () => {
    const s = open();
    s.identify('user-a');
    await read(s);
    s.identify('user-a');
    await read(s);
    expect(exposureCalls()).toHaveLength(1);
    expect(localStorage.getItem(flagExposuresStorageKey(BASE_CONFIG.sdkKey))).toContain('user-a');
    s.identify('user-b');
    expect(localStorage.getItem(flagExposuresStorageKey(BASE_CONFIG.sdkKey))).toBeNull();
    await read(s);
    expect(exposureCalls()).toHaveLength(2);
    expect(exposureCalls()[1].body.userId).toBe('user-b');
  });
});

/**
 * 1.4.0-beta.13: a batch the server did not take goes to the persisted write
 * outbox with the same body and idempotencyKey. It survives a reload, is sent
 * once, counts as exposed while it waits, and wipeData() / optOut() purge it
 * from localStorage too.
 */
describe('exposures the server did not take, through the write outbox (1.4.0-beta.13)', () => {
  let failing = true;
  const exposuresAnswered: number[] = [];
  const failExposures = () => {
    failing = true;
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const res = await inner(url, init);
      if (!String(url).endsWith('/v1/flags/exposures')) return res;
      exposuresAnswered.push(failing ? 503 : 200);
      return failing ? { ...res, ok: false, status: 503, json: async () => ({}) } : res;
    });
  };
  const outboxOnDisk = () => {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) all.push(localStorage.getItem(localStorage.key(i)!) || '');
    return all.filter((v) => v.includes('"kind":"exposures"'));
  };
  const marks = () => localStorage.getItem(flagExposuresStorageKey(BASE_CONFIG.sdkKey));
  beforeEach(() => {
    exposuresAnswered.length = 0;
  });

  it('a failed send survives a reload: the outbox sends it once with the same key, and a read meanwhile adds no copy', async () => {
    failExposures();
    const first = open();
    await read(first);
    const key = exposureCalls()[0].body.idempotencyKey;
    expect(outboxOnDisk()).toHaveLength(1);
    expect(marks()).toBeNull();
    await first.destroy(); // the page closes before the outbox got it through
    sdks = [];
    const reloaded = open();
    reloaded.getBoolFlag('new_checkout', false); // read again while it still waits
    failing = false;
    await read(reloaded);
    await settle(2500);
    const taken = exposureCalls().filter((c, i) => exposuresAnswered[i] === 200);
    expect(taken).toHaveLength(1);
    expect(new Set(exposureCalls().map((c) => c.body.idempotencyKey))).toEqual(new Set([key]));
    expect(outboxOnDisk()).toHaveLength(0);
    expect(marks()).toContain('new_checkout');
  });

  it('after wipeData() a failed batch is never sent and nothing is left on disk', async () => {
    failExposures();
    const s = open();
    await read(s);
    expect(outboxOnDisk()).toHaveLength(1);
    const before = exposureCalls().length;
    await s.wipeData();
    failing = false;
    await settle(2500);
    expect(exposureCalls()).toHaveLength(before);
    expect(outboxOnDisk()).toHaveLength(0);
    expect(marks()).toBeNull();
  });

  it('optOut() purges it from the outbox: an optIn() later does not send it', async () => {
    failExposures();
    const s = open();
    await read(s);
    const before = exposureCalls().length;
    s.optOut();
    expect(outboxOnDisk()).toHaveLength(0);
    s.optIn();
    failing = false;
    await settle(2500);
    expect(exposureCalls()).toHaveLength(before);
  });
});

/**
 * Rolling back from 1.4.0: an SDK before 1.4.0-beta.13 does not know the
 * outbox kind `exposures`. Its load reads every stored entry on its own
 * (`entryFromStored`, unchanged since 1.3.0 - 98b224529: an unknown kind is
 * `null` and skipped) - so the exposures entry is skipped and every other
 * write is kept. The same check here, with a kind this build does not know.
 */
describe('a stored outbox with an entry kind this build does not know', () => {
  it('skips that entry only: every other write is loaded and kept', async () => {
    const { StorageManager } = await import('./storage');
    const { WriteOutbox, OUTBOX_KEY } = await import('./outbox');
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
    const storage = new StorageManager(BASE_CONFIG.sdkKey, logger);
    const entry = (id: string, record: any) => ({ id, record, withdrawal: false, attempts: 0, notFoundAttempts: 0, failures: 0, notBefore: 0, createdAt: 1 });
    storage.set(OUTBOX_KEY, [
      entry('a', { kind: 'alias', payload: { anonymousId: 'anon-1', aliasLabel: 'crm', aliasName: 'c-1' } }),
      entry('x', { kind: 'kind_from_a_newer_build', payload: { anonymousId: 'anon-1', sessionId: 's', exposures: [] } }),
      entry('s', { kind: 'subscription', payload: { anonymousId: 'anon-1', channel: 'email', status: 'subscribed' } }),
    ]);
    const box = new WriteOutbox({
      storage,
      logger,
      gate: () => 'hold',
      resolveOwner: (o) => o,
      ownerIsCurrentUser: () => true,
      currentIdentity: () => ({ anonymousId: 'anon-1', userId: null }),
      send: async () => ({ ok: true, status: 200 }),
      beforeSend: async () => undefined,
      isSdkAuthError: () => false,
    });
    expect(box.records().map((r) => r.kind)).toEqual(['alias', 'subscription']);
    box.destroy();
  });
});

/**
 * 1.4.0-beta.14: a batch handed to the outbox after its direct send failed
 * counts as having failed once. Its first outbox attempt waits the first
 * backoff step (writeRetryDelay(1) = 2 s), or the answer's Retry-After when
 * longer - beta.13 re-sent it 2-20 ms later, from the kick after enqueue.
 */
describe('no immediate re-send after a failed direct send (1.4.0-beta.14)', () => {
  const times: number[] = [];
  let answer: () => { status: number; headers?: Record<string, string> } = () => ({ status: 503 });
  beforeEach(() => {
    times.length = 0;
    answer = () => ({ status: 503 });
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/flags/evaluate')) return { status: 200, body: ANSWER };
      if (req.path.endsWith('/v1/flags/exposures')) {
        times.push(Date.now());
        const a = answer();
        return { status: a.status, headers: a.headers, body: a.status === 200 ? { success: true, accepted: 1, dropped: 0 } : {} };
      }
      return { status: 200, body: { success: true } };
    });
  });
  /** The stored exposures entries' first-attempt times. */
  const storedNotBefore = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.getItem(localStorage.key(i)!) || '';
      if (!raw.includes('"kind":"exposures"')) continue;
      // The stored value may be wrapped by the StorageManager: read the field itself.
      for (const m of raw.matchAll(/"firstAttemptNotBefore":(\d+)/g)) out.push(Number(m[1]));
    }
    return out;
  };

  it('a 503: the next attempt is not before the first backoff step, then goes with the same key', async () => {
    const s = open();
    await s.refreshFlags();
    const before = Date.now();
    s.getBoolFlag('new_checkout', false);
    await settle(FLAG_EXPOSURE_FLUSH_MS + 100);
    expect(times).toHaveLength(1);
    const [notBefore] = storedNotBefore();
    expect(notBefore).toBeGreaterThanOrEqual(before + 2000);
    expect(notBefore).toBeLessThanOrEqual(Date.now() + 2000);
    // Fails before: a second 503 came a few ms after the first.
    await settle(500);
    expect(times).toHaveLength(1);
    answer = () => ({ status: 200 });
    await settle(Math.max(0, notBefore - Date.now()) + 300);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000 - 20);
    expect(new Set(exposureCalls().map((c) => c.body.idempotencyKey)).size).toBe(1);
    expect(storedNotBefore()).toHaveLength(0);
  });

  it('a 429 with Retry-After: 10 - the next attempt is not before 10 s, across a reload too', async () => {
    answer = () => ({ status: 429, headers: { 'retry-after': '10' } });
    const s = open();
    await s.refreshFlags();
    const before = Date.now();
    s.getBoolFlag('new_checkout', false);
    await settle(FLAG_EXPOSURE_FLUSH_MS + 100);
    const [notBefore] = storedNotBefore();
    expect(notBefore).toBeGreaterThanOrEqual(before + 10_000);
    expect(notBefore).toBeLessThanOrEqual(Date.now() + 10_000);
    await settle(1000);
    expect(times).toHaveLength(1);
    // The page reloads: the stored wait holds there too.
    await s.destroy();
    sdks = [];
    answer = () => ({ status: 200 });
    const reloaded = open();
    await reloaded.refreshFlags();
    await settle(1000);
    expect(times).toHaveLength(1);
    expect(storedNotBefore()).toEqual([notBefore]);
  });

  it('a Retry-After given as an HTTP date is honoured', async () => {
    answer = () => ({ status: 503, headers: { 'retry-after': new Date(Date.now() + 60_000).toUTCString() } });
    const s = open();
    await s.refreshFlags();
    const before = Date.now();
    s.getBoolFlag('new_checkout', false);
    await settle(FLAG_EXPOSURE_FLUSH_MS + 100);
    // An HTTP date has whole seconds: allow the second it was cut to.
    expect(storedNotBefore()[0]).toBeGreaterThanOrEqual(before + 58_000);
    await settle(500);
    expect(times).toHaveLength(1);
  });
});

/** The outbox rule itself, with a fake clock (1.4.0-beta.14). */
describe('WriteOutbox.enqueue(record, { afterFailedSend, retryAfterMs })', () => {
  const build = async () => {
    const { StorageManager } = await import('./storage');
    const { WriteOutbox } = await import('./outbox');
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
    const storage = new StorageManager(BASE_CONFIG.sdkKey, logger);
    const sent: string[] = [];
    let status = 200;
    let retryAfterMs: number | undefined;
    const box = new WriteOutbox({
      storage,
      logger,
      gate: () => 'send',
      resolveOwner: (o) => o,
      ownerIsCurrentUser: () => true,
      currentIdentity: () => ({ anonymousId: 'anon-1', userId: null }),
      send: async (e) => {
        sent.push(String((e.record.payload as any).idempotencyKey ?? e.record.kind));
        return { ok: status < 300, status, retryAfterMs };
      },
      beforeSend: async () => undefined,
      isSdkAuthError: () => false,
    });
    return {
      box,
      sent,
      answer: (s: number, ra?: number) => {
        status = s;
        retryAfterMs = ra;
      },
    };
  };
  const exposures = (key: string) => ({ kind: 'exposures' as const, payload: { anonymousId: 'anon-1', idempotencyKey: key, exposures: [] } });
  const flushPromises = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('waits the first step (2 s), then counts on from there (5 s after its next failure)', async () => {
    const { box, sent, answer } = await build();
    answer(503);
    box.enqueue(exposures('k'), { afterFailedSend: true });
    await flushPromises();
    expect(sent).toEqual([]);
    await jest.advanceTimersByTimeAsync(1999);
    expect(sent).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['k']);
    // failures = 2 now: writeRetryDelay(2) = 5 s.
    await jest.advanceTimersByTimeAsync(4999);
    expect(sent).toEqual(['k']);
    answer(200);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['k', 'k']);
    expect(box.size()).toBe(0);
    box.destroy();
  });

  it('a Retry-After longer than the first step wins, capped at the outbox maximum', async () => {
    const { box, sent } = await build();
    box.enqueue(exposures('a'), { afterFailedSend: true, retryAfterMs: 10_000 });
    box.enqueue(exposures('b'), { afterFailedSend: true, retryAfterMs: 60 * 60 * 1000 });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(sent).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 10_001);
    expect(sent).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['a', 'b']);
    box.destroy();
  });

  it('only that entry waits: a write queued before or after it goes now', async () => {
    const { box, sent } = await build();
    box.enqueue({ kind: 'alias', payload: { anonymousId: 'anon-1', aliasLabel: 'crm', aliasName: 'c-1' } });
    box.enqueue(exposures('x'), { afterFailedSend: true, retryAfterMs: 10_000 });
    box.enqueue({ kind: 'subscription', payload: { anonymousId: 'anon-1', channel: 'email', status: 'subscribed' } });
    await jest.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(['alias', 'subscription']);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(['alias', 'subscription', 'x']);
    box.destroy();
  });

  it('the outbox honours a Retry-After on its own later attempts too', async () => {
    const { box, sent, answer } = await build();
    answer(429, 30_000);
    box.enqueue(exposures('k'), { afterFailedSend: true });
    await jest.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(['k']);
    answer(200);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(sent).toEqual(['k']);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['k', 'k']);
    box.destroy();
  });

  it('a stored first wait further away than the maximum means the clock moved: it goes now', async () => {
    const { StorageManager } = await import('./storage');
    const { OUTBOX_KEY } = await import('./outbox');
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any;
    new StorageManager(BASE_CONFIG.sdkKey, logger).set(OUTBOX_KEY, [
      { id: 'far', record: exposures('far'), attempts: 0, notFoundAttempts: 0, failures: 1, createdAt: 1, firstAttemptNotBefore: Date.now() + 5 * 60 * 1000 + 1 },
      { id: 'near', record: exposures('near'), attempts: 0, notFoundAttempts: 0, failures: 1, createdAt: 2, firstAttemptNotBefore: Date.now() + 3000 },
    ]);
    const { box, sent } = await build();
    box.kick();
    await jest.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(['far']);
    await jest.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual(['far', 'near']);
    box.destroy();
  });
});
