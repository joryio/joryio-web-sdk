import { JoryioSDK } from './sdk';
import {
  BASE_CONFIG,
  installFetch,
  installLocalStorage,
  uninstallLocalStorage,
  settle,
  waitFor,
  RecordedRequest,
  Responder,
} from './test-harness';
import { SubscriptionStatus } from './user';

/**
 * SDK 1.3.0 scan 2 (web) and the contract addendum (items 13-23). Each test
 * names the finding it pins; every one fails on the code before the fix.
 */

let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
let store: Map<string, string>;

const paths = () => calls.map((c) => c.path);
const batches = () => calls.filter((c) => c.path === '/api/v1/track/batch');
const events = () => batches().flatMap((c) => c.body.events);

/** A responder that answers like the API: batch confirms identify, everything else success. */
const ok: Responder = (req) => {
  if (req.path.endsWith('/v1/track/batch')) {
    return { status: 200, body: { success: true, ...(req.body?.identify ? { identified: true } : {}) } };
  }
  return { status: 200, body: { success: true } };
};

beforeEach(() => {
  store = installLocalStorage();
  calls = installFetch(ok);
});

afterEach(async () => {
  if (sdk) await sdk.destroy();
  sdk = null;
  await JoryioSDK.getInstance()?.destroy();
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).caches;
});

/** Hold every request whose path ends with `suffix` until the returned release() is called. */
function gate(suffix: string): { release: () => void; held: () => number } {
  const inner = (globalThis as any).fetch;
  const waiting: Array<() => void> = [];
  (globalThis as any).fetch = (url: string, init: any) => {
    if (!String(url).endsWith(suffix)) return inner(url, init);
    return new Promise((resolve) => waiting.push(() => resolve(inner(url, init))));
  };
  return {
    release: () => waiting.splice(0).forEach((go) => go()),
    held: () => waiting.length,
  };
}

describe('reset() changes the identity synchronously (scan 2 #2, addendum 16)', () => {
  it('reset(); identify(B) without awaiting: B is identified, with the NEW anonymous id', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-A');
    await sdk.flush();
    const anonA = sdk.getAnonymousId();

    sdk.track('Before Logout');
    const resetDone = sdk.reset(); // not awaited - how most apps call it
    sdk.identify('user-B');

    // Synchronously visible: the reset already happened, identify(B) after it.
    expect(sdk.getUserId()).toBe('user-B');
    const anonB = sdk.getAnonymousId();
    expect(anonB).not.toBe(anonA);

    await resetDone;
    await sdk.flush();

    // It used to end with userId null (the reset landed after identify).
    expect(sdk.getUserId()).toBe('user-B');

    // identify(B) must NOT carry A's anonymous id: that asks the server to
    // merge A's profile into B's - two different customers.
    const identifies = batches()
      .map((c) => c.body.identify)
      .filter(Boolean)
      .filter((i: any) => i.userId === 'user-B');
    expect(identifies).toEqual([expect.objectContaining({ userId: 'user-B', anonymousId: anonB })]);

    // What happened before the logout still went out as user A.
    const before = events().find((e: any) => e.type === 'Before Logout');
    expect(before).toEqual(expect.objectContaining({ userId: 'user-A', anonymousId: anonA }));
  });

  it('awaited reset() then identify() is unchanged', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-A');
    await sdk.reset();
    sdk.identify('user-B');
    await sdk.flush();
    expect(sdk.getUserId()).toBe('user-B');
    const last = batches().map((c) => c.body.identify).filter(Boolean).pop();
    expect(last).toEqual(expect.objectContaining({ userId: 'user-B', anonymousId: sdk.getAnonymousId() }));
  });
});

