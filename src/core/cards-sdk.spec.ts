import { JoryioSDK } from './sdk';
import { cardsDeviceStorageKey } from './cards';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, waitFor, RecordedRequest } from './test-harness';
import * as entry from '../index';

/**
 * Content cards through the public SDK (D444 Phase 3): identify, reset,
 * consent and wipeData reach the card feed - a new person never sees or
 * reports the previous one's cards, and an anonymous visitor's device state
 * goes with them.
 */

let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
let local: Map<string, string>;
const feeds = () => calls.filter((c) => c.path === '/api/v1/in-app/cards');

const answer = (req: RecordedRequest) => {
  if (!req.path.endsWith('/v1/in-app/cards')) return { status: 200, body: { success: true } };
  const who = req.body.userId || req.body.anonymousId;
  return {
    status: 200,
    body: {
      success: true,
      etag: `e-${who}`,
      cards: [{ id: `card-${who}`, campaignId: 'c1', variantId: null, title: 'Hi', body: null, imageUrl: null, buttonText: null, url: null, pinned: false, createdAt: '2026-11-21T00:00:00.000Z', expiresAt: null, read: false, clicked: false, deliveryToken: `tok-${who}` }],
      unreadCount: 1,
      nextCursor: null,
      ttlSeconds: 300,
      stateScope: req.body.userId ? 'server' : 'device',
    },
  };
};

beforeEach(() => {
  local = installLocalStorage();
  calls = installFetch(answer);
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location: { href: 'https://shop.example/', search: '' }, ...listeners };
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

describe('content cards through JoryioSDK', () => {
  it('exports the card constants with the shared values', () => {
    expect(entry.CARD_MIN_REFRESH_SECONDS).toBe(30);
    expect(entry.CARD_FEED_TTL_SECONDS).toBe(300);
  });

  it('identify asks for the new person feed; the previous one is gone at once', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    const anon = sdk.getAnonymousId();
    const first = await sdk.getCards();
    expect(first.cards.map((c) => c.id)).toEqual([`card-${anon}`]);
    expect(first.stateScope).toBe('device');
    const seen: string[][] = [];
    sdk.onCardsUpdated((feed) => seen.push(feed.cards.map((c) => c.id)));
    sdk.identify('user-7');
    expect(sdk.getUnreadCardCount()).toBe(0);
    await waitFor(() => seen.some((ids) => ids[0] === 'card-user-7'));
    expect(feeds().pop()!.body.userId).toBe('user-7');
    expect(seen[0]).toEqual([]);
  });

  it('reset clears an anonymous visitor device state', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    const feed = await sdk.getCards();
    sdk.dismissCard(feed.cards[0]);
    expect(local.has(cardsDeviceStorageKey(BASE_CONFIG.sdkKey))).toBe(true);
    sdk.reset();
    expect(local.has(cardsDeviceStorageKey(BASE_CONFIG.sdkKey))).toBe(false);
  });

  it('wipeData clears the device state too', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    const feed = await sdk.getCards();
    sdk.markCardRead(feed.cards[0].id);
    expect(local.has(cardsDeviceStorageKey(BASE_CONFIG.sdkKey))).toBe(true);
    await sdk.wipeData();
    expect(local.has(cardsDeviceStorageKey(BASE_CONFIG.sdkKey))).toBe(false);
  });

  it('opting out empties the feed and asks nothing more', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await sdk.getCards();
    const before = feeds().length;
    sdk.optOut();
    expect(sdk.getUnreadCardCount()).toBe(0);
    expect((await sdk.getCards()).cards).toEqual([]);
    expect(feeds()).toHaveLength(before);
  });
});
