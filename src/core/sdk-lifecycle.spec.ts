import { JoryioSDK } from './sdk';
import {
  BASE_CONFIG,
  installFetch,
  installLocalStorage,
  uninstallLocalStorage,
  settle,
  waitFor,
  RecordedRequest,
} from './test-harness';
import { resolveConfig, MIN_INAPP_SYNC_INTERVAL } from './config';

/**
 * Page unload, reset(), identify() re-sync and the config options that used to
 * do nothing (review findings 3, 8, 14, 15; contract items 6, 11).
 */

let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
const paths = () => calls.map((c) => c.path);

beforeEach(() => {
  installLocalStorage();
  calls = installFetch();
});

afterEach(async () => {
  if (sdk) await sdk.destroy();
  sdk = null;
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
});

describe('page unload', () => {
  it('hands events to fetch keepalive - credentials omitted, SDK auth header kept - not sendBeacon', () => {
    const beacon = jest.fn(() => true);
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: beacon }, configurable: true });
    try {
      sdk = new JoryioSDK({
        ...BASE_CONFIG,
        trackSessionStart: false,
        userId: 'user-1',
        enableSdkAuthentication: true,
        sdkAuthenticationToken: 'jwt-1',
      });
      (sdk as any).queue.stop(); // keep the timer from flushing first
      sdk.track('Checkout Started');
      (sdk as any).handlePageUnload();
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    }

    expect(beacon).not.toHaveBeenCalled();
    const req = calls.find((c) => c.path === '/api/v1/track/batch')!;
    expect(req.init.keepalive).toBe(true);
    expect(req.init.credentials).toBe('omit');
    expect(req.init.headers['X-Joryio-Auth']).toBe('jwt-1');
    expect(req.init.headers['X-SDK-Key']).toBe('jry_sdk_test');
    expect(req.body.events.map((e: any) => e.type)).toEqual(['Checkout Started']);
    // Handed off -> no longer held.
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });

  it('keeps what does not fit the 64 KiB keepalive budget (only the hand-off is cleared)', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, batchSize: 1000 });
    (sdk as any).queue.stop();
    for (let i = 0; i < 40; i++) sdk.track('Big', { blob: 'x'.repeat(4000) });
    (sdk as any).handlePageUnload();
    const sent = calls.find((c) => c.path === '/api/v1/track/batch')!.body.events.length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(40);
    expect((sdk as any).queue.getQueueSize()).toBe(40 - sent);
  });

  it('keeps the pending identify and everything when keepalive is unavailable', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    (sdk as any).queue.stop();
    (sdk as any).queue.setPaused(true); // hold the identify flush
    sdk.identify('user-1');
    sdk.track('X');
    (sdk as any).queue.setPaused(false);
    (sdk as any).network.supportsKeepalive = () => false;
    (sdk as any).handlePageUnload();
    expect(calls).toEqual([]);
    expect((sdk as any).queue.getQueueSize()).toBe(1);
    expect((sdk as any).queue.getPendingIdentify()?.userId).toBe('user-1');
  });

  it('takes the events back if the hand-off fails and the page is still alive', async () => {
    calls = installFetch((req) => (req.path === '/api/v1/track/batch' ? { status: 503, body: {} } : { status: 200, body: {} }));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    (sdk as any).queue.stop();
    sdk.track('Y');
    (sdk as any).handlePageUnload();
    await settle(10);
    expect((sdk as any).queue.getQueueSize()).toBe(1);
  });
});

