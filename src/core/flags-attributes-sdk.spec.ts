import { JoryioSDK } from './sdk';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, settle, RecordedRequest } from './test-harness';

/**
 * 1.4.0-beta.9 test: the web flags request sent `attributes: {}` while iOS and
 * Android send the attributes set on the device, so an attribute rule never
 * matched on the web. The same keys and values now go on the web.
 */
let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];

beforeEach(() => {
  installLocalStorage();
  calls = installFetch((req) => {
    if (req.path.endsWith('/v1/flags/evaluate')) return { status: 200, body: { flags: {}, etag: 'e', ttlSeconds: 300 } };
    return { status: 200, body: { success: true } };
  });
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location: { href: 'https://shop.example/', origin: 'https://shop.example', pathname: '/', search: '' }, ...listeners };
  (globalThis as any).document = { referrer: '', readyState: 'complete', visibilityState: 'visible', ...listeners };
});

afterEach(async () => {
  if (sdk) await sdk.destroy();
  sdk = null;
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

const evaluates = () => calls.filter((c) => c.path.endsWith('/v1/flags/evaluate'));

describe('flags carry the attributes set on this device', () => {
  it('setAttributes, then a flag read: /v1/flags/evaluate carries them as set', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    sdk.setAttributes({ plan: 'pro', tier: 'gold', country: 'IL', seats: 3 });
    await sdk.refreshFlags();
    const body = evaluates().pop()!.body;
    expect(body.attributes).toEqual({ plan: 'pro', tier: 'gold', country: 'IL', seats: 3 });
    // Byte for byte: a whole number stays a whole number on the wire.
    expect(JSON.stringify(body.attributes)).toContain('"seats":3}');
  });

  it('an unset attribute leaves; reset() clears them all', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    sdk.setAttributes({ plan: 'pro', tier: 'gold' });
    sdk.setAttributes({ tier: null });
    await sdk.refreshFlags();
    expect(evaluates().pop()!.body.attributes).toEqual({ plan: 'pro' });
    await sdk.reset();
    await sdk.refreshFlags();
    await settle(50);
    expect(evaluates().pop()!.body.attributes).toEqual({});
  });

  /**
   * 1.4.0-beta.10 test: identify(A) + setAttributes, then identify(B) of a
   * DIFFERENT user: B's first evaluate carried A's attributes, and A's `seats` /
   * `ratio` stayed in all of B's. As on iOS: B starts with none, then only B's
   * own; the same user again keeps them; reset() clears them.
   */
  it('identify of a different user drops the previous user\'s attributes before any request for them', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    sdk.identify('user-a');
    sdk.setAttributes({ plan: 'pro', seats: 10, ratio: 2.5 });
    await sdk.refreshFlags();
    expect(evaluates().pop()!.body.attributes).toEqual({ plan: 'pro', seats: 10, ratio: 2.5 });

    const before = calls.length;
    sdk.identify('user-b');
    await settle(20);
    const firstForB = evaluates().find((c) => calls.indexOf(c) >= before && c.body.userId === 'user-b');
    expect(firstForB?.body.attributes).toEqual({});
    sdk.setAttributes({ plan: 'free' });
    await sdk.refreshFlags();
    expect(evaluates().pop()!.body.attributes).toEqual({ plan: 'free' });
    // No request made for B carries any of A's attributes.
    for (const c of calls.slice(before)) {
      const body: any = c.body;
      if (!body || body.userId !== 'user-b') continue;
      for (const bag of [body.attributes, body.userAttributes].filter(Boolean)) {
        expect(Object.keys(bag)).not.toContain('seats');
        expect(Object.keys(bag)).not.toContain('ratio');
      }
    }

    // The same user again: kept.
    sdk.identify('user-b');
    await sdk.refreshFlags();
    expect(evaluates().pop()!.body.attributes).toEqual({ plan: 'free' });
  });
});
