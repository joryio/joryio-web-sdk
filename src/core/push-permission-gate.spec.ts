import { JoryioSDK } from './sdk';
import { StorageManager } from './storage';
import { resolveConfig } from './config';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor, RecordedRequest } from './test-harness';

/**
 * `push_permission` is reported only when this site uses web push.
 *
 * It used to be written on every init, so a site with web push off (the
 * WordPress plugin with only in-app on) spent a /v1/attributes request on
 * every new visitor - and, for an anonymous visitor the SDK sends nothing
 * else for, created an empty profile.
 */

const resetSingleton = () => {
  (JoryioSDK as any).instance = null;
};

const permissionWrites = (calls: RecordedRequest[]) =>
  calls.filter((c) => c.path.endsWith('/v1/attributes') && c.body?.attributes?.push_permission !== undefined);

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

let sdk: JoryioSDK | null = null;
beforeEach(() => {
  resetSingleton();
  installLocalStorage();
});
afterEach(async () => {
  if (sdk) await sdk.destroy().catch(() => undefined);
  sdk = null;
  resetSingleton();
  jest.restoreAllMocks();
  delete (globalThis as any).fetch;
});

describe('push_permission is reported only when the site uses web push', () => {
  it('webPush unset, a browser that never used push: nothing is sent', async () => {
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await settle(900);
    expect(permissionWrites(calls)).toHaveLength(0);
    // Nothing at all: on this page the SDK had no other reason to write.
    expect(calls.some((c) => c.path.endsWith('/v1/attributes'))).toBe(false);
  });

  it('webPush: false: nothing is sent', async () => {
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, webPush: false });
    await settle(900);
    expect(permissionWrites(calls)).toHaveLength(0);
  });

  it('webPush: true: reported on init, with the shared wire value', async () => {
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, webPush: true });
    await waitFor(() => permissionWrites(calls).length > 0);
    // No Notification API in the test environment.
    expect(permissionWrites(calls)[0].body.attributes.push_permission).toBe('unavailable');
  });

  it('webPush: true: the change detection still holds - not re-sent once acknowledged', async () => {
    let calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, webPush: true });
    await waitFor(() => permissionWrites(calls).length > 0);
    await settle(50);
    await sdk.destroy();
    resetSingleton();

    calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, webPush: true });
    await settle(900);
    expect(permissionWrites(calls)).toHaveLength(0);
  });

  it('webPush unset: push.subscribe() turns reporting on, now and on later page loads', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await settle(300);
    expect(permissionWrites(calls)).toHaveLength(0);

    jest.spyOn((sdk as any)._push, 'getPermissionState').mockReturnValue('denied');
    await sdk.push.subscribe();
    await waitFor(() => permissionWrites(calls).some((c) => c.body.attributes.push_permission === 'denied'));
    await settle(50);
    await sdk.destroy();
    resetSingleton();

    // Next page view: the visitor re-allowed notifications in the browser's
    // settings. The site uses push, so the change is reported on load.
    calls = installFetch();
    const PushManagerClass = (sdk as any)._push.constructor;
    jest.spyOn(PushManagerClass.prototype, 'getPermissionState').mockReturnValue('granted');
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await waitFor(() => permissionWrites(calls).some((c) => c.body.attributes.push_permission === 'granted'));
  });

  it('webPush unset: a browser an earlier SDK version registered for push is reported', async () => {
    const probe = new StorageManager(BASE_CONFIG.sdkKey, quietLogger);
    probe.set('push_registration', { endpoint: 'https://push.example/1', userId: null, anonymousId: 'a', at: Date.now() });
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await waitFor(() => permissionWrites(calls).length > 0);
  });

  it('webPush: false overrides an earlier use on page load, but a subscribe() on the page still reports', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const probe = new StorageManager(BASE_CONFIG.sdkKey, quietLogger);
    probe.set('push_in_use', true);
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, webPush: false });
    await settle(600);
    expect(permissionWrites(calls)).toHaveLength(0);

    await sdk.push.subscribe();
    await waitFor(() => permissionWrites(calls).length > 0);
  });

  it('webPush unset: a successful push.prepare() (a primer about to ask) reports', async () => {
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await settle(300);
    expect(permissionWrites(calls)).toHaveLength(0);

    const push = (sdk as any)._push;
    jest.spyOn(push, 'isSupported').mockReturnValue(true);
    jest.spyOn(push, 'getPermissionState').mockReturnValue('notDetermined');
    jest.spyOn(push, 'fetchVapidPublicKey').mockResolvedValue('BPublicKey');
    const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) } },
    });
    try {
      expect(await sdk.push.prepare()).toBe(true);
    } finally {
      if (hadNavigator) Object.defineProperty(globalThis, 'navigator', hadNavigator);
      else delete (globalThis as any).navigator;
    }
    await waitFor(() => permissionWrites(calls).some((c) => c.body.attributes.push_permission === 'not_determined'));
  });

  it('a prepare() that fails (web push off for the workspace) does not turn reporting on', async () => {
    const calls = installFetch();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    const push = (sdk as any)._push;
    jest.spyOn(push, 'isSupported').mockReturnValue(true);
    jest.spyOn(push, 'fetchVapidPublicKey').mockResolvedValue(null);
    expect(await sdk.push.prepare()).toBe(false);
    await settle(600);
    expect(permissionWrites(calls)).toHaveLength(0);
    expect(push.usedOnThisPage()).toBe(false);
  });
});

describe('resolveConfig: webPush', () => {
  it('keeps unset distinct from false', () => {
    expect(resolveConfig({ sdkKey: 'k' }).webPush).toBeUndefined();
    expect(resolveConfig({ sdkKey: 'k', webPush: false }).webPush).toBe(false);
    expect(resolveConfig({ sdkKey: 'k', webPush: true }).webPush).toBe(true);
  });
});
