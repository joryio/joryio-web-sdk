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
