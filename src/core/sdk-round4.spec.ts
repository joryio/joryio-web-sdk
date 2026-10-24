import { JoryioSDK } from './sdk';
import { SubscriptionStatus } from './user';
import { isWithdrawalRequest } from './network';
import { installLocalStorage, installFetch, BASE_CONFIG, RecordedRequest } from './test-harness';

/**
 * SDK 1.3.0 round 4 integration:
 *  - a logout keeps the outgoing user's token for that user's own leftovers
 *    (clearing it made every normal logout under SDK authentication drop the
 *    user's last events);
 *  - withdrawals go even while the workspace's ingestion is paused (owner
 *    decision 2026-10-06: the server accepts them from a suspended account).
 */

const resetSingleton = () => {
  (JoryioSDK as any).instance = null;
};

beforeEach(() => {
  resetSingleton();
  installLocalStorage();
});
afterEach(async () => {
  const s = JoryioSDK.getInstance();
  if (s) await s.destroy().catch(() => undefined);
  resetSingleton();
  delete (globalThis as any).fetch;
});

const authHeader = (c: RecordedRequest) => (c.init?.headers || {})['X-Joryio-Auth'];
const sub = (token: string | undefined) => (token ? token.replace(/^tok-/, '') : null);
const suspended = { status: 402, body: { code: 'SDK_INGESTION_SUSPENDED' } };

