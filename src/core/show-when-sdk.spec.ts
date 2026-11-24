import { JoryioSDK } from './sdk';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, waitFor, settle, RecordedRequest } from './test-harness';

/**
 * Show when (D465) through the public SDK: tracking an event an answer
 * depends on (`recheckOn`, or an item waiting on it) asks for the placement
 * again at once - inside the 30 s client limit, once per (key, event) per
 * page view - but never before the event itself reached the server: the
 * re-check waits for a flush already running, then for the flush that
 * delivers the event, and it carries the event (`recheckEvent`).
 */
let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
/** Each batch request takes the next gate (if any) and waits on it; `batchStatus` is the answer. */
let gates: Promise<void>[] = [];
let releases: Array<() => void> = [];
let batchStatus = 200;

beforeEach(() => {
  installLocalStorage();
  gates = [];
  releases = [];
  batchStatus = 200;
  calls = installFetch((req) => {
    if (req.path.endsWith('/v1/in-app/placements')) {
      return {
        status: 200,
        body: {
          success: true,
          placements: {
            home_hero: {
              placementKey: 'home_hero',
              recheckOn: ['Added to cart'],
              items: [{ id: 'held', kind: 'data', data: {}, showWhen: { kind: 'event', event: 'Signed up' } }],
            },
          },
        },
      };
    }
    if (req.path.endsWith('/v1/track/batch')) {
      return batchStatus === 200 ? { status: 200, body: { success: true, processed: req.body?.events?.length ?? 0 } } : { status: batchStatus, body: { success: false } };
    }
    return { status: 200, body: { success: true } };
  });
  const recorded = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const g = String(url).endsWith('/v1/track/batch') ? gates.shift() : undefined;
    if (g) await g;
    return recorded(url, init);
  };
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location: { href: 'https://shop.example/', origin: 'https://shop.example', pathname: '/', search: '' }, ...listeners };
  (globalThis as any).document = { referrer: '', readyState: 'complete', visibilityState: 'visible', ...listeners };
});

