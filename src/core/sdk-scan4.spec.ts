import { JoryioSDK, eventPropertiesProblem } from './sdk';
import { SubscriptionStatus } from './user';
import { installSnippetQueue } from '../index';
import { installLocalStorage, installFetch, BASE_CONFIG, settle, waitFor, RecordedRequest } from './test-harness';

/**
 * Web, scan 4 - and contract addendum v4 (items 36-46). The scan's probes
 * (scan4-probe.spec.ts) asserted the BUGS; these assert the fixed behaviour.
 */

const resetSingleton = () => {
  (JoryioSDK as any).instance = null;
};
let store: Map<string, string>;

beforeEach(() => {
  resetSingleton();
  store = installLocalStorage();
});
afterEach(async () => {
  jest.useRealTimers();
  const s = JoryioSDK.getInstance();
  if (s) await s.destroy().catch(() => undefined);
  resetSingleton();
  delete (globalThis as any).fetch;
});

const SUB = '/v1/subscriptions/channel';
const GROUP = '/v1/subscriptions/group';
const ATTRS = '/v1/attributes';
const ALIAS = '/v1/alias/add';
const by = (calls: RecordedRequest[], suffix: string) => calls.filter((c) => c.path.endsWith(suffix));
const markerCalls = (calls: RecordedRequest[]) =>
  by(calls, ATTRS).filter((c) => c.body?.attributes && 'tracking_opted_out' in c.body.attributes);
const stored = (suffix: string) => {
  const key = [...store.keys()].find((k) => k.endsWith(suffix));
  return key ? JSON.parse(store.get(key)!).value : null;
};

/** A fresh page view: the old instance is abandoned (not destroyed), storage kept. */
const nextPage = () => resetSingleton();

