import { JoryioSDK } from './sdk';
import { resetToRefusal, rememberSignedInAnonymousId, SIGNED_IN_ANONYMOUS_IDS_MAX } from './reset-to';

/**
 * resetTo(anonymousId) (BACKLOG D366): reset(), then the caller's anonymous
 * id instead of a random one. The validation rule is the same on all five
 * SDKs (backend sdk-parity.spec.ts pins the pattern).
 */
describe('resetToRefusal', () => {
  it('accepts a UUID, a store tracker id and a prefixed hex id', () => {
    expect(resetToRefusal('0b9c6c1e-6f43-4f7a-9d2a-6f0b2c4d5e6f', [])).toBeNull();
    expect(resetToRefusal('jry_0b9c6c1e-6f43-4f7a-9d2a-6f0b2c4d5e6f', [])).toBeNull();
    expect(resetToRefusal('hp_abcdef0123456789', [])).toBeNull();
  });

  it('refuses too short, too long, odd characters and non-strings', () => {
    expect(resetToRefusal('short', [])).not.toBeNull();
    expect(resetToRefusal('a'.repeat(256), [])).not.toBeNull();
    expect(resetToRefusal('a'.repeat(255), [])).toBeNull();
    expect(resetToRefusal('has space in it', [])).not.toBeNull();
    expect(resetToRefusal('ada@example.com', [])).not.toBeNull();
    expect(resetToRefusal(undefined, [])).not.toBeNull();
    expect(resetToRefusal(12345678 as any, [])).not.toBeNull();
  });

  it('refuses the shape of a Joryio profile id and a known user id', () => {
    expect(resetToRefusal('65f1a2b3c4d5e6f708192a3b', [])).not.toBeNull();
    expect(resetToRefusal('customer-1042', ['customer-1042'])).not.toBeNull();
    expect(resetToRefusal('customer-1042', [null, 'someone-else'])).toBeNull();
  });

  it('refuses the anonymous id held while a user is signed in (shared device)', () => {
    expect(resetToRefusal('jry_alice-device-0001', ['alice'], 'jry_alice-device-0001')).not.toBeNull();
    expect(resetToRefusal('jry_alice-device-0001', [null], null)).toBeNull();
  });
});

describe('JoryioSDK.resetTo', () => {
  let sdk: JoryioSDK;
  const makeSdk = () => {
    const instance = new JoryioSDK({
      sdkKey: 'jry_sdk_test',
      trackSessionStart: false,
      trackPageViews: false,
      persistQueue: false,
      inApp: { enabled: false },
    });
    (instance as any).queue.stop();
    (instance as any).queue.flush = async () => {};
    return instance;
  };
  afterEach(async () => {
    if (sdk) await sdk.destroy();
  });

  it('logs the user out and adopts the given anonymous id, synchronously', () => {
    sdk = makeSdk();
    sdk.identify('user-a');
    const done = sdk.resetTo('jry_tracker-visitor-0001');
    // Before anything is awaited, like reset(): an identify on the next line uses the new id.
    expect(sdk.getUserId()).toBeNull();
    expect(sdk.getAnonymousId()).toBe('jry_tracker-visitor-0001');
    return done.then((adopted) => {
      expect(adopted).toBe(true);
      expect(sdk.getAnonymousId()).toBe('jry_tracker-visitor-0001');
      // Persisted: what another tab or the next page reads.
      expect((sdk as any).storage.get('anonymous_id')).toBe('jry_tracker-visitor-0001');
    });
  });

  it('does everything reset() does: the session and the SDK auth token go too', async () => {
    sdk = makeSdk();
    sdk.identify('user-a');
    const session = (sdk as any).session.getSessionId();
    const retire = jest.spyOn((sdk as any).network, 'retireSdkAuthToken');
    await sdk.resetTo('jry_tracker-visitor-0002');
    expect(retire).toHaveBeenCalled();
    expect((sdk as any).session.getSessionId()).not.toBe(session);
  });

  it('a refused id (the signed-in user id) is a plain reset(): logged out, random id', async () => {
    sdk = makeSdk();
    sdk.identify('customer-1042');
    const before = sdk.getAnonymousId();
    expect(await sdk.resetTo('customer-1042')).toBe(false);
    expect(sdk.getUserId()).toBeNull();
    expect(sdk.getAnonymousId()).not.toBe('customer-1042');
    expect(sdk.getAnonymousId()).not.toBe(before);
  });

  it('a malformed id is a plain reset() too', async () => {
    sdk = makeSdk();
    expect(await sdk.resetTo('bad id')).toBe(false);
    expect(sdk.getAnonymousId()).not.toBe('bad id');
    expect(sdk.getAnonymousId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses the anonymous id the signed-in user had: the next person must not inherit their profile', async () => {
    sdk = makeSdk();
    await sdk.resetTo('jry_alice-device-0001');
    sdk.identify('alice');
    expect(await sdk.resetTo('jry_alice-device-0001')).toBe(false);
    expect(sdk.getUserId()).toBeNull();
    expect(sdk.getAnonymousId()).not.toBe('jry_alice-device-0001');
  });

  it('refuses an anonymous id a signed-in user held before an earlier reset', async () => {
    sdk = makeSdk();
    await sdk.resetTo('jry_alice-device-0001');
    sdk.identify('alice');
    await sdk.reset();
    expect(await sdk.resetTo('jry_alice-device-0001')).toBe(false);
    expect(sdk.getAnonymousId()).not.toBe('jry_alice-device-0001');
  });

  it('remembers the newest 20, and wipeData forgets them', async () => {
    let list: string[] = [];
    for (let i = 1; i <= 25; i++) list = rememberSignedInAnonymousId(list, `jry_device-${String(i).padStart(4, '0')}`);
    expect(SIGNED_IN_ANONYMOUS_IDS_MAX).toBe(20);
    expect(list).toHaveLength(20);
    expect(list[0]).toBe('jry_device-0006');
    expect(list[19]).toBe('jry_device-0025');
    expect(rememberSignedInAnonymousId(['jry_device-b', 'jry_device-a'], 'jry_device-b')).toEqual(['jry_device-a', 'jry_device-b']);

    sdk = makeSdk();
    await sdk.resetTo('jry_alice-device-0002');
    sdk.identify('alice');
    await sdk.reset();
    await sdk.wipeData();
    expect(await sdk.resetTo('jry_alice-device-0002')).toBe(true);
  });
});
