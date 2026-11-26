/**
 * Content cards (docs/PLACEMENTS_PLAN.md section 11, BACKLOG D444 Phase 3): a
 * persistent feed per person - a message center inside the site. Cards come
 * from card campaigns and the journey step "Add card".
 *
 * Draw the feed with `mountCardFeed(element)`, or read it with `getCards()`
 * and draw it yourself, reporting with `markCardViewed` / `markCardRead` /
 * `markCardClicked` / `dismissCard`. The default feed's drawing code is a
 * separate file, `joryio-cards-ui.min.js`, loaded the first time a page mounts
 * a feed (src/core/cards-ui-contract.ts); everything else here is in the core.
 *
 * The rules, the same on every Joryio SDK (names and values pinned by the
 * backend's SDK parity specs):
 *
 * - `POST /v1/in-app/cards` with the visitor's ids, `limit`, `cursor`, `etag`
 *   (first page only), `trackingConsent` and the `cards` capability.
 * - The last feed is served from the cache (memory + sessionStorage, scoped
 *   to the visitor) for its `ttlSeconds` (CARD_FEED_TTL_SECONDS); at most one
 *   network refresh per CARD_MIN_REFRESH_SECONDS - a forced refresh inside
 *   that window is deferred to its end and coalesced.
 * - `notModified: true`, `success: false`, HTTP 429 or no answer keep the cache.
 * - An identity or consent change bumps a generation: an answer to a request
 *   made before it is discarded.
 * - A report (`POST /v1/in-app/track` `{ deliveryToken, action, sessionId }`)
 *   is applied to the cache at once and listeners are told; each action at
 *   most once per card; read / clicked / dismissed first count the card as
 *   viewed; clicked implies read.
 * - `stateScope: "device"` (an anonymous visitor): read / dismissed card ids
 *   are kept in localStorage, tied to the anonymous id, and applied to every
 *   feed; cleared on identify / reset / wipeData.
 * - Without tracking consent nothing is requested and nothing reported (an
 *   inbox is personal: the server answers an unconsented visitor an empty feed).
 * - Web has no silent push: the feed refreshes on the TTL, `refreshCards()`,
 *   identity and consent changes.
 */

import { JoryioSubscription, joryioSubscription } from './subscription';
import { Logger } from '../utils/logger';
import { bucketHash } from '../utils/bucket-hash';
import { sdkIdentityHeaders } from './config';
import { IdentityManager } from './identity';
import { SessionManager } from './session';
import { InAppAuthProvider } from './inapp';
import type { LinkRouter } from './links';
import { PlacementConsent, trackViewable } from './placements';
import { CARDS_UI_API_VERSION, CARDS_UI_BUNDLE_FILE, CARDS_UI_GLOBAL, CardFeedHost, CardFeedView, CardsUiBundleApi } from './cards-ui-contract';
import { loadSdkScript, sdkHostFileUrls } from './sdk-host-files';

/** The feed goes to the network at most once per this many seconds; extra calls coalesce. Same name and value on every Joryio SDK. */
export const CARD_MIN_REFRESH_SECONDS = 30;
/** A feed request that got no answer (no connection, a 5xx) holds the next one back this many seconds instead. A 429 keeps the full window. Same on every Joryio SDK. */
export const CARD_RETRY_AFTER_FAILURE_SECONDS = 3;
/** How long the feed is served from the cache before it is asked for again (the answer's `ttlSeconds` wins). Same on every Joryio SDK. */
export const CARD_FEED_TTL_SECONDS = 300;
/** The capability a card-aware SDK declares. */
export const CARD_SDK_CAPABILITY = 'cards';
/** What the SDK reports about a card: the `action` of `POST /v1/in-app/track`. Wire values. */
export const CARD_ACTIONS = {
  VIEWED: 'viewed',
  READ: 'read',
  CLICKED: 'clicked',
  DISMISSED: 'dismissed',
} as const;
export type CardAction = (typeof CARD_ACTIONS)[keyof typeof CARD_ACTIONS];

/** `server`: read / dismissed are kept per person on the server. `device`: an anonymous visitor - this browser keeps them. */
export type CardStateScope = 'server' | 'device';