describe('logout keeps the outgoing user’s token for their own leftovers', () => {
  it("A's last events go out with A's token after reset(); the next visitor's never carry it", async () => {
    // The server's rule: an identified userId needs a token whose sub is that user.
    const calls = installFetch((req) => {
      const users = new Set<string>(
        [req.body?.userId, req.body?.identify?.userId, ...(req.body?.events || []).map((e: any) => e.userId)].filter(Boolean),
      );
      const token = sub((req.init?.headers || {})['X-Joryio-Auth']);
      if ([...users].some((u) => u !== token)) {
        return { status: 401, body: { error: 'sdk_authentication_error', reason: token ? 'sub_mismatch' : 'missing' } };
      }
      return { status: 200, body: { success: true, processed: req.body?.events?.length ?? 0, identified: true } };
    });
    const handler = jest.fn();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 'tok-A' } as any);
    sdk.setSdkAuthenticationErrorCallback(handler);
    (sdk as any).queue.setPaused(true);
    sdk.identify('A');
    sdk.track('A checked out');
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    (sdk as any).queue.setPaused(false);

    await sdk.reset();
    // The session no longer holds A's token...
    expect((sdk as any).network.getSdkAuthHeaders()).toEqual({});
    sdk.track('anonymous browsing');
    await sdk.flush();
    await sdk.flush();

    // ...but A's own leftovers carried it and were accepted.
    const aBatch = calls.find((c) => c.body?.events?.some((e: any) => e.type === 'A checked out'));
    expect(aBatch && authHeader(aBatch)).toBe('tok-A');
    expect(calls.filter((c) => c.path.endsWith('/v1/track/batch')).every((c) => c.body?.events?.every((e: any) => e.type !== 'A checked out') || authHeader(c) === 'tok-A')).toBe(true);
    // The anonymous visitor's batch carries no token at all.
    const anon = calls.find((c) => c.body?.events?.some((e: any) => e.type === 'anonymous browsing'));
    expect(anon && authHeader(anon)).toBeUndefined();
    expect(calls.some((c) => c.path.endsWith('/v1/subscriptions/channel') && c.body.userId === 'A' && authHeader(c) === 'tok-A')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect((sdk as any).queue.getQueuedEvents()).toHaveLength(0);
  });

  it('a user who signs back in gets the token the host sets, not the retired one', async () => {
    const calls = installFetch(() => ({ status: 200, body: { success: true, processed: 1, identified: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 'tok-A-old' } as any);
    sdk.identify('A');
    await sdk.flush();
    await sdk.reset();
    sdk.identify('A');
    sdk.setSdkAuthenticationToken('tok-A-new');
    sdk.track('back again');
    await sdk.flush();
    const batch = calls.find((c) => c.body?.events?.some((e: any) => e.type === 'back again'));
    expect(batch && authHeader(batch)).toBe('tok-A-new');
  });
});

describe('withdrawals pass a paused (402) workspace', () => {
  it('an unsubscribe and the opt-out marker are still sent after a 402 stopped event sending', async () => {
    const calls = installFetch((req) => (req.path.endsWith('/v1/track/batch') ? suspended : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.track('anything');
    await sdk.flush();
    expect((sdk as any).network.isSuspended()).toBe(true);

    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    sdk.user.setSubscription('sms', SubscriptionStatus.SUBSCRIBED);
    sdk.optOut();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));

    expect(calls.some((c) => c.path.endsWith('/v1/subscriptions/channel') && c.body.status === 'unsubscribed')).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/v1/attributes') && c.body.attributes?.tracking_opted_out === true)).toBe(true);
    // A subscribe is not a withdrawal: held while suspended.
    expect(calls.some((c) => c.path.endsWith('/v1/subscriptions/channel') && c.body.status === 'subscribed')).toBe(false);
  });

  it('isWithdrawalRequest matches the server predicate', () => {
    const api = 'https://api-eu1.joryio.com';
    expect(isWithdrawalRequest(`${api}/v1/push/unregister`, { token: 't' })).toBe(true);
    expect(isWithdrawalRequest(`${api}/v1/subscriptions/channel`, { status: 'unsubscribed' })).toBe(true);
    expect(isWithdrawalRequest(`${api}/v1/subscriptions/channel`, { status: 'optedIn' })).toBe(false);
    expect(isWithdrawalRequest(`${api}/v1/subscriptions/group`, { action: 'unsubscribe' })).toBe(true);
    expect(isWithdrawalRequest(`${api}/v1/subscriptions/group`, { action: 'subscribe' })).toBe(false);
    expect(isWithdrawalRequest(`${api}/v1/attributes`, { attributes: { tracking_opted_out: true } })).toBe(true);
    expect(isWithdrawalRequest(`${api}/v1/attributes`, { attributes: { tracking_opted_out: false } })).toBe(false);
    expect(isWithdrawalRequest(`${api}/v1/attributes`, { attributes: { tracking_opted_out: true, plan: 'x' } })).toBe(false);
    expect(isWithdrawalRequest(`${api}/v1/attributes`, { attributes: { tracking_opted_out: true }, increment: { n: 1 } })).toBe(false);
    expect(isWithdrawalRequest(`${api}/v1/track/batch`, { events: [] })).toBe(false);
  });
});

describe('one e-commerce guard set (the same table on every SDK)', () => {
  const P = { productId: 'p1', name: 'Buds', price: 10 };
  const L = { ...P, quantity: 1 };
  const refused: Array<[string, (e: any) => void]> = [
    ['viewProduct NaN price', (e) => e.viewProduct({ ...P, price: NaN })],
    ['viewProduct blank id', (e) => e.viewProduct({ ...P, productId: '   ' })],
    ['addToCart Infinity price', (e) => e.addToCart({ ...L, price: Infinity })],
    ['addToCart NaN cartValue', (e) => e.addToCart(L, NaN)],
    ['removeFromCart no id', (e) => e.removeFromCart({ ...P, productId: '' })],
    ['shareProduct blank method', (e) => e.shareProduct(P, ' ')],
    ['viewCategory no name', (e) => e.viewCategory('c1', '')],
    ['search blank query', (e) => e.search('  ')],
    ['addPaymentInfo no method', (e) => e.addPaymentInfo('')],
    ['cartViewed NaN total', (e) => e.cartViewed([L], NaN)],
    ['updateCart id-less line', (e) => e.updateCart([{ ...L, productId: '' }], 10)],
    ['startCheckout NaN line price', (e) => e.startCheckout([{ ...L, price: NaN }], 10)],
    ['purchase NaN shipping', (e) => e.purchase({ orderId: 'o1', items: [L], value: 10, shipping: NaN })],
    ['purchase bad line', (e) => e.purchase({ orderId: 'o1', items: [{ ...L, price: NaN }], value: 10 })],
    ['purchase blank order id', (e) => e.purchase({ orderId: ' ', items: [], value: 10 })],
    ['orderRefunded NaN amount', (e) => e.orderRefunded('o1', NaN)],
    ['applyCoupon NaN discount', (e) => e.applyCoupon('SAVE', NaN)],
    ['removeCoupon blank', (e) => e.removeCoupon(' ')],
  ];

  it.each(refused)('%s: a warning and nothing sent', (_name, call) => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    expect(() => call(sdk.ecommerce())).not.toThrow();
    expect((sdk as any).queue.getQueuedEvents()).toEqual([]);
  });

  it('the complete calls are sent, including an order with no items and optional amounts left out', () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const e = sdk.ecommerce();
    e.viewProduct(P);
    e.addToCart(L);
    e.cartViewed([L, null as any], 10);
    e.purchase({ orderId: 'o1', items: [], value: 10 });
    e.orderRefunded('o1');
    e.applyCoupon('SAVE');
    expect((sdk as any).queue.getQueuedEvents().map((x: any) => x.type)).toEqual([
      'Product Viewed', 'Product Added', 'Cart Viewed', 'Order Completed', 'Order Refunded', 'Coupon Applied',
    ]);
  });
});