describe('2xx with success:false is a failure (scan 2 #8, addendum 15)', () => {
  it('attributes are kept and sent again', async () => {
    let refuse = true;
    calls = installFetch((req) =>
      req.path === '/api/v1/attributes' && refuse ? { status: 200, body: { success: false, error: 'db down' } } : ok(req),
    );
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.setAttributes({ plan: 'pro' });
    await waitFor(() => calls.some((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan === 'pro'));
    refuse = false;
    // Retried after the backoff (5 s on the first failure).
    await waitFor(
      () => calls.filter((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan === 'pro').length >= 2,
      9000,
    );
  });

  it('an identify the server did not confirm, whose standalone retry also failed, is kept', async () => {
    calls = installFetch((req) => {
      if (req.path === '/api/v1/track/batch') return { status: 200, body: { success: true } }; // no `identified`
      if (req.path === '/api/v1/identify') return { status: 200, body: { success: false } };
      return ok(req);
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-1');
    await sdk.flush();
    // It used to be dropped with a log line - the visitor stayed unmerged.
    expect((sdk as any).queue.getPendingIdentify()).toEqual(expect.objectContaining({ userId: 'user-1' }));
  });

  it('a batch answered success:false without failedIndices keeps every event', async () => {
    let refuse = true;
    calls = installFetch((req) =>
      req.path === '/api/v1/track/batch' && refuse ? { status: 200, body: { success: false } } : ok(req),
    );
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('A');
    sdk.track('B');
    await sdk.flush();
    expect((sdk as any).queue.getQueueSize()).toBe(2);
    refuse = false;
    (sdk as any).queue.resetBackoff();
    await sdk.flush();
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });
});

describe('the queue (scan 2 #12, #13)', () => {
  it('opting out while a batch is in flight does not put the batch back (#13)', async () => {
    calls = installFetch((req) => (req.path === '/api/v1/track/batch' ? { status: 503, body: {} } : ok(req)));
    const g = gate('/v1/track/batch');
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('Before Opt-Out');
    const flushing = sdk.flush();
    await waitFor(() => g.held() === 1);

    sdk.optOut();
    g.release();
    await flushing;

    expect((sdk as any).queue.getQueueSize()).toBe(0);
    sdk.optIn();
    calls.length = 0;
    calls = installFetch(ok);
    (sdk as any).queue.resetBackoff();
    await sdk.flush();
    expect(events().map((e: any) => e.type)).not.toContain('Before Opt-Out');
  });

  it('halves of a refused batch waiting their turn are kept in storage (#12)', async () => {
    let first = true;
    calls = installFetch((req) => {
      if (req.path === '/api/v1/track/batch' && first) {
        first = false;
        return { status: 400, body: { message: 'bad' } };
      }
      return ok(req);
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, persistQueue: true });
    for (const name of ['E1', 'E2', 'E3', 'E4']) sdk.track(name);
    // Hold the SECOND request (the first half) in flight.
    const inner = (globalThis as any).fetch;
    let release!: () => void;
    let seen = 0;
    (globalThis as any).fetch = (url: string, init: any) => {
      if (String(url).endsWith('/v1/track/batch') && ++seen === 2) {
        return new Promise((resolve) => (release = () => resolve(inner(url, init))));
      }
      return inner(url, init);
    };
    const flushing = sdk.flush();
    await waitFor(() => seen === 2);

    const inflightKey = [...store.keys()].find((k) => k.endsWith('event_queue_inflight'))!;
    const stored = JSON.parse(store.get(inflightKey)!).value.map((e: any) => e.type);
    // The half in flight AND the half still waiting: a page closed now loses neither.
    expect(stored.sort()).toEqual(['E1', 'E2', 'E3', 'E4']);

    release();
    await flushing;
  });
});

describe('consent pending keeps writes across a reload (scan 2 #5)', () => {
  it('attributes, aliases and subscription changes survive a reload and go out when consent is granted', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' });
    sdk.setAttributes({ plan: 'pro' });
    sdk.addAlias('crm', 'C-1');
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    await sdk.destroy(); // the page goes away
    sdk = null;

    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' });
    await settle(900);
    expect(calls).toEqual([]);

    sdk.updateConsent('granted');
    await waitFor(
      () =>
        paths().includes('/api/v1/alias/add') &&
        paths().includes('/api/v1/subscriptions/channel') &&
        calls.some((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan === 'pro'),
    );
    expect(calls.find((c) => c.path === '/api/v1/alias/add')!.body).toEqual(
      expect.objectContaining({ aliasLabel: 'crm', aliasName: 'C-1' }),
    );
  });

  it('a page that loads with consent already granted sends what an earlier page held', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' });
    sdk.addAlias('crm', 'C-2');
    await sdk.destroy();
    sdk = null;

    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await waitFor(() => paths().includes('/api/v1/alias/add'));
  });

  it('denied on the next page discards them', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'pending' });
    sdk.setAttributes({ plan: 'pro' });
    sdk.addAlias('crm', 'C-3');
    await sdk.destroy();
    sdk = null;

    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, trackingConsent: 'denied' });
    await sdk.destroy();
    sdk = null;
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await settle(900);
    expect(paths()).not.toContain('/api/v1/alias/add');
    expect(calls.some((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan)).toBe(false);
  });

  it('push_permission is marked reported only once the server acknowledged it', async () => {
    calls = installFetch((req) => (req.path === '/api/v1/attributes' ? { status: 503, body: {} } : ok(req)));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await waitFor(() => calls.some((c) => c.path === '/api/v1/attributes'));
    await sdk.destroy();
    sdk = null;

    // Next page view: the API works again. The permission was never stored, so
    // it must be reported now - the marker used to be written before the send.
    calls = installFetch(ok);
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await waitFor(() =>
      calls.some((c) => c.path === '/api/v1/attributes' && c.body.attributes?.push_permission === 'unavailable'),
    );
    await settle(20);
    await sdk.destroy();
    sdk = null;

    // ...and after the acknowledgement, not again.
    calls = installFetch(ok);
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    await settle(900);
    expect(calls.some((c) => c.path === '/api/v1/attributes')).toBe(false);
  });
});

