import {
  CardManager,
  CARD_MIN_REFRESH_SECONDS,
  CARD_RETRY_AFTER_FAILURE_SECONDS,
  CARD_FEED_TTL_SECONDS,
  CARD_SDK_CAPABILITY,
  cardsDeviceStorageKey,
  cardsFeedStorageKey,
} from './cards';
import { bucketHash } from '../utils/bucket-hash';
import { PlacementConsent, isAppDeepLink } from './placements';
import { LinkRouter, JoryioLink } from './links';
import { IN_APP_DISPLAY_DWELL_MS } from './inapp';
import { installFetch, installLocalStorage, uninstallLocalStorage, RecordedRequest, Responder } from './test-harness';
import { CARDS_UI_API_VERSION, CARDS_UI_BUNDLE_FILE, CARDS_UI_GLOBAL } from './cards-ui-contract';
import { cardsUiApi } from '../cards-ui';
import { sdkHostFileUrls } from './sdk-host-files';

/**
 * Content cards on web (docs/PLACEMENTS_PLAN.md section 11, D444 Phase 3).
 * The feed endpoint is mocked; shapes are card.contract.ts (backend PR #810).
 */

const logger = { error() {}, warn: jest.fn(), info() {}, debug() {} } as any;
let userId: string | null = null;
let anonymousId = 'anon-1';
const identity = {
  getUserId: () => userId,
  getAnonymousId: () => anonymousId,
} as any;
const session = { getSessionId: () => 's-1' } as any;

// ── a tiny DOM + IntersectionObserver ────────────────────────────────────
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs = new Map<string, string>();
  style: any = { cssText: '' };
  className = '';
  textContent = '';
  src = '';
  alt = '';
  type = '';
  listeners = new Map<string, (e?: any) => void>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get innerHTML(): string {
    throw new Error('innerHTML must never be used for card text');
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must never be used for card text');
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  appendChild(c: FakeEl) {
    c.remove();
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type: string, fn: (e?: any) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    this.listeners.get('click')?.({ stopPropagation() {} });
  }
  findAll(pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    return out;
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    return this.findAll(pred)[0] || null;
  }
}
const byClass = (root: FakeEl, cls: string) => root.findAll((e) => e.className === cls);

class FakeIO {
  static all: FakeIO[] = [];
  targets: any[] = [];
  disconnected = false;
  constructor(public cb: (entries: any[]) => void) {
    FakeIO.all.push(this);
  }
  observe(t: any) {
    this.targets.push(t);
  }
  disconnect() {
    this.disconnected = true;
  }
}
const view = (target: any, ratio: number) =>
  FakeIO.all
    .filter((o) => !o.disconnected && o.targets.includes(target))
    .forEach((o) => o.cb([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]));

let session_: Map<string, string>;
let local_: Map<string, string>;

beforeEach(() => {
  jest.useFakeTimers();
  userId = null;
  anonymousId = 'anon-1';
  logger.warn.mockClear();
  loaded = [];
  FakeIO.all = [];
  session_ = new Map();
  (globalThis as any).IntersectionObserver = FakeIO;
  (globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as any).window = { open: jest.fn() };
  (globalThis as any).navigator = { language: 'en-GB' };
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => session_.get(k) ?? null,
    setItem: (k: string, v: string) => session_.set(k, v),
    removeItem: (k: string) => session_.delete(k),
  };
  local_ = installLocalStorage();
});

afterEach(() => {
  jest.useRealTimers();
  uninstallLocalStorage();
  for (const k of ['IntersectionObserver', 'document', 'window', 'navigator', 'sessionStorage']) delete (globalThis as any)[k];
});

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  campaignId: `camp-${id}`,
  variantId: 'v1',
  title: `Title ${id}`,
  body: `Body ${id}`,
  imageUrl: null,
  buttonText: null,
  url: null,
  pinned: false,
  createdAt: '2026-11-20T10:00:00.000Z',
  expiresAt: null,
  read: false,
  clicked: false,
  deliveryToken: `tok-${id}`,
  ...extra,
});

const feedAnswer = (cards: any[], extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    success: true,
    evaluatedAt: '2026-11-21T10:00:00.000Z',
    etag: 'etag-1',
    cards,
    unreadCount: cards.filter((c) => !c.read).length,
    nextCursor: null,
    ttlSeconds: 300,
    stateScope: 'server',
    ...extra,
  },
});