/** Cards per request (the server's default page). */
const PAGE_SIZE = 20;
/** Read / dismissed ids an anonymous browser keeps (oldest dropped first). */
const DEVICE_STATE_MAX = 500;
/** The pre-scoping, origin-wide names - never read, removed on start. */
const LEGACY_FEED_STORAGE_NAME = 'joryio_cards_v1';
const LEGACY_DEVICE_STORAGE_NAME = 'joryio_cards_device_v1';
/**
 * Per workspace, like the flags and placements caches (flagsStorageKey,
 * placementsStorageKey): two workspaces on one site that know a visitor by the
 * same ids must never read each other's feed or read/dismissed state. Carries a
 * hash of the SDK key, never the key itself.
 */
export const cardsFeedStorageKey = (sdkKey: string): string => `joryio_cards_v1_${bucketHash(sdkKey).toString(36)}`;
export const cardsDeviceStorageKey = (sdkKey: string): string => `joryio_cards_device_v1_${bucketHash(sdkKey).toString(36)}`;

/** One card of the person's feed. */
export interface Card {
  /** Stable id of this card for this person. */
  id: string;
  /** Campaign id, or `journey:<canvasId>:<nodeId>` for a journey card. */
  campaignId: string;
  variantId: string | null;
  title: string | null;
  body: string | null;
  imageUrl: string | null;
  /** Button label; null = no button (the whole card opens `url` when set). */
  buttonText: string | null;
  /** An http(s) URL or the site's own deep link; null = nothing to open. */
  url: string | null;
  pinned: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null. */
  expiresAt: string | null;
  read: boolean;
  clicked: boolean;
}

/** The person's feed (or one page of it). */
export interface CardFeed {
  /** Pinned first, then newest first. */
  cards: Card[];
  /** Unread cards across the whole feed, not this page: the badge. */
  unreadCount: number;
  /** Pass to `getCards({ cursor })` for the next page; null on the last one. */
  nextCursor: string | null;
  stateScope: CardStateScope;
}

export interface GetCardsOptions {
  /** The `nextCursor` of the feed: load the page after it (added to the cached feed). */
  cursor?: string | null;
}

export type CardsUpdatedCallback = (feed: CardFeed) => void;

export interface MountCardFeedOptions {
  /** Shown when the feed is empty. Default "No messages yet". */
  emptyText?: string;
  /** The marker on a pinned card. Default "Pinned". */
  pinnedLabel?: string;
  /** The accessible label of the dismiss control. Default "Dismiss". */
  dismissLabel?: string;
  /** The accessible label of the unread dot. Default "Unread". */
  unreadLabel?: string;
  /**
   * A card's url is an app deep link (`myapp://...`): route it in your app
   * (the click is already reported). Without this only an http(s) link is
   * opened; the SDK never navigates to any other scheme. A handler set with
   * `setLinkHandler` sees every link first; this one is called when it
   * returns false.
   */
  onDeepLink?: (url: string, card: Card) => void;
  /** Called after each draw with the feed drawn. */
  onRender?: (feed: CardFeed, element: HTMLElement) => void;
}

export interface CardFeedHandle {
  element: HTMLElement;
  /** Stop filling the element and remove what the SDK drew. */
  remove(): void;
}

/** What the card manager needs from the SDK. */
export interface CardRuntime {
  /** The consent now, or null when nothing may be sent at all. Only `granted` requests and reports anything. */
  consent: () => PlacementConsent | null;
  requestTimeoutMs?: number;
  noteStatus?: (status: number, data: any) => void;
  /** Where `joryio-cards-ui.min.js` comes from (init `cardsUiScriptUrl`); default the SDK host. */
  cardsUiScriptUrl?: string;
  /** Tests: how a script is loaded. Default a script tag. */
  loadScript?: (src: string) => Promise<void>;
}

/** A card as the server sent it (with its delivery token - never handed out). */
interface WireCard extends Card {
  deliveryToken: string;
}