describe('reset()', () => {
  it("moves to a new identity at once; the previous user's pending writes keep THEIR ids (contract items 28, 37)", async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-a');
    await sdk.flush();
    const anonBefore = sdk.getAnonymousId();
    sdk.setAttributes({ plan: 'pro' });
    expect((sdk as any).attributeFlushTimer).not.toBeNull();

    await sdk.reset();

    expect(sdk.getUserId()).toBeNull();
    expect(sdk.getAnonymousId()).not.toBe(anonBefore);
    // The outgoing user's write is not lost, and goes out under THEIR ids.
    await waitFor(() => paths().includes('/api/v1/attributes'));
    const attrs = calls.filter((c) => c.path === '/api/v1/attributes');
    expect(attrs).toHaveLength(1);
    expect(attrs[0].body.userId).toBe('user-a');
    expect(attrs[0].body.anonymousId).toBeUndefined();
    await waitFor(() => (sdk as any).identity.pending.isEmpty());
    // And nothing more arrives later under the new identity.
    calls.length = 0;
    await settle(900);
    expect(paths()).not.toContain('/api/v1/attributes');
  });

  it('re-registers the push subscription under the new identity and re-syncs in-app', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, inApp: { enabled: true } });
    const pushSync = jest.spyOn((sdk as any)._push, 'syncExistingSubscription');
    await waitFor(() => paths().includes('/api/v1/in-app/sync'));
    const syncsBefore = calls.filter((c) => c.path === '/api/v1/in-app/sync').length;

    await sdk.reset();

    expect(pushSync).toHaveBeenCalledWith(true);
    await waitFor(() => calls.filter((c) => c.path === '/api/v1/in-app/sync').length > syncsBefore);
    const last = calls.filter((c) => c.path === '/api/v1/in-app/sync').pop()!;
    expect(last.body.anonymousId).toBe(sdk.getAnonymousId());
    expect(last.body.userId).toBeUndefined();
  });
});

describe('identify() in a single-page app', () => {
  it('re-syncs in-app campaigns for the newly identified user', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, inApp: { enabled: true } });
    await waitFor(() => paths().includes('/api/v1/in-app/sync'));
    sdk.identify('user-spa');
    await waitFor(() => calls.some((c) => c.path === '/api/v1/in-app/sync' && c.body.userId === 'user-spa'));
  });
});

describe('in-app requests identify the visitor by ids, never by email', () => {
  it('sends anonymousId (and userId once identified) - no externalId from the email attribute', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, inApp: { enabled: true } });
    await waitFor(() => paths().includes('/api/v1/in-app/sync'));
    sdk.setAttributes({ email: 'ada@example.com' });
    await sdk.syncInAppCampaigns();
    const last = calls.filter((c) => c.path === '/api/v1/in-app/sync').pop()!;
    expect(last.body.externalId).toBeUndefined();
    expect(last.body.anonymousId).toBe(sdk.getAnonymousId());
  });
});

const drain = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('config options that used to do nothing', () => {
  it('requestTimeout reaches the network client and the in-app manager', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, requestTimeout: 4321 });
    expect((sdk as any).network.retryConfig.timeoutMs).toBe(4321);
    expect((sdk as any).inapp.runtime.requestTimeoutMs).toBe(4321);
  });

  it('logLevel turns the logger on at that level', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, logLevel: 'error' });
    sdk.track('');
    expect(errorSpy).toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('disablePlugins is gone (warned about, not silently ignored)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolved: any = resolveConfig({ sdkKey: 'jry_sdk_x', disablePlugins: ['a'] } as any);
    expect(resolved.disablePlugins).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('disablePlugins'))).toBe(true);
    warn.mockRestore();
  });

  it('maxRetries: 0 is honoured (`||` used to turn it back into 3)', () => {
    expect(resolveConfig({ sdkKey: 'jry_sdk_x', maxRetries: 0 }).maxRetries).toBe(0);
    expect(resolveConfig({ sdkKey: 'jry_sdk_x' }).maxRetries).toBe(3);
  });

  it('inApp.syncInterval is off by default and clamped to a minimum when set', () => {
    expect(resolveConfig({ sdkKey: 'jry_sdk_x' }).inApp.syncInterval).toBe(0);
    expect(resolveConfig({ sdkKey: 'jry_sdk_x', inApp: { syncInterval: 50 } }).inApp.syncInterval).toBe(
      MIN_INAPP_SYNC_INTERVAL,
    );
  });

  it('inApp.syncInterval runs a real periodic sync; session-start-only does not', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const make = (evaluationMode: 'differential-sync' | 'session-start-only') =>
        new JoryioSDK({
          ...BASE_CONFIG,
          trackSessionStart: false,
          inApp: { enabled: true, syncInterval: 30_000, evaluationMode },
        });

      sdk = make('differential-sync');
      await drain();
      const syncs = () => calls.filter((c) => c.path === '/api/v1/in-app/sync').length;
      const first = syncs();
      jest.advanceTimersByTime(30_000);
      await drain();
      expect(syncs()).toBe(first + 1);
      await sdk.destroy();

      sdk = make('session-start-only');
      await drain();
      const second = syncs();
      jest.advanceTimersByTime(90_000);
      await drain();
      expect(syncs()).toBe(second);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Real timers and real debounce windows; generous under a loaded CI machine.
jest.setTimeout(30_000);