describe('the push service worker is told whenever the page may not track (scan 2 #14)', () => {
  function installCaches() {
    const put = jest.fn(async () => undefined);
    const caches = { open: jest.fn(async () => ({ put })), delete: jest.fn(async () => true) };
    (globalThis as any).caches = caches;
    (globalThis as any).Response = (globalThis as any).Response || class {};
    return { caches, put };
  }

  it.each([['denied'], ['pending']] as const)("consent '%s' sets the worker's no-report flag", async (consent) => {
    const { put } = installCaches();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: consent });
    await settle(5);
    expect(put).toHaveBeenCalled();
  });

  it('granted clears it', async () => {
    const { caches, put } = installCaches();
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await settle(5);
    expect(put).not.toHaveBeenCalled();
    expect(caches.delete).toHaveBeenCalled();
  });
});

describe('updateUTM on a new campaign tracks ONE Session Start (scan 2 #11)', () => {
  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
  it('the session hook tracks it; updateUTM no longer adds a second', async () => {
    const location = { href: 'https://shop.example/?utm_campaign=a', pathname: '/', search: '?utm_campaign=a', hostname: 'shop.example' };
    (globalThis as any).window = { location, addEventListener() {}, removeEventListener() {} };
    (globalThis as any).document = {
      referrer: '',
      title: 'Shop',
      readyState: 'complete',
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    };
    sdk = new JoryioSDK({ ...BASE_CONFIG, resetSessionOnNewCampaign: true });
    await sdk.flush();
    const before = events().filter((e: any) => e.type === 'Session Start').length;

    location.search = '?utm_campaign=b';
    location.href = 'https://shop.example/?utm_campaign=b';
    sdk.updateUTM();
    await sdk.flush();

    expect(events().filter((e: any) => e.type === 'Session Start').length - before).toBe(1);
  });
});

describe('host-code mistakes never throw (scan 2 #15, addendum 19)', () => {
  it('a missing or malformed sdkKey builds an inert instance instead of throwing', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let bad!: JoryioSDK;
    expect(() => {
      bad = new JoryioSDK({ sdkKey: 'not-a-key' } as any);
    }).not.toThrow();
    expect(() => new JoryioSDK(null as any)).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();

    bad.track('Nothing');
    bad.identify('u');
    bad.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    await bad.flush();
    await settle(900);
    expect(calls).toEqual([]);
    await bad.destroy();

    // It did not take the singleton slot: a correct init still gets a working SDK.
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    expect(sdk).not.toBe(bad);
    sdk.track('Works');
    await sdk.flush();
    expect(events().map((e: any) => e.type)).toEqual(['Works']);
  });

  it('a null attribute value unsets the attribute', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    (globalThis as any).fetch.mockClear?.();
    calls.length = 0;
    sdk.setAttributes({ plan: 'pro', coupon: null, legacy: undefined });
    sdk.setAttribute('nickname', null);
    await waitFor(() => calls.some((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan));
    const body = calls.find((c) => c.path === '/api/v1/attributes' && c.body.attributes?.plan)!.body;
    expect(body.attributes.plan).toBe('pro');
    // Not written as a literal null (the native SDKs remove the key).
    expect(Object.keys(body.attributes)).not.toEqual(expect.arrayContaining(['coupon']));
    expect(Object.keys(body.attributes)).not.toEqual(expect.arrayContaining(['nickname']));
    expect([...body.unset].sort()).toEqual(['coupon', 'legacy', 'nickname']);
  });

  it('null keys are refused with a log, not sent', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    expect(() => {
      sdk!.unsetAttribute(null as any);
      sdk!.addToArray(null as any, 1);
      sdk!.removeFromArray(undefined as any, 1);
      sdk!.addAlias(null as any, null as any);
      sdk!.updateConsent(null as any);
    }).not.toThrow();
    await settle(900);
    expect(calls.filter((c) => c.path === '/api/v1/attributes').flatMap((c) => c.body.unset || [])).not.toContain(null);
  });
});

describe('wipeData() (addendum 21)', () => {
  it('erases identity, queue and device id, and keeps working for a new visitor', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, persistQueue: true });
    sdk.identify('user-1');
    const anon = sdk.getAnonymousId();
    const device = (sdk as any).deviceId;
    calls = installFetch(() => ({ status: 503, body: {} })); // nothing goes out
    sdk.track('Queued');
    await sdk.flush();

    calls = installFetch(ok);
    await sdk.wipeData();
    expect(sdk.getUserId()).toBeNull();
    expect(sdk.getAnonymousId()).not.toBe(anon);
    expect((sdk as any).deviceId).not.toBe(device);
    expect((sdk as any).queue.getQueueSize()).toBe(0);
    expect((sdk as any).queue.getPendingIdentify()).toBeNull();

    (sdk as any).queue.resetBackoff();
    sdk.track('After Wipe');
    await sdk.flush();
    expect(events().map((e: any) => e.type)).toEqual(['After Wipe']);
    expect(events()[0].anonymousId).toBe(sdk.getAnonymousId());
    expect(events()[0].userId).toBeNull();
  });

  it('keeps the persisted opt-out', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.optOut();
    await sdk.wipeData();
    await sdk.destroy();
    sdk = null;

    calls = installFetch(ok);
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('Still Opted Out');
    await sdk.flush();
    expect(calls).toEqual([]);
  });
});

// Real timers and real debounce windows; generous under a loaded CI machine.
jest.setTimeout(30_000);