let calls: RecordedRequest[];
const feeds = () => calls.filter((c) => c.path === '/api/v1/in-app/cards');
const tracks = () => calls.filter((c) => c.path === '/api/v1/in-app/track').map((c) => c.body);

const SDK_KEY = 'jry_sdk_web_test';
const DEVICE_KEY = cardsDeviceStorageKey(SDK_KEY);

/** The renderer file "loads" (registers its global) like the real script tag would. */
let loaded: string[];
const loadRenderer = async (src: string) => {
  loaded.push(src);
  (globalThis as any).window[CARDS_UI_GLOBAL] = cardsUiApi;
};

function make(
  opts: { consent?: PlacementConsent | null; responder?: Responder; loadScript?: (src: string) => Promise<void>; cardsUiScriptUrl?: string } = {},
) {
  calls = installFetch(opts.responder || (() => feedAnswer([card('a'), card('b')])));
  const consent = 'consent' in opts ? opts.consent! : 'granted';
  return new CardManager('https://api.example/api', SDK_KEY, identity, session, logger, {
    consent: () => consent,
    loadScript: opts.loadScript || loadRenderer,
    cardsUiScriptUrl: opts.cardsUiScriptUrl,
  });
}

const flush = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('cards: fetching', () => {
  it('asks POST /v1/in-app/cards with the identity fields, the page size, consent and the cards capability', async () => {
    userId = 'user-42';
    const m = make();
    const feed = await m.getCards();
    expect(feeds()).toHaveLength(1);
    const body = feeds()[0].body;
    expect(body).toEqual({
      userId: 'user-42',
      anonymousId: 'anon-1',
      sessionId: 's-1',
      deviceType: 'web',
      locale: 'en-GB',
      capabilities: [CARD_SDK_CAPABILITY, 'content.native'],
      trackingConsent: 'granted',
      limit: 20,
    });
    expect(feeds()[0].init.headers['X-SDK-Key']).toBe('jry_sdk_web_test');
    expect(feed).toMatchObject({ unreadCount: 2, nextCursor: null, stateScope: 'server' });
    expect(feed.cards.map((c) => c.id)).toEqual(['a', 'b']);
    // The delivery token is internal: never handed to the site.
    expect((feed.cards[0] as any).deliveryToken).toBeUndefined();
  });

  it('without consent granted nothing is asked and the feed is empty; nothing is reported', async () => {
    for (const consent of ['pending', 'denied', null] as const) {
      const m = make({ consent });
      const feed = await m.getCards();
      expect(feed.cards).toEqual([]);
      expect(feed.unreadCount).toBe(0);
      m.markCardRead('a');
      expect(calls).toHaveLength(0);
    }
  });

  it(`serves from the cache for ttlSeconds (${CARD_FEED_TTL_SECONDS}), then asks again with the etag`, async () => {
    const m = make();
    await m.getCards();
    await m.getCards();
    expect(feeds()).toHaveLength(1);
    await flush(CARD_FEED_TTL_SECONDS * 1000);
    await m.getCards();
    expect(feeds()).toHaveLength(2);
    expect(feeds()[1].body.etag).toBe('etag-1');
  });

  it('notModified keeps the cached cards', async () => {
    let n = 0;
    const m = make({
      responder: () => (n++ === 0 ? feedAnswer([card('a')]) : { status: 200, body: { success: true, etag: 'etag-1', notModified: true, cards: [], unreadCount: 0, ttlSeconds: 300, stateScope: 'server' } }),
    });
    await m.getCards();
    await flush(CARD_FEED_TTL_SECONDS * 1000);
    const feed = await m.getCards();
    expect(feeds()).toHaveLength(2);
    expect(feed.cards.map((c) => c.id)).toEqual(['a']);
    expect(feed.unreadCount).toBe(1);
  });

  // 1.4.0-beta.11 test (Android): a failed feed request blocked the next one for the whole 30 s window.
  it('a request with no answer (or a 5xx) holds the next one back only CARD_RETRY_AFTER_FAILURE_SECONDS', async () => {
    expect(CARD_RETRY_AFTER_FAILURE_SECONDS).toBe(3);
    let mode: 'down' | '503' | 'ok' = 'down';
    const m = make({
      responder: () => {
        if (mode === 'down') throw new TypeError('Failed to fetch');
        if (mode === '503') return { status: 503 };
        return feedAnswer([card('a')]);
      },
    });
    expect((await m.getCards()).cards).toEqual([]);
    mode = 'ok';
    await flush(1000);
    await m.getCards();
    expect(feeds()).toHaveLength(1);
    await flush(CARD_RETRY_AFTER_FAILURE_SECONDS * 1000);
    expect((await m.getCards()).cards.map((c) => c.id)).toEqual(['a']);
    expect(feeds()).toHaveLength(2);
    mode = '503';
    await flush(CARD_FEED_TTL_SECONDS * 1000);
    await m.getCards();
    expect(feeds()).toHaveLength(3);
    mode = 'ok';
    await flush(CARD_RETRY_AFTER_FAILURE_SECONDS * 1000 + 10);
    await m.getCards();
    expect(feeds()).toHaveLength(4);
  });

  it('HTTP 429 and success: false keep the cached cards', async () => {
    let status = 200;
    let success = true;
    const m = make({ responder: () => (status !== 200 ? { status } : success ? feedAnswer([card('a')]) : { status: 200, body: { success: false, reason: 'evaluation_error', cards: [] } }) });
    await m.getCards();
    status = 429;
    await flush(CARD_FEED_TTL_SECONDS * 1000);
    expect((await m.getCards()).cards.map((c) => c.id)).toEqual(['a']);
    status = 200;
    success = false;
    await flush(CARD_MIN_REFRESH_SECONDS * 1000);
    expect((await m.getCards()).cards.map((c) => c.id)).toEqual(['a']);
    expect(feeds()).toHaveLength(3);
  });

  it(`refreshes at most once per ${CARD_MIN_REFRESH_SECONDS} s; extra refreshes coalesce into one`, async () => {
    const m = make();
    await m.refreshCards();
    await m.refreshCards();
    await m.refreshCards();
    await m.refreshCards();
    expect(feeds()).toHaveLength(1);
    await flush(CARD_MIN_REFRESH_SECONDS * 1000 + 100);
    expect(feeds()).toHaveLength(2);
  });

  it('discards an answer that predates an identity change', async () => {
    const m = make();
    let release: () => void = () => undefined;
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn(
      (url: string, init: any) =>
        new Promise((resolve) => {
          release = () => resolve(original(url, init));
        }),
    );
    const p = m.getCards();
    await flush();
    m.invalidate(true); // identify / reset while the request is out
    release();
    await flush();
    expect((await p).cards).toEqual([]);
    expect(m.getUnreadCardCount()).toBe(0);
  });

  it('getCards({ cursor }) appends the next page to the feed (no etag on a later page)', async () => {
    const m = make({
      responder: (req) => (req.body.cursor === 'cur-2' ? feedAnswer([card('c')], { unreadCount: 3, etag: 'etag-2' }) : feedAnswer([card('a'), card('b')], { nextCursor: 'cur-2', unreadCount: 3 })),
    });
    const first = await m.getCards();
    expect(first.nextCursor).toBe('cur-2');
    const page = await m.getCards({ cursor: first.nextCursor });
    expect(feeds()[1].body).toMatchObject({ cursor: 'cur-2', limit: 20 });
    expect(feeds()[1].body.etag).toBeUndefined();
    expect(page.cards.map((c) => c.id)).toEqual(['c']);
    expect(page.nextCursor).toBeNull();
    const all = await m.getCards();
    expect(all.cards.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(all.unreadCount).toBe(3);
  });

  it('expired cards are hidden and do not count as unread', async () => {
    const m = make({ responder: () => feedAnswer([card('a'), card('b', { expiresAt: '2026-11-21T10:00:30.000Z' })]) });
    jest.setSystemTime(new Date('2026-11-21T10:00:00.000Z'));
    expect((await m.getCards()).cards).toHaveLength(2);
    jest.setSystemTime(new Date('2026-11-21T10:01:00.000Z'));
    const feed = await m.getCards();
    expect(feed.cards.map((c) => c.id)).toEqual(['a']);
    expect(feed.unreadCount).toBe(1);
  });

  it('the session cache serves the next page view for the same visitor only', async () => {
    const first = make();
    await first.getCards();
    const second = new CardManager('https://api.example/api', SDK_KEY, identity, session, logger, { consent: () => 'granted' });
    expect(second.getUnreadCardCount()).toBe(2);
    await second.getCards();
    expect(feeds()).toHaveLength(1);
    anonymousId = 'anon-2';
    const other = new CardManager('https://api.example/api', SDK_KEY, identity, session, logger, { consent: () => 'granted' });
    expect(other.getUnreadCardCount()).toBe(0);
  });
});

describe('cards: the device caches are per workspace', () => {
  it('names both keys after a hash of the SDK key, never the key itself', () => {
    const hash = bucketHash(SDK_KEY).toString(36);
    expect(cardsFeedStorageKey(SDK_KEY)).toBe(`joryio_cards_v1_${hash}`);
    expect(cardsDeviceStorageKey(SDK_KEY)).toBe(`joryio_cards_device_v1_${hash}`);
    expect(cardsFeedStorageKey(SDK_KEY)).not.toContain(SDK_KEY);
    expect(cardsFeedStorageKey('jry_other')).not.toBe(cardsFeedStorageKey(SDK_KEY));
    expect(cardsDeviceStorageKey('jry_other')).not.toBe(cardsDeviceStorageKey(SDK_KEY));
  });

  it("another workspace on the same site reads neither the feed nor the read / dismissed state", async () => {
    const m = make({ responder: () => feedAnswer([card('camp-1'), card('camp-2')], { stateScope: 'device', unreadCount: 2 }) });
    await m.getCards();
    m.dismissCard('camp-2');
    expect(session_.has(cardsFeedStorageKey(SDK_KEY))).toBe(true);
    expect(local_.has(DEVICE_KEY)).toBe(true);

    const other = new CardManager('https://api.example/api', 'jry_other_workspace', identity, session, logger, { consent: () => 'granted' });
    // Same visitor ids, other workspace: nothing cached for it.
    expect(other.getUnreadCardCount()).toBe(0);
    expect((await other.getCards()).cards.map((c) => c.id)).toEqual(['camp-1', 'camp-2']);
    // Its reset leaves the first workspace's state alone.
    other.invalidate(true);
    expect(local_.has(DEVICE_KEY)).toBe(true);
    expect(session_.has(cardsFeedStorageKey(SDK_KEY))).toBe(true);
  });

  it('the legacy origin-wide entries are never read and are removed on start', () => {
    session_.set(
      'joryio_cards_v1',
      JSON.stringify({ subject: '|anon-1', fetchedAt: Date.now(), ttlSeconds: 300, unreadCount: 1, stateScope: 'server', cards: [card('legacy')] }),
    );
    local_.set('joryio_cards_device_v1', JSON.stringify({ anonymousId: 'anon-1', read: ['legacy'], dismissed: [] }));
    const m = make();
    expect(m.getUnreadCardCount()).toBe(0);
    expect(session_.has('joryio_cards_v1')).toBe(false);
    expect(local_.has('joryio_cards_device_v1')).toBe(false);
  });
});

describe('cards: reporting', () => {
  it('a report is exactly { deliveryToken, action, sessionId }; read sends viewed first; read twice sends nothing more', async () => {
    const m = make();
    await m.getCards();
    m.markCardRead('a');
    m.markCardRead('a');
    await flush();
    expect(tracks()).toEqual([
      { deliveryToken: 'tok-a', action: 'viewed', sessionId: 's-1' },
      { deliveryToken: 'tok-a', action: 'read', sessionId: 's-1' },
    ]);
    expect(m.getUnreadCardCount()).toBe(1);
  });

  it('a card already read by the server sends nothing on markCardRead', async () => {
    const m = make({ responder: () => feedAnswer([card('a', { read: true })]) });
    await m.getCards();
    m.markCardRead('a');
    await flush();
    expect(tracks()).toEqual([]);
  });

  it('clicked implies read; dismissed removes the card; listeners are told at once', async () => {
    const m = make();
    await m.getCards();
    const seen: number[] = [];
    m.onCardsUpdated((feed) => seen.push(feed.cards.length * 10 + feed.unreadCount));
    m.markCardClicked('a');
    let feed = await m.getCards();
    expect(feed.cards.find((c) => c.id === 'a')).toMatchObject({ read: true, clicked: true });
    expect(feed.unreadCount).toBe(1);
    m.markCardRead('a'); // already read by the click: nothing
    m.dismissCard('b');
    feed = await m.getCards();
    expect(feed.cards.map((c) => c.id)).toEqual(['a']);
    expect(feed.unreadCount).toBe(0);
    await flush();
    expect(tracks().map((t) => `${t.deliveryToken}:${t.action}`)).toEqual(['tok-a:viewed', 'tok-a:clicked', 'tok-b:viewed', 'tok-b:dismissed']);
    expect(seen).toEqual([21, 10]);
  });

  it('onCardsUpdated answers a JoryioSubscription: cancel() (or calling it) stops the updates, twice is harmless', async () => {
    const m = make();
    await m.getCards();
    const seen: string[] = [];
    const listener = () => seen.push('x');
    const a = m.onCardsUpdated(listener);
    const b = m.onCardsUpdated(listener); // the same function twice: two subscriptions
    expect(typeof a.cancel).toBe('function');
    m.markCardRead('a');
    expect(seen).toEqual(['x', 'x']);
    a.cancel();
    a.cancel();
    a();
    m.markCardRead('b');
    expect(seen).toEqual(['x', 'x', 'x']);
    b();
    m.dismissCard('a');
    expect(seen).toEqual(['x', 'x', 'x']);
    // Not a function: a no-op subscription.
    const none = m.onCardsUpdated(undefined as any);
    expect(() => none.cancel()).not.toThrow();
  });

  it('an unknown card, or a card object from before a replacement, reports nothing', async () => {
    const m = make();
    const feed = await m.getCards();
    m.markCardRead('zzz');
    m.markCardRead({ ...feed.cards[0], createdAt: '2025-01-01T00:00:00.000Z' });
    await flush();
    expect(tracks()).toEqual([]);
    m.markCardRead(feed.cards[0]);
    await flush();
    expect(tracks().map((t) => t.action)).toEqual(['viewed', 'read']);
  });
});

describe('cards: an anonymous visitor (stateScope "device")', () => {
  const deviceFeed = () => feedAnswer([card('camp-1'), card('camp-2')], { stateScope: 'device', unreadCount: 2 });

  it('keeps read / dismissed in localStorage and applies them to every feed; identify / reset clears them', async () => {
    const m = make({ responder: deviceFeed });
    await m.getCards();
    m.markCardRead('camp-1');
    m.dismissCard('camp-2');
    expect(JSON.parse(local_.get(DEVICE_KEY)!)).toEqual({ anonymousId: 'anon-1', read: ['camp-1'], dismissed: ['camp-2'] });

    // A new page load (no session cache): the server sends both as unread again.
    session_.clear();
    const reload = new CardManager('https://api.example/api', SDK_KEY, identity, session, logger, { consent: () => 'granted' });
    const feed = await reload.getCards();
    expect(feed.cards.map((c) => [c.id, c.read])).toEqual([['camp-1', true]]);
    expect(feed.unreadCount).toBe(0);

    reload.invalidate(true);
    expect(local_.has(DEVICE_KEY)).toBe(false);
  });

  it('another anonymous visitor does not inherit the stored state', async () => {
    const m = make({ responder: deviceFeed });
    await m.getCards();
    m.dismissCard('camp-2');
    session_.clear();
    anonymousId = 'anon-2';
    const other = new CardManager('https://api.example/api', SDK_KEY, identity, session, logger, { consent: () => 'granted' });
    expect((await other.getCards()).cards).toHaveLength(2);
  });

  it('a server-kept feed writes nothing to localStorage', async () => {
    const m = make();
    await m.getCards();
    m.markCardRead('a');
    m.dismissCard('b');
    expect(local_.has(DEVICE_KEY)).toBe(false);
  });

  it('caps the stored ids at 500, oldest first out', async () => {
    const many = Array.from({ length: 505 }, (_, i) => card(`c${i}`));
    const m = make({ responder: () => feedAnswer(many, { stateScope: 'device' }) });
    await m.getCards();
    many.forEach((c) => m.dismissCard(c.id));
    const stored = JSON.parse(local_.get(DEVICE_KEY)!);
    expect(stored.dismissed).toHaveLength(500);
    expect(stored.dismissed[0]).toBe('c5');
  });
});

describe('cards: the default feed (mountCardFeed)', () => {
  const host = () => new FakeEl('div') as any;

  it('draws title, body, pinned marker, unread dot and dismiss control as text, with overridable labels', async () => {
    const m = make({ responder: () => feedAnswer([card('a', { pinned: true, title: '<b>Hi</b>', imageUrl: 'https://cdn.example/x.png', buttonText: 'Open', url: 'https://shop.example/sale' }), card('b', { read: true })]) });
    const el = host();
    m.mountCardFeed(el, { pinnedLabel: 'Épinglé', dismissLabel: 'Fermer', unreadLabel: 'Non lu' });
    await flush();
    const cards = byClass(el, 'joryio-card');
    expect(cards).toHaveLength(2);
    expect(byClass(cards[0], 'joryio-card-title')[0].textContent).toBe('<b>Hi</b>');
    expect(byClass(cards[0], 'joryio-card-pinned')[0].textContent).toBe('Épinglé');
    expect(byClass(cards[0], 'joryio-card-unread')[0].getAttribute('aria-label')).toBe('Non lu');
    expect(byClass(cards[0], 'joryio-card-dismiss')[0].getAttribute('aria-label')).toBe('Fermer');
    expect(byClass(cards[0], 'joryio-card-image')[0].src).toBe('https://cdn.example/x.png');
    expect(byClass(cards[0], 'joryio-card-button')[0].textContent).toBe('Open');
    expect(byClass(cards[1], 'joryio-card-unread')).toHaveLength(0);
    expect(el.getAttribute('data-joryio-card-feed-state')).toBe('filled');
  });

  it('shows "No messages yet" when empty, or the text given', async () => {
    const m = make({ responder: () => feedAnswer([]) });
    const a = host();
    const b = host();
    m.mountCardFeed(a);
    m.mountCardFeed(b, { emptyText: 'Nothing here' });
    await flush();
    expect(byClass(a, 'joryio-card-feed-empty')[0].textContent).toBe('No messages yet');
    expect(byClass(b, 'joryio-card-feed-empty')[0].textContent).toBe('Nothing here');
  });

  it('reports viewed then read after half the card was on screen for the dwell', async () => {
    const m = make();
    const el = host();
    m.mountCardFeed(el);
    await flush();
    const [first] = byClass(el, 'joryio-card');
    view(first, 0.4);
    await flush(IN_APP_DISPLAY_DWELL_MS + 10);
    expect(tracks()).toEqual([]);
    view(first, 0.6);
    await flush(IN_APP_DISPLAY_DWELL_MS - 100);
    expect(tracks()).toEqual([]);
    await flush(200);
    expect(tracks().map((t) => `${t.deliveryToken}:${t.action}`)).toEqual(['tok-a:viewed', 'tok-a:read']);
    // Redrawn as read: no unread dot.
    expect(byClass(byClass(el, 'joryio-card')[0], 'joryio-card-unread')).toHaveLength(0);
  });

  it('the x dismisses the card (it leaves the feed); remove() takes the feed out', async () => {
    const m = make();
    const el = host();
    const handle = m.mountCardFeed(el)!;
    await flush();
    byClass(byClass(el, 'joryio-card')[1], 'joryio-card-dismiss')[0].click();
    await flush();
    expect(byClass(el, 'joryio-card').map((c) => c.getAttribute('data-joryio-card'))).toEqual(['a']);
    expect(tracks().map((t) => t.action)).toEqual(['viewed', 'dismissed']);
    handle.remove();
    expect(el.children).toHaveLength(0);
  });

  it('a tap reports clicked, then opens http(s), hands a deep link to onDeepLink, and never opens a refused scheme', async () => {
    const m = make({
      responder: () =>
        feedAnswer([
          card('web', { url: 'https://shop.example/sale', buttonText: 'Shop' }),
          card('deep', { url: 'myapp://cart' }),
          card('bad', { url: 'javascript:alert(1)' }),
        ]),
    });
    const onDeepLink = jest.fn();
    const el = host();
    m.mountCardFeed(el, { onDeepLink });
    await flush();
    const [web, deep, bad] = byClass(el, 'joryio-card');
    byClass(web, 'joryio-card-button')[0].click();
    expect((globalThis as any).window.open).toHaveBeenCalledWith('https://shop.example/sale', '_blank', 'noopener');
    deep.click();
    expect(onDeepLink).toHaveBeenCalledWith('myapp://cart', expect.objectContaining({ id: 'deep' }));
    bad.click();
    expect((globalThis as any).window.open).toHaveBeenCalledTimes(1);
    expect(onDeepLink).toHaveBeenCalledTimes(1);
    await flush();
    expect(tracks().filter((t) => t.action === 'clicked').map((t) => t.deliveryToken)).toEqual(['tok-web', 'tok-deep', 'tok-bad']);
  });

  it('the site-wide link handler sees every card link first, with the card and campaign ids', async () => {
    const m = make({
      responder: () =>
        feedAnswer([card('web', { url: 'https://shop.example/sale' }), card('deep', { url: 'myapp://cart' }), card('bad', { url: 'data:text/html,x' })]),
    });
    m.links = new LinkRouter();
    const seen: JoryioLink[] = [];
    m.links.setHandler((link) => (seen.push(link), link.isAppDeepLink));
    const onDeepLink = jest.fn();
    const el = host();
    m.mountCardFeed(el, { onDeepLink });
    await flush();
    const [web, deep, bad] = byClass(el, 'joryio-card');
    web.click();
    deep.click();
    bad.click();
    expect(seen.map((l) => [l.url, l.source, l.cardId])).toEqual([
      ['https://shop.example/sale', 'card', 'web'],
      ['myapp://cart', 'card', 'deep'],
    ]);
    expect(seen[0].campaignId).toBeTruthy();
    // Declined: the http(s) link opens as without a handler. Taken: onDeepLink is not called.
    expect((globalThis as any).window.open).toHaveBeenCalledWith('https://shop.example/sale', '_blank', 'noopener');
    expect(onDeepLink).not.toHaveBeenCalled();
  });

  it('an identity change empties the drawn feed at once and asks again', async () => {
    const m = make();
    const el = host();
    m.mountCardFeed(el);
    await flush();
    expect(byClass(el, 'joryio-card')).toHaveLength(2);
    (globalThis as any).fetch = jest.fn(() => new Promise(() => undefined));
    m.invalidate(true);
    expect(byClass(el, 'joryio-card')).toHaveLength(0);
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
  });

  it('loads the next page when the end of the feed comes into view', async () => {
    const m = make({
      responder: (req) => (req.body.cursor ? feedAnswer([card('c')], { unreadCount: 3 }) : feedAnswer([card('a'), card('b')], { nextCursor: 'cur-2', unreadCount: 3 })),
    });
    const el = host();
    m.mountCardFeed(el);
    await flush();
    const end = byClass(el, 'joryio-card-feed-end')[0];
    view(end, 1);
    await flush();
    expect(feeds().map((f) => f.body.cursor)).toEqual([undefined, 'cur-2']);
    expect(byClass(el, 'joryio-card').map((c) => c.getAttribute('data-joryio-card'))).toEqual(['a', 'b', 'c']);
  });
});

describe('cards: the feed renderer is its own file (joryio-cards-ui.min.js)', () => {
  const host = () => new FakeEl('div') as any;

  it('is loaded only when a feed is mounted, from the SDK host (exact version, then the major channel), once per page', async () => {
    const m = make();
    await m.getCards();
    m.markCardViewed('a');
    expect(loaded).toEqual([]);
    const a = host();
    const handle = m.mountCardFeed(a);
    // The handle comes back at once; the feed is drawn when the file is there.
    expect(handle).toEqual({ element: a, remove: expect.any(Function) });
    await flush();
    expect(loaded).toEqual([sdkHostFileUrls(CARDS_UI_BUNDLE_FILE)[0]]);
    expect(loaded[0]).toMatch(/^https:\/\/sdk\.joryio\.com\/web\/\d+\.\d+\.\d+[^/]*\/joryio-cards-ui\.min\.js$/);
    expect(byClass(a, 'joryio-card')).toHaveLength(2);
    // A second feed draws at once, without loading anything again.
    const b = host();
    m.mountCardFeed(b);
    expect(byClass(b, 'joryio-card')).toHaveLength(2);
    expect(loaded).toHaveLength(1);
  });

  it('draws at once when the renderer is already on the page (a bundler imported it)', async () => {
    (globalThis as any).window[CARDS_UI_GLOBAL] = cardsUiApi;
    const m = make();
    await m.getCards();
    const el = host();
    m.mountCardFeed(el);
    expect(byClass(el, 'joryio-card')).toHaveLength(2);
    expect(loaded).toEqual([]);
  });

  it('cardsUiScriptUrl replaces the SDK host (self-hosted SDK)', async () => {
    const m = make({ cardsUiScriptUrl: 'https://cdn.shop.example/joryio-cards-ui.min.js' });
    m.mountCardFeed(host());
    await flush();
    expect(loaded).toEqual(['https://cdn.shop.example/joryio-cards-ui.min.js']);
  });

  it('when the file cannot load (CSP, network): a warning, the element marked unavailable, nothing throws, the data API still works, a later mount tries again', async () => {
    const tried: string[] = [];
    let fail = true;
    const m = make({
      loadScript: async (src) => {
        tried.push(src);
        if (fail) throw new Error('blocked by CSP');
        (globalThis as any).window[CARDS_UI_GLOBAL] = cardsUiApi;
      },
    });
    const el = host();
    const handle = m.mountCardFeed(el)!;
    await flush();
    expect(tried).toEqual(sdkHostFileUrls(CARDS_UI_BUNDLE_FILE));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(CARDS_UI_BUNDLE_FILE));
    expect(el.children).toHaveLength(0);
    expect(el.getAttribute('data-joryio-card-feed-state')).toBe('unavailable');
    // The data API is the core's: unaffected.
    const feed = await m.getCards();
    expect(feed.cards.map((c) => c.id)).toEqual(['a', 'b']);
    m.dismissCard('b');
    await flush();
    expect(tracks().map((t) => t.action)).toEqual(['viewed', 'dismissed']);
    expect(() => handle.remove()).not.toThrow();
    // Not cached as failed: the next mount tries again.
    fail = false;
    const again = host();
    m.mountCardFeed(again);
    await flush();
    expect(byClass(again, 'joryio-card').map((c) => c.getAttribute('data-joryio-card'))).toEqual(['a']);
  });

  it('a renderer of another contract version is refused like a missing one', async () => {
    const m = make({
      loadScript: async () => {
        (globalThis as any).window[CARDS_UI_GLOBAL] = { version: CARDS_UI_API_VERSION + 1, mount: jest.fn() };
      },
    });
    const el = host();
    m.mountCardFeed(el);
    await flush();
    expect((globalThis as any).window[CARDS_UI_GLOBAL].mount).not.toHaveBeenCalled();
    expect(el.getAttribute('data-joryio-card-feed-state')).toBe('unavailable');
  });

  it('remove() before the file has loaded: nothing is ever drawn into the element', async () => {
    let finish: () => void = () => undefined;
    const m = make({
      loadScript: (src) =>
        new Promise<void>((resolve) => {
          finish = () => {
            loaded.push(src);
            (globalThis as any).window[CARDS_UI_GLOBAL] = cardsUiApi;
            resolve();
          };
        }),
    });
    const el = host();
    const handle = m.mountCardFeed(el)!;
    await flush();
    handle.remove();
    finish();
    await flush();
    expect(el.children).toHaveLength(0);
    expect(el.getAttribute('data-joryio-card-feed-state')).toBeNull();
    // The feed changing later draws nothing either.
    m.invalidate(false);
    await flush();
    expect(el.children).toHaveLength(0);
  });

  it('destroy() before the file has loaded draws nothing', async () => {
    let finish: () => void = () => undefined;
    const m = make({
      loadScript: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            (globalThis as any).window[CARDS_UI_GLOBAL] = cardsUiApi;
            resolve();
          };
        }),
    });
    const el = host();
    m.mountCardFeed(el);
    await flush();
    m.destroy();
    finish();
    await flush();
    expect(el.children).toHaveLength(0);
  });
});

describe('the card link rule', () => {
  it('an app deep link is a scheme:// link that is neither http(s) nor refused', () => {
    expect(isAppDeepLink('myapp://cart')).toBe(true);
    for (const url of ['https://x.example', 'javascript://x', 'data://x', 'file:///etc/passwd', 'intent://x', 'mailto:a@b.c', '']) {
      expect({ url, ok: isAppDeepLink(url) }).toEqual({ url, ok: false });
    }
  });
});
