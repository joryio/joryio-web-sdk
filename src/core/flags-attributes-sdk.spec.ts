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
});