interface FeedMount {
  element: HTMLElement;
  options: MountCardFeedOptions;
  /** The renderer's view; null until joryio-cards-ui.min.js has loaded (or for good when it could not). */
  view: CardFeedView | null;
}

/** The renderer on the page, if it is one the core accepts (the contract version it was built for). */
function pageCardsUi(): CardsUiBundleApi | null {
  const api = typeof window !== 'undefined' ? (window as any)[CARDS_UI_GLOBAL] : null;
  return api && api.version === CARDS_UI_API_VERSION && typeof api.mount === 'function' ? api : null;
}

const nowMs = () => Date.now();

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseCard(o: any): WireCard | null {
  if (!o || typeof o !== 'object') return null;
  const id = str(o.id);
  const token = str(o.deliveryToken);
  if (!id || !token) return null;
  return {
    id,
    campaignId: str(o.campaignId) || '',
    variantId: str(o.variantId),
    title: str(o.title),
    body: str(o.body),
    imageUrl: str(o.imageUrl),
    buttonText: str(o.buttonText),
    url: str(o.url),
    pinned: o.pinned === true,
    createdAt: str(o.createdAt) || '',
    expiresAt: str(o.expiresAt),
    read: o.read === true,
    clicked: o.clicked === true,
    deliveryToken: token,
  };
}

function parseCards(list: unknown): WireCard[] {
  return Array.isArray(list) ? (list.map(parseCard).filter(Boolean) as WireCard[]) : [];
}

function publicCard(c: WireCard, read: boolean, clicked: boolean): Card {
  return {
    id: c.id,
    campaignId: c.campaignId,
    variantId: c.variantId,
    title: c.title,
    body: c.body,
    imageUrl: c.imageUrl,
    buttonText: c.buttonText,
    url: c.url,
    pinned: c.pinned,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    read,
    clicked,
  };
}

export class CardManager {
  /** The SDK's link router (`setLinkHandler`); set by the SDK after construction. */
  links: LinkRouter | null = null;
  // The feed as the server sent it (first page plus any pages loaded after it).
  private wireCards: WireCard[] = [];
  private serverUnread = 0;
  private nextCursor: string | null = null;
  private stateScope: CardStateScope = 'server';
  private etag: string | null = null;
  private ttlSeconds = CARD_FEED_TTL_SECONDS;
  private fetchedAt: number | null = null;
  private lastNetworkAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<CardsUpdatedCallback>();
  private mounts = new Set<FeedMount>();
  /** `action:cardId` already reported (each action at most once per card). */
  private reported = new Set<string>();
  /** What this browser did since the last identity change, keyed by card id + createdAt (a replaced card is a new one). */
  private overlayRead = new Set<string>();
  private overlayClicked = new Set<string>();
  private overlayDismissed = new Set<string>();
  /** An anonymous visitor's state, by card id, in localStorage. Cleared on identify / reset. */
  private deviceRead = new Set<string>();
  private deviceDismissed = new Set<string>();
  /** Bumped when WHO the feed is for changes; older answers are discarded. */
  private generation = 0;
  private destroyed = false;
  /** The card feed renderer once loaded (kept: a later change to the global is not read again). */
  private cardsUi: CardsUiBundleApi | null = null;
  private cardsUiLoading: Promise<CardsUiBundleApi | null> | null = null;

