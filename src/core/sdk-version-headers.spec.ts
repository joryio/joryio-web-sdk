import { JoryioSDK } from './sdk';
import {
  BASE_CONFIG,
  installFetch,
  installLocalStorage,
  uninstallLocalStorage,
  waitFor,
  RecordedRequest,
} from './test-harness';
import { SDK_VERSION } from './config';

/**
 * D427: every request names the SDK and its version, so Settings > Apps can
 * show which version an app runs. Same wire names on all five SDKs (the
 * backend's sdk-version-parity spec greps them); the web SDK has no bridge,
 * so it never sends the wrapper headers.
 */
let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];

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

function expectIdentity(req: RecordedRequest) {
  expect(req.init.headers['X-Joryio-SDK']).toBe('web');
  expect(req.init.headers['X-Joryio-SDK-Version']).toBe(SDK_VERSION);
  expect(req.init.headers['X-Joryio-SDK-Wrapper']).toBeUndefined();
}

describe('SDK version headers', () => {
  it('ride the event batch and the in-app sync', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, inApp: { enabled: true } });
    await waitFor(() => calls.some((c) => c.path === '/api/v1/in-app/sync'));
    sdk.track('Viewed');
    await sdk.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/track/batch'));
    expect(calls.length).toBeGreaterThan(1);
    calls.forEach(expectIdentity);
  });

  it('ride the keepalive hand-off at page unload', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    (sdk as any).queue.stop();
    sdk.track('Leaving');
    (sdk as any).handlePageUnload();
    const req = calls.find((c) => c.path === '/api/v1/track/batch')!;
    expect(req.init.keepalive).toBe(true);
    expectIdentity(req);
  });
});