afterEach(async () => {
  releases.forEach((r) => r());
  if (sdk) await sdk.destroy();
  sdk = null;
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

const serves = () => calls.filter((c) => c.path.endsWith('/v1/in-app/placements'));
const batches = () => calls.filter((c) => c.path.endsWith('/v1/track/batch'));
const batchWith = (type: string) => batches().find((c) => c.body.events.some((e: any) => e.type === type));
const queuedId = (type: string) => batchWith(type)!.body.events.find((e: any) => e.type === type).eventId;
/** The next batch request waits until the returned release is called. */
const opened = () => {
  let release: () => void = () => undefined;
  gates.push(new Promise<void>((r) => (release = r)));
  releases.push(release);
  return release;
};

async function started(): Promise<JoryioSDK> {
  const s = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
  const first = await s.getPlacements(['home_hero']);
  expect(first.home_hero.items).toEqual([]); // held: waits for "Signed up"
  await s.flush(); // Session Start etc. out of the way
  return s;
}

describe('show when through JoryioSDK', () => {
  it('no capability; an event in recheckOn is delivered first, then the key is asked again with recheckEvent, once per page view', async () => {
    sdk = await started();
    expect(serves()[0].body.capabilities).not.toContain('show_when');
    expect(serves()[0].body.recheckEvent).toBeUndefined();

    sdk.track('Added to cart', { sku: 'a' });
    await waitFor(() => serves().length === 2);
    expect(calls.indexOf(batchWith('Added to cart')!)).toBeLessThan(calls.indexOf(serves()[1]));
    expect(serves()[1].body.recheckEvent).toEqual({ name: 'Added to cart', eventId: queuedId('Added to cart'), properties: expect.objectContaining({ sku: 'a' }) });

    sdk.track('Added to cart');
    await settle(200);
    expect(serves()).toHaveLength(2);

    // The item's own event: shown locally at once, and asked again (it waits on it).
    sdk.track('Signed up');
    expect((await sdk.getPlacements(['home_hero'])).home_hero.items.map((i) => i.id)).toEqual(['held']);
    await waitFor(() => serves().length === 3);
    expect(serves()[2].body.recheckEvent).toMatchObject({ name: 'Signed up', eventId: queuedId('Signed up') });
  });

  it('a flush already running: no re-check until it finishes AND the next flush, which carries the event, succeeds', async () => {
    sdk = await started();
    const releaseA = opened();
    sdk.track('Viewed product');
    const flushA = sdk.flush();
    await waitFor(() => gates.length === 0); // flush A's request is out and held
    opened(); // the flush that will carry the event is held too
    sdk.track('Added to cart');
    await settle(100);
    expect(serves()).toHaveLength(1);
    releaseA();
    await flushA;
    expect(batchWith('Viewed product')!.body.events.map((e: any) => e.type)).not.toContain('Added to cart'); // not in flush A
    await waitFor(() => gates.length === 0); // the event's own flush is out and held
    await settle(100);
    expect(serves()).toHaveLength(1);
    const releaseB = releases[releases.length - 1];
    releaseB();
    await waitFor(() => serves().length === 2);
    expect(serves()[1].body.recheckEvent.eventId).toBe(queuedId('Added to cart'));
    expect(calls.indexOf(batchWith('Added to cart')!)).toBeLessThan(calls.indexOf(serves()[1]));
  });

  it('a failed flush keeps the re-check waiting; it runs once, after the next successful flush', async () => {
    sdk = await started();
    batchStatus = 503;
    sdk.track('Added to cart');
    await waitFor(() => !!batchWith('Added to cart'));
    await settle(100);
    expect(serves()).toHaveLength(1);
    batchStatus = 200;
    await sdk.flush();
    await waitFor(() => serves().length === 2);
    expect(serves()[1].body.recheckEvent.name).toBe('Added to cart');
    sdk.track('Something else');
    await sdk.flush();
    await settle(100);
    expect(serves()).toHaveLength(2);
  });

  describe('a waiting re-check never runs for someone else', () => {
    const rechecked = () => serves().filter((c) => c.body.recheckEvent);
    const pending = () => (sdk as any).pendingRechecks.length as number;
    /** Queue a re-check whose event's batch is held, do `change`, then let the batch through. */
    async function heldThen(change: () => unknown | Promise<unknown>): Promise<void> {
      sdk = await started();
      const release = opened();
      sdk.track('Added to cart', { email: 'a@example.com' });
      await waitFor(() => gates.length === 0);
      expect(pending()).toBe(1);
      await change();
      release();
      await settle(300);
    }

    it('dropped after an identity switch', async () => {
      await heldThen(() => sdk!.identify('user-b'));
      expect(rechecked()).toEqual([]);
    });

    it('dropped after reset', async () => {
      // reset() first settles the held send; the re-check must not run when it does.
      await heldThen(() => {
        void sdk!.reset();
      });
      expect(rechecked()).toEqual([]);
    });

    it('dropped after consent is withdrawn', async () => {
      await heldThen(() => sdk!.updateConsent('denied'));
      expect(rechecked()).toEqual([]);
    });

    it('dropped after a route change', async () => {
      await heldThen(async () => {
        (globalThis as any).window.location.pathname = '/cart';
        await waitFor(() => pending() === 0); // the page tracker notices the route within a second
      });
      expect(rechecked()).toEqual([]);
    });

    it('dropped when older than 60 s', async () => {
      const realNow = Date.now;
      try {
        await heldThen(() => {
          const t = realNow() + 61_000;
          jest.spyOn(Date, 'now').mockImplementation(() => t);
        });
        expect(rechecked()).toEqual([]);
      } finally {
        (Date.now as any).mockRestore?.();
      }
    });

    it('at most 20 wait; the oldest is dropped', () => {
      const s = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
      sdk = s;
      const queue = (s as any).queue;
      const flush = queue.flush;
      (s as any).placements.recheckKeysFor = () => ['home_hero'];
      queue.flush = () => Promise.resolve(); // nothing delivered: every re-check keeps waiting
      for (let i = 0; i < 25; i++) s.track(`E${i}`);
      const names = ((s as any).pendingRechecks as Array<{ event: { name: string } }>).map((r) => r.event.name);
      queue.flush = flush;
      expect(names).toHaveLength(20);
      expect(names[0]).toBe('E5');
      expect(names[19]).toBe('E24');
    });
  });
});
