import { JoryioSDK } from './sdk';
import { NetworkClient, SDK_AUTH_HEADER, STOREFRONT_IDENTITY_ISSUER, anonymousIdOfBody } from './network';
import { installLocalStorage, installFetch, BASE_CONFIG, settle } from './test-harness';

/**
 * Storefront identity token (D383): Joryio-signed, bound to ONE visitor id
 * (`vid`). The SDK attaches it to anonymous requests only, only while that
 * visitor id is the SDK's own, never after reset(); a refusal refreshes
 * (expired) or drops it.
 */
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sfToken = (vid: string, opts: { expInS?: number; tag?: string } = {}) =>
  `${b64({ alg: 'ES256', kid: 'k' })}.${b64({
    iss: STOREFRONT_IDENTITY_ISSUER,
    vid,
    sub: 'contact-1',
    exp: Math.floor(Date.now() / 1000) + (opts.expInS ?? 900),
    jti: opts.tag ?? 'j1',
  })}.sig`;

const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const api = 'https://api.example';

describe('NetworkClient - storefront identity token', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  const make = (anon: { id: string | null }) => {
    const c = new NetworkClient('jry_sdk_test', stubLogger, { maxRetries: 0, backoffMs: 0 });
    c.setAnonymousIdSource(() => anon.id);
    return c;
  };

  it('attaches the token to an anonymous request of its own visitor only', async () => {
    const anon = { id: 'jry_vis_A' };
    const c = make(anon);
    c.setStorefrontIdentityToken(sfToken('jry_vis_A'));
    const calls = installFetch();
    await c.sendEvents(api, [{ type: 'X', anonymousId: 'jry_vis_A' }]);
    expect(calls[0].init.headers[SDK_AUTH_HEADER]).toBe(sfToken('jry_vis_A'));
  });

  it('never on an identified request', async () => {
    const c = make({ id: 'jry_vis_A' });
    c.setCurrentUserId('u1');
    c.setStorefrontIdentityToken(sfToken('jry_vis_A'));
    const calls = installFetch();
    await c.sendEvents(api, [{ type: 'X', userId: 'u1', anonymousId: 'jry_vis_A' }]);
    expect(calls[0].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
  });

  it('never when the token names another visitor (current id or the body)', async () => {
    const anon = { id: 'jry_vis_B' };
    const c = make(anon);
    c.setStorefrontIdentityToken(sfToken('jry_vis_A'));
    const calls = installFetch();
    await c.sendEvents(api, [{ type: 'X', anonymousId: 'jry_vis_B' }]);
    expect(calls[0].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
    // Current visitor matches, but a leftover of another visitor in the body does not.
    anon.id = 'jry_vis_A';
    await c.sendEvents(api, [{ type: 'X', anonymousId: 'jry_vis_OLD' }]);
    expect(calls[1].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
  });

  it('an expiring token is not sent; the provider is asked for a fresh one', async () => {
    const c = make({ id: 'jry_vis_A' });
    c.setStorefrontIdentityToken(sfToken('jry_vis_A', { expInS: 5 }));
    const provider = jest.fn(async () => sfToken('jry_vis_A', { tag: 'fresh' }));
    c.setStorefrontIdentityTokenProvider(provider);
    const calls = installFetch();
    await c.sendEvents(api, [{ type: 'X', anonymousId: 'jry_vis_A' }]);
    expect(calls[0].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
    await settle(5);
    expect(provider).toHaveBeenCalledTimes(1);
    await c.sendEvents(api, [{ type: 'Y', anonymousId: 'jry_vis_A' }]);
    expect(calls[1].init.headers[SDK_AUTH_HEADER]).toBe(sfToken('jry_vis_A', { tag: 'fresh' }));
  });

  it('a 401 expired refreshes and retries once; any other refusal drops the token and retries without it', async () => {
    const c = make({ id: 'jry_vis_A' });
    c.setStorefrontIdentityToken(sfToken('jry_vis_A', { tag: 'old' }));
    c.setStorefrontIdentityTokenProvider(async () => sfToken('jry_vis_A', { tag: 'new' }));
    let n = 0;
    const calls = installFetch(() =>
      ++n === 1 ? { status: 401, body: { error: 'storefront_identity_error', reason: 'expired' } } : { status: 200, body: { success: true } },
    );
    const res = await c.sendEvents(api, [{ type: 'X', anonymousId: 'jry_vis_A' }]);
    expect(res.ok).toBe(true);
    expect(calls.map((x) => x.init.headers[SDK_AUTH_HEADER])).toEqual([
      sfToken('jry_vis_A', { tag: 'old' }),
      sfToken('jry_vis_A', { tag: 'new' }),
    ]);

    n = 0;
    const calls2 = installFetch(() =>
      ++n === 1 ? { status: 401, body: { error: 'storefront_identity_error', reason: 'revoked' } } : { status: 200, body: { success: true } },
    );
    const res2 = await c.sendEvents(api, [{ type: 'Y', anonymousId: 'jry_vis_A' }]);
    expect(res2.ok).toBe(true);
    expect(calls2[0].init.headers[SDK_AUTH_HEADER]).toBeDefined();
    expect(calls2[1].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
  });

  it('refuses a token that is not a storefront identity token', () => {
    const c = make({ id: 'jry_vis_A' });
    c.setStorefrontIdentityToken(`${b64({ alg: 'ES256' })}.${b64({ sub: 'x', exp: 9e9 })}.s`);
    expect(c.getSdkAuthHeaders(null, 'jry_vis_A')).toEqual({});
  });

  it('anonymousIdOfBody: one visitor, never an identified body', () => {
    expect(anonymousIdOfBody({ events: [{ anonymousId: 'a' }, { anonymousId: 'a' }] })).toBe('a');
    expect(anonymousIdOfBody({ events: [{ anonymousId: 'a' }, { anonymousId: 'b' }] })).toBeNull();
    expect(anonymousIdOfBody({ userId: 'u', anonymousId: 'a' })).toBeNull();
  });
});

describe('JoryioSDK - storefront identity token', () => {
  beforeEach(() => {
    (JoryioSDK as any).instance = null;
    installLocalStorage();
  });
  afterEach(async () => {
    const s = JoryioSDK.getInstance();
    if (s) await s.destroy().catch(() => undefined);
    (JoryioSDK as any).instance = null;
    delete (globalThis as any).fetch;
  });

  it('carries the init token on the visitor\'s requests and drops it on reset()', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({
      ...BASE_CONFIG,
      trackSessionStart: false,
      anonymousId: 'jry_vis_STORE',
      storefrontIdentityToken: sfToken('jry_vis_STORE'),
    } as any);
    sdk.track('Before reset');
    await sdk.flush();
    const before = calls.filter((c) => c.path.endsWith('/v1/track/batch'));
    expect(before.length).toBeGreaterThan(0);
    expect(before[0].init.headers[SDK_AUTH_HEADER]).toBe(sfToken('jry_vis_STORE'));

    await sdk.reset();
    sdk.track('After reset');
    await sdk.flush();
    const after = calls.filter((c) => c.path.endsWith('/v1/track/batch') && c.body.events.some((e: any) => e.type === 'After reset'));
    expect(after.length).toBe(1);
    expect(after[0].init.headers[SDK_AUTH_HEADER]).toBeUndefined();
    // ...and it is not merely mismatched: the SDK no longer holds it.
    expect((sdk as any).network.storefrontToken).toBeUndefined();
  });
});