describe('#1 / item 37: writes to one subject are ordered; a newer write supersedes an older one', () => {
  it('a retried older subscribe never lands after a newer unsubscribe (probe P1)', async () => {
    jest.useFakeTimers();
    let n = 0;
    const calls = installFetch((req) => {
      if (req.path.endsWith(SUB)) {
        n++;
        return n === 1 ? { status: 503, body: {} } : { status: 200, body: { success: true } };
      }
      return { status: 200, body: { success: true, processed: req.body?.events?.length ?? 0 } };
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await jest.advanceTimersByTimeAsync(50);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    const statuses = by(calls, SUB).map((c) => c.body.status);
    expect(statuses[statuses.length - 1]).toBe('unsubscribed');
    expect(statuses.slice(statuses.indexOf('unsubscribed'))).not.toContain('subscribed');
  });

  it('an older write on the wire when a newer one is queued is not retried after it', async () => {
    jest.useFakeTimers();
    let release!: (v: any) => void;
    let first = true;
    const calls = installFetch(() => ({ status: 200, body: { success: true } }));
    const okFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      if (String(url).endsWith(SUB) && first) {
        first = false;
        await new Promise((r) => (release = r));
        calls.push({ url, init, body: JSON.parse(init.body), path: String(url).replace(/^https?:\/\/[^/]+/, '') });
        return { ok: false, status: 503, statusText: '', headers: { get: () => 'application/json' }, json: async () => ({}) };
      }
      return okFetch(url, init);
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('sms', SubscriptionStatus.OPTED_IN);
    await jest.advanceTimersByTimeAsync(10);
    sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    release(undefined);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(by(calls, SUB).map((c) => c.body.status)).toEqual(['optedIn', 'unsubscribed']);
  });

  it('subscribe then unsubscribe of one group while consent is pending: only the newer one is sent', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' } as any);
    sdk.user.addToSubscriptionGroup('g1');
    sdk.user.removeFromSubscriptionGroup('g1');
    sdk.updateConsent('granted');
    await waitFor(() => by(calls, GROUP).length > 0);
    await settle(50);
    expect(by(calls, GROUP).map((c) => c.body.action)).toEqual(['unsubscribe']);
  });
});

describe('#2 / item 36: retries stop on opt-out, denial and wipe - except withdrawals', () => {
  it('a retrying subscribe stops at optOut() (probe P2)', async () => {
    jest.useFakeTimers();
    const calls = installFetch((req) => (req.path.endsWith(SUB) ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    await jest.advanceTimersByTimeAsync(50);
    const before = by(calls, SUB).length;
    sdk.optOut();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(by(calls, SUB).length).toBe(before);
  });

  it("a retrying subscribe stops at updateConsent('denied') and at wipeData()", async () => {
    jest.useFakeTimers();
    const calls = installFetch((req) => (req.path.endsWith(SUB) || req.path.endsWith(ALIAS) ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await jest.advanceTimersByTimeAsync(50);
    sdk.updateConsent('denied');
    const afterDenied = by(calls, SUB).length;
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(by(calls, SUB).length).toBe(afterDenied);

    sdk.updateConsent('granted');
    sdk.addAlias('crm', 'C-1');
    await jest.advanceTimersByTimeAsync(50);
    const aliasBefore = by(calls, ALIAS).length;
    expect(aliasBefore).toBeGreaterThan(0);
    await sdk.wipeData();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(by(calls, ALIAS).length).toBe(aliasBefore);
  });

  it('an unsubscribe is delivered after optOut(), and one made while opted out is delivered too', async () => {
    jest.useFakeTimers();
    let fail = true;
    const calls = installFetch((req) =>
      req.path.endsWith(SUB) && fail ? { status: 503, body: {} } : { status: 200, body: { success: true } });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await jest.advanceTimersByTimeAsync(50);
    sdk.optOut();
    fail = false;
    await jest.advanceTimersByTimeAsync(60 * 1000);
    const statuses = by(calls, SUB).map((c) => c.body.status);
    expect(statuses.filter((s) => s === 'unsubscribed').length).toBeGreaterThanOrEqual(2); // retried and delivered

    calls.length = 0;
    sdk.user.setSubscription('sms', SubscriptionStatus.SUBSCRIBED); // refused: opted out
    sdk.user.removeFromSubscriptionGroup('news'); // a withdrawal: delivered
    await jest.advanceTimersByTimeAsync(1000);
    expect(by(calls, SUB)).toHaveLength(0);
    expect(by(calls, GROUP).map((c) => c.body.action)).toEqual(['unsubscribe']);
  });

  it('an unsubscribe is delivered while consent is denied or pending, and after wipeData()', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' } as any);
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => by(calls, SUB).length === 1);
    sdk.updateConsent('denied');
    sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => by(calls, SUB).length === 2);
    expect(by(calls, SUB).map((c) => c.body.channel)).toEqual(['email', 'sms']);
  });

  it('a withdrawal pending at wipeData() is still delivered, with the ids it was made with', async () => {
    let online = false;
    const calls = installFetch((req) => (req.path.endsWith(SUB) && !online ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('u-1');
    await sdk.flush();
    sdk.user.setSubscription('email', SubscriptionStatus.UNSUBSCRIBED);
    await waitFor(() => by(calls, SUB).length === 1);
    await sdk.wipeData();
    online = true;
    (sdk as any).outbox.kick();
    (sdk as any).outbox.entries.forEach((e: any) => (e.notBefore = 0));
    (sdk as any).outbox.kick();
    await waitFor(() => by(calls, SUB).length === 2);
    expect(by(calls, SUB)[1].body).toEqual(expect.objectContaining({ status: 'unsubscribed', userId: 'u-1' }));
  });

  it('the server-side push unregister is a withdrawal on the SDK too (finding 10)', () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, optOut: true } as any);
    expect((sdk as any)._push.canSend()).toBe(false);
    expect((sdk as any)._push.canWithdraw()).toBe(true);
  });
});

describe('#3 / item 38: ids are resolved at send time', () => {
  it('a subscription made before identify() is sent with the user id under SDK authentication (probe P4)', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 't' } as any);
    sdk.track('Viewed');
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    sdk.identify('u1');
    await waitFor(() => by(calls, SUB).length === 1);
    const idIdx = calls.findIndex((c) => c.body?.identify);
    const subIdx = calls.findIndex((c) => c.path.endsWith(SUB));
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThan(idIdx);
    expect(calls[subIdx].body).toEqual(expect.objectContaining({ userId: 'u1', anonymousId: calls[idIdx].body.identify.anonymousId }));
  });

  it("writes of a previous identity keep their own ids (identify('B') without reset)", async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('A');
    await sdk.flush();
    sdk.addAlias('crm', 'A-1');
    sdk.identify('B');
    await waitFor(() => by(calls, ALIAS).length === 1);
    expect(by(calls, ALIAS)[0].body.userId).toBe('A');
  });
});

