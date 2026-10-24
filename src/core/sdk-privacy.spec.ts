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
import { SubscriptionStatus } from './user';
import { WRITE_RETRY_DELAYS_MS } from './write-retry';

/**
 * Consent, opt-out and the profile writes they govern (SDK 1.3.0 contract
 * items 2, 4 and 5; review findings 4, 5, 7, 10).
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

describe("trackingConsent: 'pending'", () => {
  it('sends NOTHING - no Session Start, events, identify, attributes, alias or subscription', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'pending' });
    sdk.track('Viewed Pricing');
    sdk.identify('user-1');
    sdk.setAttributes({ plan: 'pro' });
    sdk.addAlias('crm_id', 'C-1');
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    await sdk.flush();
    await settle(900); // past the attribute debounce

    expect(calls).toEqual([]);
  });

  it("updateConsent('granted') releases everything held, Session Start first", async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'pending' });
    sdk.track('Viewed Pricing');
    sdk.identify('user-1');
    sdk.setAttributes({ plan: 'pro' });
    sdk.addAlias('crm_id', 'C-1');
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);

    sdk.updateConsent('granted');
    await waitFor(() => paths().includes('/api/v1/subscriptions/channel') && paths().includes('/api/v1/attributes'));

    const batch = calls.find((c) => c.path === '/api/v1/track/batch')!;
    expect(batch.body.events.map((e: any) => e.type)).toEqual(['Session Start', 'Viewed Pricing']);
    expect(batch.body.identify.userId).toBe('user-1');
    expect(paths()).toContain('/api/v1/alias/add');
    // The writes go AFTER the batch carrying the identify.
    expect(paths().indexOf('/api/v1/track/batch')).toBeLessThan(paths().indexOf('/api/v1/subscriptions/channel'));
  });

  it("updateConsent('denied') discards what was held", async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'pending' });
    sdk.track('Viewed Pricing');
    sdk.setAttributes({ plan: 'pro' });
    sdk.updateConsent('denied');
    sdk.updateConsent('granted');
    await sdk.flush();
    await settle(900);
    const batch = calls.find((c) => c.path === '/api/v1/track/batch');
    // Only what happened after the grant (nothing tracked, no new session).
    expect(batch?.body.events.map((e: any) => e.type) || []).not.toContain('Viewed Pricing');
    expect(paths()).not.toContain('/api/v1/attributes');
  });
});

describe('opt-out', () => {
  it('persists across a restart (a new SDK on the same storage)', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    sdk.optOut();
    await sdk.destroy();
    calls.length = 0;

    sdk = new JoryioSDK({ ...BASE_CONFIG }); // no optOut in config
    sdk.track('After Restart');
    sdk.addAlias('crm_id', 'C-1');
    sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
    sdk.incrementAttribute('visits');
    sdk.unsetAttribute('plan');
    await sdk.flush();
    await settle(900);

    expect(calls).toEqual([]);
  });

  it('optIn() clears the persisted flag', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    sdk.optOut();
    sdk.optIn();
    await sdk.destroy();
    calls.length = 0;

    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('Back In');
    await sdk.flush();
    expect(calls.find((c) => c.path === '/api/v1/track/batch')!.body.events[0].type).toBe('Back In');
  });

  it('clears pending attribute writes when opting out', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.setAttributes({ plan: 'pro' });
    sdk.incrementAttribute('visits', 2);
    sdk.optOut();
    await settle(900);
    const attributeWrites = calls.filter((c) => c.path === '/api/v1/attributes');
    // Only the consent record itself - never the pending plan / visits. The
    // key has NO `$`: the API strips `$`-prefixed attribute keys, so
    // `$tracking_opted_out` never reached a profile (contract addendum 14).
    expect(attributeWrites.map((c) => c.body)).toEqual([
      expect.objectContaining({ attributes: { tracking_opted_out: true } }),
    ]);
  });
});

describe('attribute writes are acknowledged only on success', () => {
  it('keeps a write the server did not accept, and sends it again', async () => {
    let fail = true;
    calls = installFetch((req) =>
      req.path === '/api/v1/attributes' && fail ? { status: 503, body: {} } : { status: 200, body: { success: true } },
    );
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.setAttributes({ plan: 'pro' });
    await waitFor(() => paths().includes('/api/v1/attributes'));
    await waitFor(() => (sdk as any).attributeFlushInFlight === false && (sdk as any).attributeFailures > 0);
    // Not acknowledged: still pending.
    expect((sdk as any).identity.pending.pending().plan).toBe('pro');

    fail = false;
    const attemptsBefore = calls.filter((c) => c.path === '/api/v1/attributes').length;
    clearTimeout((sdk as any).attributeFlushTimer);
    (sdk as any).attributeFlushTimer = null;
    (sdk as any).flushAttributeOps({});
    await waitFor(() => calls.filter((c) => c.path === '/api/v1/attributes').length > attemptsBefore);
    await waitFor(() => (sdk as any).attributeFlushInFlight === false && (sdk as any).attributeFailures === 0);
    expect((sdk as any).identity.pending.pending().plan).toBeUndefined();
  });
});

describe('subscriptions', () => {
  const saved = [...WRITE_RETRY_DELAYS_MS];
  beforeAll(() => WRITE_RETRY_DELAYS_MS.fill(5));
  afterAll(() => saved.forEach((v, i) => (WRITE_RETRY_DELAYS_MS[i] = v)));

  it('wait for the pending identify, send BOTH ids, and retry a 404', async () => {
    let subscriptionCalls = 0;
    calls = installFetch((req) => {
      if (req.path === '/api/v1/subscriptions/channel') {
        subscriptionCalls++;
        return subscriptionCalls === 1 ? { status: 404, body: { message: 'Contact not found' } } : { status: 200, body: {} };
      }
      if (req.path === '/api/v1/track/batch') {
        return { status: 200, body: { success: true, identified: !!req.body.identify } };
      }
      return { status: 200, body: { success: true } };
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-9');
    sdk.user.setSubscription('sms', SubscriptionStatus.SUBSCRIBED);

    await waitFor(() => subscriptionCalls === 2);
    const sub = calls.filter((c) => c.path === '/api/v1/subscriptions/channel');
    expect(sub[0].body).toEqual({
      channel: 'sms',
      status: 'subscribed',
      userId: 'user-9',
      anonymousId: sdk.getAnonymousId(),
    });
    const identifyAt = calls.findIndex((c) => c.path === '/api/v1/track/batch' && c.body.identify);
    expect(identifyAt).toBeGreaterThan(-1);
    expect(identifyAt).toBeLessThan(calls.indexOf(sub[0]));
  });
});

describe('addAlias', () => {
  it('works for an anonymous visitor (anonymousId, no userId)', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.addAlias('crm_id', 'C-77');
    await waitFor(() => paths().includes('/api/v1/alias/add'));
    expect(calls.find((c) => c.path === '/api/v1/alias/add')!.body).toEqual({
      anonymousId: sdk.getAnonymousId(),
      aliasLabel: 'crm_id',
      aliasName: 'C-77',
    });
  });

  it('carries userId once identified', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('user-5');
    sdk.addAlias('crm_id', 'C-78');
    await waitFor(() => paths().includes('/api/v1/alias/add'));
    expect(calls.find((c) => c.path === '/api/v1/alias/add')!.body.userId).toBe('user-5');
  });

  it('the unlabelled alias() is gone from the public API', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    expect((sdk as any).alias).toBeUndefined();
  });
});

describe('event names the server would refuse are dropped on the device', () => {
  it('empty and over-long names never enter the queue', () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('');
    sdk.track('x'.repeat(256));
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });
});

describe('402 SDK_INGESTION_SUSPENDED', () => {
  it('stops every request for the rest of the page view and keeps the events', async () => {
    calls = installFetch(() => ({ status: 402, body: { code: 'SDK_INGESTION_SUSPENDED' } }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('One');
    await sdk.flush();
    const after = calls.length;
    sdk.track('Two');
    await sdk.flush();
    sdk.setAttributes({ a: 1 });
    await settle(900);
    warn.mockRestore();
    expect(after).toBe(1);
    expect(calls.length).toBe(1);
    expect((sdk as any).queue.getQueueSize()).toBe(2);
  });
});

// Real timers and real debounce windows; generous under a loaded CI machine.
jest.setTimeout(30_000);