  constructor(
    private apiEndpoint: string,
    private sdkKey: string,
    private identity: IdentityManager,
    private session: SessionManager,
    private logger: Logger,
    private runtime: CardRuntime,
    private auth?: InAppAuthProvider,
  ) {
    this.removeLegacyStorage();
    this.loadFeedCache();
    this.loadDeviceState();
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** The feed (from the cache while fresh), or with `cursor` the page after it, added to the feed. */
  async getCards(options: GetCardsOptions = {}): Promise<CardFeed> {
    const cursor = options && typeof options.cursor === 'string' && options.cursor ? options.cursor : null;
    if (cursor) return this.loadPage(cursor);
    if (!this.fresh()) await this.fetch(false);
    return this.view();
  }

  /** The unread count of the cached feed. Never goes to the network. */
  getUnreadCardCount(): number {
    return this.view().unreadCount;
  }

  /** Ask the server again (at most once per CARD_MIN_REFRESH_SECONDS; inside it, deferred to its end). */
  async refreshCards(): Promise<void> {
    await this.fetch(true);
  }

  /** Called with the whole feed whenever it changes. Returns a JoryioSubscription. */
  onCardsUpdated(callback: CardsUpdatedCallback): JoryioSubscription {
    if (typeof callback !== 'function') return joryioSubscription(() => undefined);
    // One entry per subscription, so the same function subscribed twice is two subscriptions.
    const entry: CardsUpdatedCallback = (feed) => callback(feed);
    this.listeners.add(entry);
    return joryioSubscription(() => {
      this.listeners.delete(entry);
    });
  }

  markCardViewed(card: Card | string): void {
    this.report(card, CARD_ACTIONS.VIEWED);
  }

  markCardRead(card: Card | string): void {
    this.report(card, CARD_ACTIONS.READ);
  }

  markCardClicked(card: Card | string): void {
    this.report(card, CARD_ACTIONS.CLICKED);
  }

  dismissCard(card: Card | string): void {
    this.report(card, CARD_ACTIONS.DISMISSED);
  }

  /**
   * Draw the feed into `element` and keep it up to date. Returns a handle at
   * once; the feed is drawn as soon as the renderer file is there (at once
   * when it already is). If it cannot be loaded (a Content-Security-Policy
   * without the SDK host, a network failure) a warning is logged, the element
   * gets `data-joryio-card-feed-state="unavailable"` and stays as the site
   * left it - nothing throws, and the data API keeps working.
   */
  mountCardFeed(element: HTMLElement, options: MountCardFeedOptions = {}): CardFeedHandle | null {
    if (!element || typeof (element as any).appendChild !== 'function') {
      this.logger.warn('mountCardFeed: an element is required');
      return null;
    }
    if (typeof document === 'undefined') return null;
    for (const existing of this.mounts) if (existing.element === element) this.unmount(existing);
    const mount: FeedMount = { element, options: options || {}, view: null };
    this.mounts.add(mount);
    if (!this.fresh()) this.fetch(false).catch(() => undefined);
    // Already on the page (loaded for an earlier feed, or imported by a bundler): draw now.
    this.cardsUi = this.cardsUi || pageCardsUi();
    if (this.cardsUi) this.attach(mount, this.cardsUi);
    else
      void this.loadCardsUi().then((api) => {
        if (!this.mounts.has(mount)) return; // removed (or destroyed) before the file came
        if (api) this.attach(mount, api);
        else element.setAttribute('data-joryio-card-feed-state', 'unavailable');
      });
    return { element, remove: () => this.unmount(mount) };
  }

  /**
   * The person or the consent changed: forget the feed (and, for a new
   * person, the anonymous visitor's device state), tell the listeners, and
   * ask again when the site shows or listens to the feed.
   */
  invalidate(clearDeviceState: boolean): void {
    this.generation++;
    this.wireCards = [];
    this.serverUnread = 0;
    this.nextCursor = null;
    this.stateScope = 'server';
    this.etag = null;
    this.ttlSeconds = CARD_FEED_TTL_SECONDS;
    this.fetchedAt = null;
    this.lastNetworkAt = null;
    this.inflight = null;
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    this.reported.clear();
    this.overlayRead.clear();
    this.overlayClicked.clear();
    this.overlayDismissed.clear();
    if (clearDeviceState) {
      this.deviceRead.clear();
      this.deviceDismissed.clear();
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(cardsDeviceStorageKey(this.sdkKey));
      } catch {
        /* storage blocked */
      }
    }
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(cardsFeedStorageKey(this.sdkKey));
    } catch {
      /* storage blocked */
    }
    const watched = this.listeners.size > 0 || this.mounts.size > 0;
    // The previous person's cards go NOW: they must not stay in front of the next person.
    this.notify();
    if (watched && !this.destroyed) this.fetch(true).catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    for (const mount of Array.from(this.mounts)) this.unmount(mount);
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    this.listeners.clear();
  }

  // ── fetching ────────────────────────────────────────────────────────────

  private fresh(): boolean {
    return this.fetchedAt !== null && nowMs() - this.fetchedAt < this.ttlSeconds * 1000;
  }

  /**
   * Ask for the first page. A request already running is joined; inside
   * CARD_MIN_REFRESH_SECONDS of the last one nothing goes out - a forced
   * refresh is deferred to the end of that window, anything else gets the cache.
   */
  private fetch(force: boolean): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.inflight) {
      if (force) this.defer();
      return this.inflight;
    }
    if (this.lastNetworkAt !== null && nowMs() - this.lastNetworkAt < CARD_MIN_REFRESH_SECONDS * 1000) {
      if (force) this.defer();
      return Promise.resolve();
    }
    const run = this.requestFirstPage().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private defer(): void {
    if (this.deferredTimer) return;
    const wait = Math.max(0, (this.lastNetworkAt ?? 0) + CARD_MIN_REFRESH_SECONDS * 1000 - nowMs());
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      if (!this.destroyed) this.fetch(false).catch(() => undefined);
    }, wait + 10);
  }

  /** One POST; null when there is nothing to use (no consent, failure, 429, success false, a stale answer). */
  private async post(cursor: string | null): Promise<{ data: any; generation: number } | null> {
    const consent = this.runtime.consent();
    // An inbox is personal: without consent the server would answer an empty
    // feed, so nothing is asked (and nobody named).
    if (consent !== 'granted' || this.destroyed) return null;
    const generation = this.generation;
    const sentAt = nowMs();
    if (!cursor) this.lastNetworkAt = sentAt;
    // No answer or a server error: the next refresh may go after
    // CARD_RETRY_AFTER_FAILURE_SECONDS, not the whole window (1.4.0-beta.12).
    const failed = () => {
      if (!cursor && this.lastNetworkAt === sentAt) {
        this.lastNetworkAt = sentAt - (CARD_MIN_REFRESH_SECONDS - CARD_RETRY_AFTER_FAILURE_SECONDS) * 1000;
      }
    };
    const userId = this.identity.getUserId();
    const anonymousId = this.identity.getAnonymousId();
    const body: Record<string, any> = {
      ...(userId ? { userId } : {}),
      anonymousId,
      sessionId: this.session.getSessionId(),
      deviceType: 'web',
      locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
      capabilities: [CARD_SDK_CAPABILITY, 'content.native'],
      trackingConsent: consent,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(!cursor && this.etag ? { etag: this.etag } : {}),
    };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), this.runtime.requestTimeoutMs ?? 10000);
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/in-app/cards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...sdkIdentityHeaders(),
          ...(this.auth?.getSdkAuthHeaders(userId, userId ? null : anonymousId) || {}),
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        // 429 (the per-device limit) and every other failure: keep the cache.
        this.runtime.noteStatus?.(response.status, null);
        this.logger.debug(`Card feed request answered ${response.status}; keeping the cached feed`);
        if (response.status >= 500) failed();
        return null;
      }
      const data = await response.json();
      if (generation !== this.generation) {
        this.logger.debug('Discarding a card feed answer that predates an identity or consent change');
        return null;
      }
      if (!data || typeof data !== 'object' || data.success === false) {
        this.logger.debug('Card feed answered success: false; keeping the cached feed');
        return null;
      }
      return { data, generation };
    } catch (error) {
      const timedOut = (error as any)?.name === 'AbortError';
      this.logger.debug(timedOut ? 'Card feed request timed out' : 'Card feed request failed', error);
      failed();
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestFirstPage(): Promise<void> {
    const answer = await this.post(null);
    if (!answer || answer.generation !== this.generation) return;
    const { data } = answer;
    const t = nowMs();
    this.ttlSeconds = typeof data.ttlSeconds === 'number' && data.ttlSeconds > 0 ? data.ttlSeconds : CARD_FEED_TTL_SECONDS;
    let changed = false;
    if (data.notModified === true && this.fetchedAt !== null) {
      // The feed we hold is still the feed: keep the cards.
      this.fetchedAt = t;
    } else if (data.notModified === true) {
      // notModified for an etag we no longer hold the cards of: ask again without it.
      this.etag = null;
      this.lastNetworkAt = null;
      return this.requestFirstPage();
    } else {
      const before = JSON.stringify(this.view());
      this.wireCards = parseCards(data.cards);
      this.serverUnread = typeof data.unreadCount === 'number' ? Math.max(0, data.unreadCount) : 0;
      this.nextCursor = str(data.nextCursor);
      this.stateScope = data.stateScope === 'device' ? 'device' : 'server';
      this.etag = str(data.etag);
      this.fetchedAt = t;
      changed = before !== JSON.stringify(this.view());
    }
    this.persistFeed();
    if (changed) this.notify();
  }

  /** The page after `cursor`: added to the cached feed; returns that page (with this browser's state applied). */
  private async loadPage(cursor: string): Promise<CardFeed> {
    const answer = await this.post(cursor);
    if (!answer || answer.generation !== this.generation) return { ...this.view(), cards: [] };
    const { data } = answer;
    const cards = parseCards(data.cards);
    const known = new Set(this.wireCards.map((c) => c.id));
    this.wireCards = this.wireCards.concat(cards.filter((c) => !known.has(c.id)));
    this.nextCursor = str(data.nextCursor);
    if (typeof data.unreadCount === 'number') this.serverUnread = Math.max(0, data.unreadCount);
    this.persistFeed();
    const full = this.view();
    const ids = new Set(cards.map((c) => c.id));
    this.notify();
    return { ...full, cards: full.cards.filter((c) => ids.has(c.id)) };
  }

  private notify(): void {
    for (const mount of this.mounts) this.render(mount);
    if (!this.listeners.size) return;
    const feed = this.view();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(feed);
      } catch (error) {
        this.logger.error('The onCardsUpdated callback threw; ignored:', error);
      }
    }
  }

  // ── the feed with this browser's state ──────────────────────────────────

  private key(c: WireCard): string {
    return `${c.id}\u0000${c.createdAt}`;
  }

  /**
   * The cached feed with what this browser did applied: dismissed and
   * expired cards removed, read / clicked set, and the unread count lowered
   * by each card the server counted as unread that is no longer.
   */
  private view(): CardFeed {
    const t = nowMs();
    let unread = this.serverUnread;
    const out: Card[] = [];
    for (const c of this.wireCards) {
      const key = this.key(c);
      const dismissed = this.overlayDismissed.has(key) || this.deviceDismissed.has(c.id);
      const expiresAt = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
      const expired = Number.isFinite(expiresAt) && expiresAt <= t;
      const clicked = c.clicked || this.overlayClicked.has(key);
      const read = c.read || clicked || this.overlayRead.has(key) || this.deviceRead.has(c.id);
      if (!c.read && (read || dismissed || expired)) unread--;
      if (dismissed || expired) continue;
      out.push(publicCard(c, read, clicked));
    }
    return { cards: out, unreadCount: Math.max(0, unread), nextCursor: this.nextCursor, stateScope: this.stateScope };
  }

  // ── reporting ───────────────────────────────────────────────────────────

  /**
   * A report: applied to the cache at once (listeners told), sent to
   * /v1/in-app/track only with consent. Each action at most once per card;
   * read / clicked / dismissed first count the card as viewed; `read` on a
   * card already read sends nothing.
   */
  private report(cardOrId: Card | string, action: CardAction): void {
    const id = typeof cardOrId === 'string' ? cardOrId : cardOrId?.id;
    const createdAt = typeof cardOrId === 'string' ? null : cardOrId?.createdAt;
    // A card of someone who is no longer here (identify / reset since), a
    // replaced card, or an unknown id: nothing.
    const card = this.wireCards.find((c) => c.id === id && (createdAt == null || c.createdAt === createdAt));
    if (!card) {
      this.logger.debug(`Card report ignored: ${String(id)} is not in the current feed`);
      return;
    }
    const key = this.key(card);
    const alreadyRead =
      card.read || card.clicked || this.overlayRead.has(key) || this.overlayClicked.has(key) || this.deviceRead.has(card.id);
    if (action === CARD_ACTIONS.READ && alreadyRead) {
      this.reported.add(`${CARD_ACTIONS.READ}:${card.id}`);
      return;
    }
    const once = `${action}:${card.id}`;
    if (this.reported.has(once)) return;
    this.reported.add(once);
    const toSend: CardAction[] = [];
    if (action !== CARD_ACTIONS.VIEWED && !this.reported.has(`${CARD_ACTIONS.VIEWED}:${card.id}`)) {
      this.reported.add(`${CARD_ACTIONS.VIEWED}:${card.id}`);
      toSend.push(CARD_ACTIONS.VIEWED);
    }
    toSend.push(action);
    const device = this.stateScope === 'device';
    if (action === CARD_ACTIONS.READ || action === CARD_ACTIONS.CLICKED) {
      this.overlayRead.add(key);
      if (device) this.deviceRead.add(card.id);
    }
    if (action === CARD_ACTIONS.CLICKED) {
      this.overlayClicked.add(key);
      this.reported.add(`${CARD_ACTIONS.READ}:${card.id}`);
    }
    if (action === CARD_ACTIONS.DISMISSED) {
      this.overlayDismissed.add(key);
      if (device) this.deviceDismissed.add(card.id);
    }
    if (device && action !== CARD_ACTIONS.VIEWED) this.persistDeviceState();
    if (action !== CARD_ACTIONS.VIEWED) this.notify();
    if (this.runtime.consent() !== 'granted') return;
    const sessionId = this.session.getSessionId();
    for (const a of toSend) this.send({ deliveryToken: card.deliveryToken, action: a, sessionId });
  }

  private send(body: { deliveryToken: string; action: CardAction; sessionId: string }): void {
    const userId = this.identity.getUserId();
    fetch(`${this.apiEndpoint}/v1/in-app/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Key': this.sdkKey,
        ...sdkIdentityHeaders(),
        ...(this.auth?.getSdkAuthHeaders(userId, userId ? null : this.identity.getAnonymousId()) || {}),
      },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) this.runtime.noteStatus?.(response.status, null);
      })
      .catch((error) => this.logger.debug('Card report failed', error));
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  /**
   * The renderer file, once per page: the global when it is already there
   * (loaded before, or imported by a bundler), else a script tag from the SDK
   * host (exact version, then the major channel) or `cardsUiScriptUrl`. A
   * failure is warned once per attempt and not cached, so a later mount tries again.
   */
  private loadCardsUi(): Promise<CardsUiBundleApi | null> {
    if (this.cardsUiLoading) return this.cardsUiLoading;
    const run = (async () => {
      let api = pageCardsUi();
      const load = this.runtime.loadScript ?? ((src: string) => loadSdkScript(src, 'data-joryio-cards-ui'));
      for (const src of api ? [] : sdkHostFileUrls(CARDS_UI_BUNDLE_FILE, this.runtime.cardsUiScriptUrl)) {
        try {
          await load(src);
          api = pageCardsUi();
          if (api) break;
        } catch (error) {
          this.logger.debug('Joryio card feed file failed to load', error);
        }
      }
      if (!api) {
        // Short on purpose: every byte of the core is downloaded by every visitor.
        this.logger.warn(`mountCardFeed: ${CARDS_UI_BUNDLE_FILE} could not be loaded (Content-Security-Policy script-src?)`);
      }
      this.cardsUi = api;
      return api;
    })().catch(() => null);
    this.cardsUiLoading = run;
    void run.then((api) => {
      if (!api) this.cardsUiLoading = null;
    });
    return run;
  }

  private attach(mount: FeedMount, api: CardsUiBundleApi): void {
    try {
      mount.view = api.mount(mount.element, mount.options, this.feedHost(mount));
      mount.view.render();
    } catch (error) {
      this.logger.error('The card feed could not be drawn:', error);
    }
  }

  private feedHost(mount: FeedMount): CardFeedHost {
    return {
      view: () => this.view(),
      generation: () => this.generation,
      markCardViewed: (card) => this.markCardViewed(card),
      markCardRead: (card) => this.markCardRead(card),
      markCardClicked: (card) => this.markCardClicked(card),
      dismissCard: (card) => this.dismissCard(card),
      routeLink: (url, context, fallback) => {
        if (!this.mounts.has(mount)) return;
        if (this.links) this.links.route(url, 'card', context, fallback);
        else fallback();
      },
      loadMore: async () => {
        const cursor = this.nextCursor;
        if (!cursor || !this.mounts.has(mount) || !this.wireCards.length) return;
        await this.loadPage(cursor);
      },
      trackViewable,
      logger: this.logger,
    };
  }

  private unmount(mount: FeedMount): void {
    this.mounts.delete(mount);
    const view = mount.view;
    mount.view = null;
    try {
      view?.remove();
    } catch (error) {
      this.logger.debug('Card feed remove failed', error);
    }
  }

  private render(mount: FeedMount): void {
    try {
      mount.view?.render();
    } catch (error) {
      this.logger.error('The card feed could not be drawn:', error);
    }
  }

  // ── storage ─────────────────────────────────────────────────────────────

  private subjectKey(): string {
    return `${this.identity.getUserId() || ''}|${this.identity.getAnonymousId()}`;
  }

  /** The unscoped names any workspace on this origin could read: never read, removed on start. */
  private removeLegacyStorage(): void {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem?.(LEGACY_FEED_STORAGE_NAME);
    } catch {
      /* storage blocked */
    }
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem?.(LEGACY_DEVICE_STORAGE_NAME);
    } catch {
      /* storage blocked */
    }
  }

  private persistFeed(): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(
        cardsFeedStorageKey(this.sdkKey),
        JSON.stringify({
          subject: this.subjectKey(),
          fetchedAt: this.fetchedAt,
          etag: this.etag,
          ttlSeconds: this.ttlSeconds,
          unreadCount: this.serverUnread,
          nextCursor: this.nextCursor,
          stateScope: this.stateScope,
          cards: this.wireCards,
        }),
      );
    } catch {
      /* storage blocked or full: memory only */
    }
  }

  private loadFeedCache(): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      const raw = sessionStorage.getItem(cardsFeedStorageKey(this.sdkKey));
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Another visitor's feed (a reset or a login since) is not this one's.
      if (!stored || stored.subject !== this.subjectKey()) return;
      this.wireCards = parseCards(stored.cards);
      this.serverUnread = typeof stored.unreadCount === 'number' ? Math.max(0, stored.unreadCount) : 0;
      this.nextCursor = str(stored.nextCursor);
      this.stateScope = stored.stateScope === 'device' ? 'device' : 'server';
      this.etag = str(stored.etag);
      this.ttlSeconds = typeof stored.ttlSeconds === 'number' && stored.ttlSeconds > 0 ? stored.ttlSeconds : CARD_FEED_TTL_SECONDS;
      this.fetchedAt = typeof stored.fetchedAt === 'number' ? stored.fetchedAt : null;
    } catch {
      this.wireCards = [];
    }
  }

  private persistDeviceState(): void {
    const trim = (set: Set<string>) => {
      while (set.size > DEVICE_STATE_MAX) set.delete(set.values().next().value as string);
    };
    trim(this.deviceRead);
    trim(this.deviceDismissed);
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        cardsDeviceStorageKey(this.sdkKey),
        JSON.stringify({
          anonymousId: this.identity.getAnonymousId(),
          read: Array.from(this.deviceRead),
          dismissed: Array.from(this.deviceDismissed),
        }),
      );
    } catch {
      /* storage blocked or full: memory only */
    }
  }

  private loadDeviceState(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(cardsDeviceStorageKey(this.sdkKey));
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Kept for one anonymous visitor; a new one starts clean.
      if (!stored || stored.anonymousId !== this.identity.getAnonymousId()) return;
      for (const id of Array.isArray(stored.read) ? stored.read : []) if (typeof id === 'string') this.deviceRead.add(id);
      for (const id of Array.isArray(stored.dismissed) ? stored.dismissed : []) if (typeof id === 'string') this.deviceDismissed.add(id);
    } catch {
      this.deviceRead.clear();
      this.deviceDismissed.clear();
    }
  }
}