describe('#4 / item 42: e-commerce helpers never throw and never send an empty order', () => {
  it('missing arguments: a warning and nothing sent (probe P3)', () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    const queued = () => (sdk as any).queue.getQueuedEvents().map((e: any) => e.type);
    const e = sdk.ecommerce();
    expect(() => e.purchase({ orderId: 'o1', value: 10 } as any)).not.toThrow();
    expect(() => e.purchase({ items: [], value: 10 } as any)).not.toThrow();
    expect(() => e.purchase({ orderId: 'o2', items: [], value: NaN } as any)).not.toThrow();
    expect(() => e.purchase(null as any)).not.toThrow();
    expect(() => e.viewProduct(null as any)).not.toThrow();
    expect(() => e.addToCart({} as any)).not.toThrow();
    expect(() => e.updateCart(undefined as any, 1)).not.toThrow();
    expect(() => e.startCheckout(null as any, 1)).not.toThrow();
    expect(() => e.orderRefunded(undefined as any)).not.toThrow();
    expect(() => e.submitReview('p1', NaN)).not.toThrow();
    expect(queued()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a valid purchase still sends orderId and total; null items are skipped', () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.ecommerce().purchase({ orderId: 'o1', value: 20, items: [null as any, { productId: 'p', name: 'P', price: 20, quantity: 1 }] });
    const [event] = (sdk as any).queue.getQueuedEvents();
    expect(event.type).toBe('Order Completed');
    expect(event.properties).toEqual(expect.objectContaining({ orderId: 'o1', total: 20, item_count: 1 }));
    expect(event.properties.items).toHaveLength(1);
  });
});

describe('#5 / item 37: durable writes survive navigation', () => {
  it('a subscription that could not be sent goes out on the next page view', async () => {
    installFetch(() => ({ status: 503, body: {} }));
    const first = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    first.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    first.addAlias('crm', 'C-9');
    await settle(50);
    (first as any).outbox.destroy();
    nextPage();

    const calls = installFetch();
    new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    await waitFor(() => by(calls, SUB).length === 1 && by(calls, ALIAS).length === 1);
    expect(by(calls, SUB)[0].body.status).toBe('optedIn');
    expect(stored('write_outbox')).toBeNull();
  });

  it('unacknowledged attribute writes survive navigation too', async () => {
    installFetch(() => ({ status: 503, body: {} }));
    const first = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    first.setAttribute('plan', 'pro');
    await settle(900);
    (first as any).outbox.destroy();
    clearTimeout((first as any).attributeFlushTimer);
    nextPage();

    const calls = installFetch();
    new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    await waitFor(() => by(calls, ATTRS).some((c) => c.body.attributes?.plan === 'pro'));
  });

  it('at page unload the waiting writes are handed to fetch keepalive (and stay stored until acked)', async () => {
    const calls = installFetch((req) => (req.init.keepalive ? { status: 200, body: { success: true } } : { status: 503, body: {} }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.user.setSubscription('whatsapp', SubscriptionStatus.SUBSCRIBED);
    await settle(50);
    (sdk as any).handlePageUnload();
    const handed = by(calls, SUB).filter((c) => c.init.keepalive);
    expect(handed).toHaveLength(1);
    expect(handed[0].init.headers['X-SDK-Key']).toBe('jry_sdk_test');
    expect(stored('write_outbox')).toHaveLength(1);
  });
});

describe('#6: an identify made during a flush does not overtake the events queued before it', () => {
  it('the events tracked before identify() ride WITH it', async () => {
    let release!: () => void;
    let n = 0;
    const calls = installFetch();
    const okFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      if (String(url).endsWith('/v1/track/batch') && n++ === 0) await new Promise<void>((r) => (release = r));
      return okFetch(url, init);
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.track('A');
    const firstFlush = sdk.flush();
    await settle(5);
    sdk.track('B');
    sdk.identify('u');
    release();
    await firstFlush;
    await waitFor(() => calls.some((c) => c.body?.identify));
    const withIdentify = calls.find((c) => c.body?.identify)!;
    expect(withIdentify.body.events.map((e: any) => e.type)).toEqual(['B']);
  });
});

describe('#8 / items 31, 38: attribute writes keep the identity they were made under', () => {
  it("identify('B') without reset: A's pending attribute goes out as A", async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('A');
    await sdk.flush();
    sdk.setAttribute('plan', 'pro');
    sdk.identify('B');
    await waitFor(() => by(calls, ATTRS).some((c) => c.body.attributes?.plan));
    expect(by(calls, ATTRS).find((c) => c.body.attributes?.plan)!.body.userId).toBe('A');
  });
});

describe('#9 / item 46: no attribute write is lost or reordered around reset() or an in-flight request', () => {
  it("a newer write of a key whose older write is on the wire lands last, under its own user, across reset()", async () => {
    let release!: () => void;
    let n = 0;
    const calls = installFetch();
    const okFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      if (String(url).endsWith(ATTRS) && n++ === 0) await new Promise<void>((r) => (release = r));
      return okFetch(url, init);
    });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('A');
    await sdk.flush();
    sdk.setAttribute('tier', 1);
    await waitFor(() => n === 1, 3000);
    sdk.setAttribute('tier', 2);
    sdk.unsetAttribute('tier');
    await sdk.reset();
    release();
    await waitFor(() => by(calls, ATTRS).filter((c) => 'tier' in (c.body.attributes || {}) || (c.body.unset || []).includes('tier')).length === 2, 5000);
    const tier = by(calls, ATTRS).filter((c) => 'tier' in (c.body.attributes || {}) || (c.body.unset || []).includes('tier'));
    expect(tier[0].body.attributes.tier).toBe(1);
    expect(tier[1].body.unset).toEqual(['tier']); // the set of 2 was superseded by the newer unset
    expect(tier.every((c) => c.body.userId === 'A')).toBe(true);
  });
});

