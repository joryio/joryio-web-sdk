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