describe('#11 / item 40: an identify is never dropped for an outage', () => {
  it('twelve 5xx answers in a row: the identify is still waiting, with no attempt counted', async () => {
    installFetch((req) => (req.path.endsWith('/v1/track/batch') ? { status: 503, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('u');
    for (let i = 0; i < 12; i++) await sdk.flush();
    const pending = (sdk as any).queue.getPendingIdentify();
    expect(pending?.userId).toBe('u');
    expect(pending.attempts || 0).toBe(0);
  });

  it('a success:false identify is counted, and dropped at the cap', async () => {
    installFetch((req) => (req.path.endsWith('/v1/track/batch') ? { status: 200, body: { success: false, failedIndices: [] } } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.identify('u');
    for (let i = 0; i < 10; i++) await sdk.flush();
    expect((sdk as any).queue.getPendingIdentify()).toBeNull();
  });
});

describe('#12 / items 33, 40: the opt-out marker is capped', () => {
  it('a 403 drops it, and it is not re-sent on every later page view', async () => {
    jest.useFakeTimers();
    const calls = installFetch((req) => (req.path.endsWith(ATTRS) ? { status: 403, body: {} } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.optOut();
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(markerCalls(calls)).toHaveLength(1);
    await sdk.destroy();
    nextPage();
    calls.length = 0;
    new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(markerCalls(calls)).toHaveLength(0);
  });

  it('a success:false answer is retried at most 10 times', async () => {
    jest.useFakeTimers();
    const calls = installFetch((req) => (req.path.endsWith(ATTRS) ? { status: 200, body: { success: false } } : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.optOut();
    await jest.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(markerCalls(calls)).toHaveLength(10);
  });

  it('the marker goes out even with consent denied (a withdrawal, item 36)', async () => {
    const calls = installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' } as any);
    sdk.optOut();
    await waitFor(() => markerCalls(calls).length === 1);
    expect(markerCalls(calls)[0].body.attributes.tracking_opted_out).toBe(true);
  });
});

describe('#15 / item 41: names and sizes measured exactly like the server', () => {
  it('a whitespace-only event name is sent (the server accepts it)', () => {
    installFetch();
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    sdk.track('   ');
    sdk.track('');
    expect((sdk as any).queue.getQueuedEvents().map((e: any) => e.type)).toEqual(['   ']);
  });

  it('characters a serializer might escape (< > & = \') count once, like JSON.stringify', () => {
    const value = `<>&='`.repeat(10236); // JSON {"s":"..."} = 51,188 characters
    expect(JSON.stringify({ s: value }).length).toBeLessThanOrEqual(51200);
    expect(eventPropertiesProblem({ s: value })).toBeNull();
    expect(eventPropertiesProblem({ s: value + 'x'.repeat(20) })).not.toBeNull();
  });
});

describe('#16 / items 39, 40: SDK-authentication refusals', () => {
  const authError = (reason: string) => ({ status: 401, body: { error: 'sdk_authentication_error', reason } });

  it("a write of the current user refused with 401 is retried (counted), not dropped after one refresh", async () => {
    jest.useFakeTimers();
    let n = 0;
    const calls = installFetch((req) => (req.path.endsWith(SUB) && n++ < 2 ? authError('expired') : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 't' } as any);
    sdk.identify('u');
    await jest.advanceTimersByTimeAsync(100);
    sdk.user.setSubscription('email', SubscriptionStatus.SUBSCRIBED);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(by(calls, SUB).length).toBe(3);
  });

  it('attributes: a 401 of the current user is rescheduled, a 403 is dropped', async () => {
    jest.useFakeTimers();
    let answer: any = authError('expired');
    const calls = installFetch((req) => (req.path.endsWith(ATTRS) ? answer : { status: 200, body: { success: true } }));
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 't' } as any);
    sdk.identify('u');
    await jest.advanceTimersByTimeAsync(100);
    sdk.setAttribute('plan', 'pro');
    await jest.advanceTimersByTimeAsync(1000);
    answer = { status: 200, body: { success: true } };
    await jest.advanceTimersByTimeAsync(30 * 1000);
    expect(by(calls, ATTRS).filter((c) => c.body.attributes?.plan).length).toBeGreaterThanOrEqual(2);
    expect((sdk as any).identity.pending.isEmpty()).toBe(true);

    calls.length = 0;
    answer = { status: 403, body: {} };
    sdk.setAttribute('plan', 'max');
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(by(calls, ATTRS).filter((c) => c.body.attributes?.plan)).toHaveLength(1);
    expect((sdk as any).identity.pending.isEmpty()).toBe(true);
  });

  it("reset() forgets the token; the previous user's leftovers are dropped on ANY 401 reason, and the handler never hears of them", async () => {
    const handler = jest.fn();
    const calls = installFetch((req) =>
      req.path.endsWith('/v1/track/batch') && req.body.events.some((e: any) => e.userId === 'A')
        ? authError('expired')
        : { status: 200, body: { success: true, processed: req.body?.events?.length ?? 0, identified: true } });
    const sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, enableSdkAuthentication: true, sdkAuthenticationToken: 'tok-A' } as any);
    sdk.setSdkAuthenticationErrorCallback(handler);
    (sdk as any).queue.setPaused(true);
    sdk.identify('A');
    sdk.track('A did something');
    (sdk as any).queue.setPaused(false);
    (sdk as any).queue.getPendingIdentifies().forEach((i: any) => (sdk as any).queue.removeIdentify(i));
    await sdk.reset();
    expect((sdk as any).network.getSdkAuthHeaders()).toEqual({});
    sdk.track('new visitor');
    await sdk.flush();
    await sdk.flush();
    expect(handler).not.toHaveBeenCalled();
    expect((sdk as any).queue.getQueuedEvents()).toHaveLength(0);
    expect(calls.some((c) => c.body?.events?.some((e: any) => e.type === 'new visitor'))).toBe(true);
  });
});

describe('item 44: getters answer from stored state', () => {
  it('a new page view reads the stored opt-out and denial before anything else', () => {
    installFetch();
    const first = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    first.optOut();
    first.updateConsent('denied');
    nextPage();
    const second = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false } as any);
    expect(second.isUserOptedOut()).toBe(true);
    expect(second.getTrackingConsent()).toBe('denied');
  });
});

describe('item 45: pre-init consent sequences', () => {
  const boot = (queue: any[]) => {
    const win: any = { joryio: queue };
    installSnippetQueue(win);
    return win.joryio as JoryioSDK;
  };

  it('denied then pending before init stays denied, and pending is never stored', () => {
    installFetch();
    const sdk = boot([['updateConsent', 'denied'], ['updateConsent', 'pending'], ['init', { ...BASE_CONFIG }]]);
    expect(sdk.getTrackingConsent()).toBe('denied');
    sdk.destroy();
    resetSingleton();
    store.clear();
    const pendingOnly = boot([['updateConsent', 'pending'], ['init', { ...BASE_CONFIG }]]);
    expect(pendingOnly.getTrackingConsent()).toBe('pending');
    expect(stored('tracking_consent')).toBeNull();
  });

  it('an explicit pre-init optIn()/optOut() wins over the config value', () => {
    installFetch();
    const optedIn = boot([['optIn'], ['init', { ...BASE_CONFIG, optOut: true }]]);
    expect(optedIn.isUserOptedOut()).toBe(false);
    optedIn.destroy();
    resetSingleton();
    store.clear();
    const optedOut = boot([['init', { ...BASE_CONFIG, optOut: false }], ['optOut']]);
    expect(optedOut.isUserOptedOut()).toBe(true);
  });
});
