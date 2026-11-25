/**
 * Placements (docs/PLACEMENTS_PLAN.md, BACKLOG D444): named spots inside the
 * page - `home_hero`, `cart_upsell` - that Joryio fills per visitor from
 * placement campaigns and journey steps.
 *
 * Unlike overlays (inapp.ts) a placement is drawn INSIDE an element the site
 * owns, or handed to the site as data to draw itself. The serve endpoint is
 * `POST /v1/in-app/placements`; interactions are the in-app event family
 * (`/v1/in-app/track`), with the placement key alongside.
 *
 * The rules this file implements, and the names every Joryio SDK shares
 * (pinned by packages/backend/src/modules/tracking/sdk-placements-parity.spec.ts):
 *
 * - `insertPlacement(key, element)`, `<div data-joryio-placement="key">`
 *   auto-mount, `getPlacements([...])`, `refreshPlacements(keys?)`,
 *   `onPlacementsUpdated(cb)`; `item.markDisplayed()`, `markClicked()`,
 *   `markDismissed()`, `placement.markDisplayed()` (holdout exposure).
 * - Batched: every key asked for within PLACEMENT_BATCH_WINDOW_MS goes in one
 *   request, at most PLACEMENT_MAX_KEYS_PER_REQUEST keys each.
 * - Cached per key for the placement's `ttlSeconds` (memory + sessionStorage,
 *   scoped to the visitor), and a key is fetched from the network at most once
 *   per PLACEMENT_MIN_REFRESH_SECONDS; extra refreshes coalesce.
 * - Viewable = at least PLACEMENT_VIEWABLE_FRACTION of the item in view for
 *   IN_APP_DISPLAY_DWELL_MS continuously, page visible; reported once per
 *   delivery.
 * - Never swaps content under the reader's eyes: an update to a placement that
 *   is on screen is applied when it next leaves the viewport or is mounted again.
 * - Consent: without tracking consent the request names nobody (no user id, no
 *   anonymous id, no session), the server answers with generic content and no
 *   delivery token, and the SDK reports nothing.
 * - HTML items render in the same sandboxed, nonce-CSP frame as overlays, and
 *   only when `allowHtmlJsInAppMessages` is on.
 * - Show when (D465, show-when.ts): an item with a `showWhen` other than load
 *   is held - neither drawn nor handed to the data API - until its moment in
 *   this page view, then the key's spots re-draw and onPlacementsUpdated
 *   fires; a route change holds it again until the new page's moment. A
 *   control answer's `showWhen` delays its exposure the same way, and
 *   `deferredControls` are reported once their own moment has come and the
 *   spot was viewable. An event named in `recheckOn` (or one an item waits
 *   on) re-fetches the key at once, past the 30 s limit, once per page view.
 * - Server-filled slots (D466): a store plugin may write a slot's
 *   content into the HTML when Joryio's answer for it is the same for every
 *   visitor (`data-joryio-server-filled` on the slot, the fill inside it, the
 *   marker block's `fills`). The SDK keeps that drawing when the visitor's own
 *   answer is the same campaign, variant and products - no redraw - and
 *   reports its impression with the visitor's own token once it is viewable
 *   (nothing without consent, as for every item); otherwise it replaces it
 *   with the visitor's answer, or removes it per the empty behaviour.
 */

import { JoryioSubscription, joryioSubscription } from './subscription';
import { bucketHash } from '../utils/bucket-hash';
import { currentPageUrl, PAGE_CONTEXT_CAPABILITY, type PageContextTracker } from './page-context';
import { Logger } from '../utils/logger';
import { eventNames, isDeferred, parseShowWhen, type RecheckEvent, type ShowWhenMoments } from './show-when';
import { sdkIdentityHeaders } from './config';
import { IdentityManager } from './identity';
import { SessionManager } from './session';
import type { LinkContext, LinkRouter } from './links';
import { serverMarkerElement } from './page-edits';
import {
  buildInAppSrcdoc,
  inAppTriggerFilterMatches,
  normalizedElementId,
  IN_APP_DISPLAY_DWELL_MS,
  InAppAuthProvider,
  InAppTrigger,
} from './inapp';

/** Share of an item that must be in view for it to count as seen. Same name and value on every Joryio SDK. */
export const PLACEMENT_VIEWABLE_FRACTION = 0.5;
/** A placement key is fetched from the network at most once per this many seconds. Same on every Joryio SDK. */
export const PLACEMENT_MIN_REFRESH_SECONDS = 30;
/**
 * A request that got no answer (no connection, a 5xx) holds its keys back this
 * many seconds instead of PLACEMENT_MIN_REFRESH_SECONDS: one failed request
 * must not leave a placement empty for 30 s. A 429 keeps the full window. Same on every Joryio SDK.
 */
export const PLACEMENT_RETRY_AFTER_FAILURE_SECONDS = 3;
/** Keys asked for within this window go in one request. */
export const PLACEMENT_BATCH_WINDOW_MS = 50;
/** The serve endpoint takes 1-10 keys per request. */
export const PLACEMENT_MAX_KEYS_PER_REQUEST = 10;
/** How long an event-triggered item stays eligible after its event, when the server does not say. */
export const PLACEMENT_DEFAULT_TRIGGER_WINDOW_SECONDS = 1800;
/**
 * A drawn product card's tap is reported as `clicked` with the elementId
 * `product:<product id>` (at most 128 characters), so the click report counts
 * clicks per product. Same name and value on every Joryio SDK.
 */
export const PLACEMENT_PRODUCT_ELEMENT_PREFIX = 'product:';
/** Width of a drawn product card when the app does not set one (CSS px; points on iOS, dp on Android). Same on every Joryio SDK. */
export const PLACEMENT_PRODUCT_CARD_WIDTH = 160;
/** The elementId a product card's click is reported with - use it when you draw the cards yourself. */
export function placementProductElementId(productId: string): string {
  return `${PLACEMENT_PRODUCT_ELEMENT_PREFIX}${productId}`.slice(0, 128);
}
/**
 * Server-filled slots (D466; backend common/placements/server-slot-fills.ts,
 * the plugins' shared core). Same names and values pinned by
 * server-slot-fills-sdk-parity.spec.ts.
 */
export const SERVER_FILLED_ATTR = 'data-joryio-server-filled';
export const SERVER_FILL_ATTR = 'data-joryio-server-fill';
export const SERVER_FILLS_MARKER_KEY = 'fills';

/** One slot the store's server filled: what it drew, from the marker. */
interface ServerFill {
  campaignId: string;
  variantId: string;
  products: string[];
  /** The fill's `.joryio-placement` wrapper inside the slot. */
  wrapper: HTMLElement;
}

/** Used when an answer carries no ttlSeconds. */
const DEFAULT_TTL_SECONDS = 300;
/** The pre-scoping, origin-wide name - never read, removed on start. */
const LEGACY_CACHE_STORAGE_NAME = 'joryio_placements_v1';
/**
 * Per workspace, like the flags cache (flagsStorageKey): two workspaces on one
 * site that know a visitor by the same ids must never read each other's
 * placements. Carries a hash of the SDK key, never the key itself.
 */
export const placementsStorageKey = (sdkKey: string): string => `joryio_placements_v1_${bucketHash(sdkKey).toString(36)}`;
/** The host-window object the placement HTML frames call into (overlays use their own). */
const PLACEMENT_BRIDGE_GLOBAL = '__joryioPlacement';
const PLACEMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;

export type PlacementEmptyBehavior = 'collapse' | 'keep_space';
export type PlacementItemKind = 'native' | 'html' | 'data';
/** The consent the request carries: the existing wire values. */
export type PlacementConsent = 'granted' | 'denied' | 'pending';

export type PlacementContent =
  | { kind: 'html'; html: string; css?: string }
  | {
      kind: 'native';
      title?: string;
      body?: string;
      imageUrl?: string;
      buttons?: Array<{ id: string; text: string; action: string; url?: string }>;
      closeButton?: boolean;
    };

/** One item as the server sends it. */
/** A product card of a recommendation placement item (D444 Phase 2b). Same names on all five SDKs. */
export interface PlacementProduct {
  id: string;
  title: string | null;
  price: string | null;
  compareAtPrice: string | null;
  discountPercent: number | null;
  imageUrl: string | null;
  url: string | null;
}

export interface PlacementItemWire {
  id: string;
  variantId?: string | null;
  deliveryToken?: string | null;
  priority?: number;
  kind: PlacementItemKind;
  data?: Record<string, string | number | boolean>;
  content?: PlacementContent | null;
  /** Products picked for the person by a recommendation model (absent = none). */
  products?: PlacementProduct[] | null;
  triggers?: InAppTrigger[] | null;
  /** How long an event trigger keeps the item eligible (seconds). */
  placementTriggerWindowSeconds?: number | null;
  expiresAt?: string | null;
  /** Echoed in `shown` when present; the item id otherwise. */
  deliveryId?: string | null;
  /** Show when (D465): the item's moment; absent = on load. */
  showWhen?: unknown;
}

/** One placement as the server sends it. */
export interface PlacementWire {
  placementKey: string;
  emptyBehavior?: PlacementEmptyBehavior;
  maxItems?: number;
  ttlSeconds?: number;
  isControl?: boolean;
  controlToken?: string | null;
  items?: PlacementItemWire[];
  /**
   * D444 Phase 4: the answer depends on the page (a campaign of this
   * placement has page targeting), so it is cached per page (origin + path)
   * and asked again on a route change.
   */
  pageScoped?: boolean;
  /** Show when (D465), on a control answer only: the moment the held-out treatment would have shown. */
  showWhen?: unknown;
  /** Control exposures to report once their moment came and the spot was viewable. */
  deferredControls?: Array<{ controlToken: string; showWhen: unknown }>;
  /** Event names that re-fetch this key at once when tracked. */
  recheckOn?: string[];
}

export interface PlacementsResponse {
  success: boolean;
  evaluatedAt?: string;
  placements?: Record<string, PlacementWire>;
}

/** An item to draw, with the calls that report what the person did with it. */
export interface PlacementItem {
  id: string;
  variantId?: string | null;
  kind: PlacementItemKind;
  data: Record<string, string | number | boolean>;
  content?: PlacementContent | null;
  /** Products picked for the person by a recommendation model; [] when the item has none. Draw them as cards. */
  products: PlacementProduct[];
  priority?: number;
  expiresAt?: string | null;
  /** Report a viewable impression (the app drew it itself). Once per delivery. */
  markDisplayed(): void;
  /** Report a tap or click; `elementId` names the button or link. */
  markClicked(elementId?: string): void;
  /** Report that the person closed it. The placement's dismissal rule applies on the server. */
  markDismissed(): void;
}

export interface Placement {
  placementKey: string;
  items: PlacementItem[];
  isControl: boolean;
  emptyBehavior: PlacementEmptyBehavior;
  maxItems: number;
  ttlSeconds: number;
  /**
   * For a held-out visitor (`isControl`): report that the (empty) spot was
   * viewable. Drawn placements do this themselves; a data-first app calls it
   * when its spot was on screen. No-op for a placement that is not a control.
   */
  markDisplayed(): void;
}

export interface PlacementHandle {
  placementKey: string;
  element: HTMLElement;
  /** Stop filling the element and remove what the SDK drew. */
  remove(): void;
}

export interface InsertPlacementOptions {
  /** Called after the SDK (re)drew the element, with what it drew. */
  onRender?: (placement: Placement, element: HTMLElement) => void;
  /**
   * A `deep_link` button with an app link (`myapp://cart`) was tapped: route
   * it in your app (the click is already reported). An http(s) link is opened
   * by the SDK in a new tab instead, and any other scheme (javascript:, data:,
   * intent:, ...) is refused - it reaches neither this handler nor the page.
   * A handler set with `setLinkHandler` sees every link first; this one is
   * called when it returns false.
   */
  onDeepLink?: (url: string, item: PlacementItem) => void;
  /**
   * Draw an item's recommended products as a horizontal row of cards (image,
   * title, price, optional button) below its content - alone for a data item.
   * Default true; false leaves the products to you (`onRender` / getPlacements).
   */
  showProducts?: boolean;
  /** Label of a button on every product card; unset = no button (the whole card opens the product). */
  productButtonText?: string;
  /** Width of one product card in CSS px (default PLACEMENT_PRODUCT_CARD_WIDTH). */
  productCardWidth?: number;
}

export type PlacementsUpdatedCallback = (placements: Record<string, Placement>) => void;

/** What the placement manager needs from the SDK. */
export interface PlacementRuntime {
  /**
   * The consent to send, or null when nothing may be sent at all (SDK not
   * initialised, disabled, ingestion suspended). `granted` = personal serving
   * and reporting; anything else = an anonymous request and no reporting.
   */
  consent: () => PlacementConsent | null;
  allowHtml: () => boolean;
  requestTimeoutMs?: number;
  noteStatus?: (status: number, data: any) => void;
  /** The SDK calls the HTML bridge reaches (custom events, attributes, push). */
  bridge?: {
    logCustomEvent: (name: string, properties?: Record<string, any>) => void;
    setCustomUserAttribute: (key: string, value: any) => void;
    changeUser: (userId: string) => void;
    requestPushPermission: () => void;
  };
}

interface CacheEntry {
  placement: PlacementWire;
  fetchedAt: number;
  /** The page it was answered for (origin + path); matters only when `pageScoped`. */
  url?: string | null;
}

interface Waiter {
  keys: string[];
  resolve: () => void;
}

interface Mount {
  key: string;
  element: HTMLElement;
  options: InsertPlacementOptions;
  wrapper: HTMLElement | null;
  /** Item ids currently drawn (the `shown` list sent with the next request). */
  shown: string[];
  /** A newer answer that waits until the spot leaves the viewport. */
  pendingUpdate: boolean;
  /** Whether any part of the host element is in the viewport. */
  hostInView: boolean;
  hostObserver: IntersectionObserver | null;
  trackers: ViewTracker[];
  frameIds: string[];
  /** D466: the store's server drew this slot; kept or replaced once the visitor's answer is known. */
  serverFill: ServerFill | null;
}

const nowMs = () => Date.now();

function validKey(key: unknown): key is string {
  return typeof key === 'string' && PLACEMENT_KEY_PATTERN.test(key);
}

/** The page address without query or fragment: context only, and query strings carry PII. */
function pageContext(): { url: string | null; screen: null } {
  return { url: currentPageUrl(), screen: null };
}

/**
 * Whether the page has a live user gesture. User activation propagates from a
 * frame to its ancestors, so a click inside a placement frame activates the
 * host page too; a call made by anything else (a timer, a synthetic event)
 * finds none. Browsers without the API are trusted - the frame's nonce CSP
 * already stops author script.
 */
function hasUserGesture(): boolean {
  try {
    const activation = (navigator as any)?.userActivation;
    return activation ? activation.isActive === true : true;
  } catch {
    return true;
  }
}

/** An http(s) URL the SDK may open itself, or null. The one link rule of placements and content cards. */
export function safeHttpUrl(url: unknown): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Schemes never opened nor handed to the site, whatever the link says (the backend's card / placement link rule). */
const REFUSED_LINK_SCHEMES = ['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'content', 'intent'];

/**
 * An app deep link (`myapp://cart`) that may go to the site's own handler: a
 * `scheme://` link whose scheme is not http(s) and not a refused one. The SDK
 * never navigates to it itself. The same rule on every Joryio SDK.
 */
export function isAppDeepLink(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const m = /^([a-z][a-z0-9+.-]*):\/\/./i.exec(url.trim());
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  return scheme !== 'http' && scheme !== 'https' && !REFUSED_LINK_SCHEMES.includes(scheme);
}

/** One element's viewability measurement (see trackViewable). */
export interface ViewTracker {
  observer: IntersectionObserver | null;
  timer: ReturnType<typeof setTimeout> | null;
  inView: boolean;
  /** Restart the dwell when the page becomes visible again. */
  resume(): void;
  /** Stop the dwell while the page is hidden. */
  pause(): void;
  /** Stop measuring for good. */
  cancel(): void;
}

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Call `onViewable` once `node` has had PLACEMENT_VIEWABLE_FRACTION of its
 * area in view for IN_APP_DISPLAY_DWELL_MS continuously, with the page
 * visible. Without IntersectionObserver (very old browsers) the page being
 * visible for the dwell counts. Shared by placements and the card feed; the
 * caller forwards page visibility changes to `resume` / `pause`.
 */
export function trackViewable(node: Element, onViewable: () => void): ViewTracker {
  let cancelled = false;
  const tracker: ViewTracker = {
    observer: null,
    timer: null,
    inView: false,
    resume: () => {
      if (cancelled || tracker.timer || !tracker.inView || !pageIsVisible()) return;
      tracker.timer = setTimeout(() => {
        tracker.timer = null;
        if (!cancelled && tracker.inView && pageIsVisible()) {
          cancelled = true;
          tracker.observer?.disconnect();
          onViewable();
        }
      }, IN_APP_DISPLAY_DWELL_MS);
    },
    pause: () => {
      if (tracker.timer) clearTimeout(tracker.timer);
      tracker.timer = null;
    },
    cancel: () => {
      cancelled = true;
      tracker.observer?.disconnect();
      tracker.pause();
    },
  };
  if (typeof IntersectionObserver === 'undefined') {
    tracker.inView = true;
    tracker.resume();
    return tracker;
  }
  tracker.observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        // A zero-area target (a collapsed control spot) reports ratio 1 while intersecting.
        tracker.inView = e.isIntersecting && e.intersectionRatio >= PLACEMENT_VIEWABLE_FRACTION;
        if (tracker.inView) tracker.resume();
        else tracker.pause();
      }
    },
    { threshold: [0, PLACEMENT_VIEWABLE_FRACTION, 1] },
  );
  tracker.observer.observe(node);
  return tracker;
}

export class PlacementManager {
  /** The SDK's link router (`setLinkHandler`); set by the SDK after construction. */
  links: LinkRouter | null = null;

  private cache = new Map<string, CacheEntry>();
  /** When each key last went to the network (the client rate limit). */
  private lastNetworkAt = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private batchKeys = new Set<string>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchWaiters: Waiter[] = [];
  /** Refreshes asked for inside the rate-limit window, run when it opens. */
  private deferredKeys = new Set<string>();
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<PlacementsUpdatedCallback>();
  private mounts = new Set<Mount>();
  /** Delivery handles already reported, per transition (displayed once, control once). */
  private reported = new Set<string>();
  /** Event-triggered items: when their event fired. */
  private triggeredAt = new Map<string, number>();
  /** Items the person dismissed: hidden locally until the server's next answer. */
  private dismissedLocally = new Set<string>();
  /** Bumped when WHO the placements are for changes; older answers are discarded. */
  private generation = 0;
  private mutationObserver: MutationObserver | null = null;
  private frames = new Map<string, { iframe: HTMLIFrameElement; key: string; item: PlacementItemWire }>();
  private frameSeq = 0;
  private pageListener: (() => void) | null = null;
  private destroyed = false;
  private page: PageContextTracker | null = null;
  private pageUnsubscribe: (() => void) | null = null;
  /** Show when (D465): the moments; null = this manager holds every non-load item for good. */
  private moments: ShowWhenMoments | null = null;
  private momentsUnsubscribe: (() => void) | null = null;
  /** Held items / control answers revealed in this page view (handles; `ctl:` + token for a control). */
  private revealed = new Set<string>();
  /** Keys whose spot was viewable in this page view (drawn item, control spot, or markDisplayed). */
  private spotViewable = new Set<string>();
  /** `key + event` re-checked in this page view. */
  private rechecked = new Set<string>();

  constructor(
    private apiEndpoint: string,
    private sdkKey: string,
    private identity: IdentityManager,
    private session: SessionManager,
    private logger: Logger,
    private runtime: PlacementRuntime,
    private auth?: InAppAuthProvider,
  ) {
    this.loadCache();
    this.installBridge();
    this.installPageVisibility();
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Draw placement `key` into `element`. Returns a handle whose remove() stops it. */
  insertPlacement(key: string, element: HTMLElement, options: InsertPlacementOptions = {}): PlacementHandle | null {
    if (!validKey(key)) {
      this.logger.warn(`insertPlacement: "${key}" is not a placement key (a-z, 0-9 and _, up to 64)`);
      return null;
    }
    if (!element || typeof (element as any).appendChild !== 'function') {
      this.logger.warn('insertPlacement: an element is required');
      return null;
    }
    for (const existing of this.mounts) {
      if (existing.element === element) this.unmount(existing);
    }
    const mount: Mount = {
      key,
      element,
      options,
      wrapper: null,
      shown: [],
      pendingUpdate: false,
      hostInView: false,
      hostObserver: null,
      trackers: [],
      frameIds: [],
      serverFill: this.serverFillOf(key, element),
    };
    this.mounts.add(mount);
    this.observeHost(mount);
    const cached = this.freshEntry(key);
    if (cached) this.render(mount);
    this.ensure([key]).then(() => {
      // Drawn already when the answer changed the cache (applyChanged); an
      // unchanged or failed answer still draws what there is.
      if (this.mounts.has(mount) && !mount.wrapper) this.render(mount);
    }).catch((error) => this.logger.debug('Placement fetch failed:', error));
    return { placementKey: key, element, remove: () => this.unmount(mount) };
  }

  /** The placements for `keys`, from the cache when fresh, from the network otherwise. */
  async getPlacements(keys: string[]): Promise<Record<string, Placement>> {
    const wanted = this.cleanKeys(keys);
    await this.ensure(wanted);
    const out: Record<string, Placement> = {};
    for (const key of wanted) out[key] = this.toPlacement(key);
    return out;
  }

  /** Ask the server again for `keys` (default: every placement on the page or in the cache). */
  async refreshPlacements(keys?: string[]): Promise<void> {
    const wanted = keys ? this.cleanKeys(keys) : this.knownKeys();
    if (!wanted.length) return;
    await this.fetchKeys(wanted, true);
  }

  /** Called with the placements that changed after each answer. Returns a JoryioSubscription. */
  onPlacementsUpdated(callback: PlacementsUpdatedCallback): JoryioSubscription {
    if (typeof callback !== 'function') return joryioSubscription(() => undefined);
    // One entry per subscription, so the same function subscribed twice is two subscriptions.
    const entry: PlacementsUpdatedCallback = (placements) => callback(placements);
    this.listeners.add(entry);
    return joryioSubscription(() => {
      this.listeners.delete(entry);
    });
  }

  /** Mount every `[data-joryio-placement]` element on the page, now and as the page changes. */
  autoMount(): void {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      // The script ran in <head>: the elements are not parsed yet.
      document.addEventListener('DOMContentLoaded', () => !this.destroyed && this.autoMount(), { once: true });
      return;
    }
    this.scanDocument();
    if (this.mutationObserver || typeof MutationObserver === 'undefined' || !document.body) return;
    this.mutationObserver = new MutationObserver(() => this.scanDocument());
    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  /** An event was tracked: event-triggered items waiting on it become eligible. */
  onEventTracked(eventName: string, properties?: Record<string, any>): void {
    if (!eventName) return;
    const changed = new Set<string>();
    for (const [key, entry] of this.cache) {
      for (const item of entry.placement.items || []) {
        const match = (item.triggers || []).some(
          (t) => t.type === 'event' && t.event === eventName && inAppTriggerFilterMatches(t, properties),
        );
        if (match) {
          this.triggeredAt.set(this.handle(key, item), nowMs());
          changed.add(key);
        }
      }
    }
    if (changed.size) this.applyChanged(Array.from(changed));
  }

  /**
   * The visitor changed (identify, reset, consent): forget every answer and
   * ask again for the placements on the page.
   */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.lastNetworkAt.clear();
    this.triggeredAt.clear();
    this.dismissedLocally.clear();
    this.reported.clear();
    this.revealed.clear();
    this.spotViewable.clear();
    this.persistCache();
    const keys = this.mountedKeys();
    // The previous person's content goes NOW, on screen or not: it must not
    // stay in front of the next person, nor report against them.
    for (const mount of this.mounts) this.render(mount);
    if (keys.length) this.fetchKeys(keys, true).catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    this.pageUnsubscribe?.();
    this.pageUnsubscribe = null;
    this.momentsUnsubscribe?.();
    this.momentsUnsubscribe = null;
    for (const mount of Array.from(this.mounts)) this.unmount(mount);
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.batchTimer = null;
    this.deferredTimer = null;
    this.batchWaiters.forEach((w) => w.resolve());
    this.batchWaiters = [];
    this.listeners.clear();
    if (this.pageListener && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.pageListener);
    }
    try {
      if (typeof window !== 'undefined' && (window as any)[PLACEMENT_BRIDGE_GLOBAL]?.__owner === this) {
        delete (window as any)[PLACEMENT_BRIDGE_GLOBAL];
      }
    } catch {
      /* ignore */
    }
  }

  // ── fetching ────────────────────────────────────────────────────────────

  private cleanKeys(keys: string[]): string[] {
    const out: string[] = [];
    for (const key of Array.isArray(keys) ? keys : []) {
      if (validKey(key) && !out.includes(key)) out.push(key);
      else if (!validKey(key)) this.logger.warn(`Ignoring "${key}": not a placement key`);
    }
    return out;
  }

  private knownKeys(): string[] {
    return Array.from(new Set([...this.mountedKeys(), ...this.cache.keys()]));
  }

  private mountedKeys(): string[] {
    return Array.from(new Set(Array.from(this.mounts).map((m) => m.key)));
  }

  /**
   * Page context (D444 Phase 4): requests carry the page (URL without query,
   * allow-listed variables), and a page-scoped answer is good for its page
   * only - on a route change it goes, and the spot asks again.
   */
  setPageContext(tracker: PageContextTracker | null): void {
    this.pageUnsubscribe?.();
    this.pageUnsubscribe = null;
    this.page = tracker;
    if (!tracker) return;
    this.pageUnsubscribe = tracker.onSignal((signal) => {
      if (signal.type !== 'page_change' || this.destroyed) return;
      // Show when: a new page view - held items wait for this page's moment again.
      const held = this.revealed.size ? this.keysWithMoments() : [];
      this.revealed.clear();
      this.spotViewable.clear();
      this.rechecked.clear();
      const stale: string[] = [];
      this.cache.forEach((entry, key) => {
        if (entry.placement.pageScoped && entry.url !== signal.url) stale.push(key);
      });
      const rehide = held.filter((key) => !stale.includes(key));
      if (rehide.length) {
        for (const mount of this.mounts) if (rehide.includes(mount.key)) this.render(mount);
        this.notify(rehide);
        this.sweep();
      }
      if (!stale.length) return;
      stale.forEach((key) => this.cache.delete(key));
      this.persistCache();
      // The old page's item must not stay on the new page while the answer is on its way.
      for (const mount of this.mounts) if (stale.includes(mount.key)) this.render(mount);
      const mounted = stale.filter((key) => this.mountedKeys().includes(key));
      if (mounted.length) {
        this.fetchKeys(mounted, false)
          .then(() => {
            for (const mount of this.mounts) if (mounted.includes(mount.key) && !mount.wrapper) this.render(mount);
          })
          .catch(() => undefined);
      }
    });
  }

  /** Show when (D465): the SDK's moments. Held content is revealed as they come. */
  setShowWhen(moments: ShowWhenMoments | null): void {
    this.momentsUnsubscribe?.();
    this.moments = moments;
    this.momentsUnsubscribe = moments ? moments.onChange(() => !this.destroyed && this.sweep()) : null;
  }

  /** Has this held content's moment come in this page view? Once yes, it stays yes until a route change. */
  private due(handle: string, raw: unknown): boolean {
    const sw = parseShowWhen(raw);
    if (!sw) return false;
    return sw.kind === 'load' || this.revealed.has(handle) || (!!this.moments && this.moments.met(sw));
  }

  /** Keys whose answer holds anything until a moment. */
  private keysWithMoments(): string[] {
    const out: string[] = [];
    this.cache.forEach((entry, key) => {
      const p = entry.placement;
      if (p.showWhen !== undefined || p.deferredControls?.length || (p.items || []).some((i) => i.showWhen !== undefined)) out.push(key);
    });
    return out;
  }

  /**
   * A moment may have come: reveal held items and control answers whose moment
   * did (re-draw + onPlacementsUpdated), and report the deferred control
   * exposures that are now due.
   */
  private sweep(): void {
    const changed: string[] = [];
    this.cache.forEach((entry, key) => {
      const p = entry.placement;
      const handles: Array<[string, unknown]> = (p.items || []).filter((i) => isDeferred(i.showWhen)).map((i) => [this.handle(key, i), i.showWhen]);
      if (p.isControl && isDeferred(p.showWhen)) handles.push([`ctl:${key}:${p.controlToken || ''}`, p.showWhen]);
      for (const [h, raw] of handles) {
        if (this.revealed.has(h) || !this.due(h, raw)) continue;
        this.revealed.add(h);
        if (!changed.includes(key)) changed.push(key);
      }
      this.reportDeferred(key);
    });
    if (changed.length) this.applyChanged(changed);
  }

  /**
   * Show when: the keys to ask again now that `eventName` was tracked - their
   * answer lists it in `recheckOn` or holds an item waiting on it - at most
   * once per (key, event) per page view. Marks them as asked.
   */
  recheckKeysFor(eventName: string): string[] {
    if (!this.moments || this.destroyed) return [];
    const out: string[] = [];
    this.cache.forEach((entry, key) => {
      const p = entry.placement;
      if (p.pageScoped && entry.url !== this.currentUrl()) return;
      const waits =
        (p.recheckOn || []).includes(eventName) ||
        (p.items || []).some((i) => (parseShowWhen(i.showWhen) as { event?: string } | null)?.event === eventName);
      const once = `${key}\u0000${eventName}`;
      if (!waits || this.rechecked.has(once)) return;
      this.rechecked.add(once);
      out.push(key);
    });
    return out;
  }

  /**
   * Ask the server again for `keys` now, past the client refresh limit (the
   * show-when re-check), carrying the event that caused it (`recheckEvent`).
   * A request of its own per (keys, event), like iOS and Android: never
   * batched with another key's fetch or re-check, never joined to a normal
   * fetch, so one event never rides on another key's re-check and two
   * re-checks are never folded into one.
   */
  recheck(keys: string[], event?: RecheckEvent): Promise<void> {
    const go = async (): Promise<void> => {
      if (this.destroyed) return;
      const chunks: string[][] = [];
      for (let i = 0; i < keys.length; i += PLACEMENT_MAX_KEYS_PER_REQUEST) {
        chunks.push(keys.slice(i, i + PLACEMENT_MAX_KEYS_PER_REQUEST));
      }
      await Promise.all(chunks.map((chunk) => this.request(chunk, event ?? null)));
    };
    // A request already on its way may predate the event: ask again once it is back.
    const inflight = keys.map((key) => this.inflight.get(key)).filter(Boolean);
    return (inflight.length ? Promise.all(inflight).then(go) : go()).catch(() => undefined);
  }

  private currentUrl(): string | null {
    return this.page ? this.page.current().url : currentPageUrl();
  }

  /** The rate-limit key: per page for a page-scoped placement, so a route change can ask again at once. */
  private rateKey(key: string): string {
    return this.cache.get(key)?.placement.pageScoped || this.pageScopedKeys.has(key) ? `${key}\u0000${this.currentUrl() ?? ''}` : key;
  }
  private pageScopedKeys = new Set<string>();

  private freshEntry(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.placement.pageScoped && entry.url !== this.currentUrl()) return null;
    const ttl = (entry.placement.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
    return nowMs() - entry.fetchedAt < ttl ? entry : null;
  }

  /** Fresh from the cache, or fetched (never more often than the rate limit allows). */
  private async ensure(keys: string[]): Promise<void> {
    const stale = keys.filter((key) => !this.freshEntry(key));
    if (stale.length) await this.fetchKeys(stale, false);
  }

  /**
   * Fetch `keys`, batched with every other key asked for in the next
   * PLACEMENT_BATCH_WINDOW_MS. A key fetched less than
   * PLACEMENT_MIN_REFRESH_SECONDS ago is not fetched again: a forced refresh
   * is deferred to when the window opens, anything else is served the cache.
   */
  private fetchKeys(keys: string[], force: boolean): Promise<void> {
    const now = nowMs();
    const waits: Promise<void>[] = [];
    const due: string[] = [];
    for (const key of keys) {
      const inflight = this.inflight.get(key);
      if (inflight) {
        waits.push(inflight);
        if (force) this.defer(key);
        continue;
      }
      const last = this.lastNetworkAt.get(this.rateKey(key));
      if (last !== undefined && now - last < PLACEMENT_MIN_REFRESH_SECONDS * 1000) {
        if (force) this.defer(key);
        continue;
      }
      due.push(key);
    }
    if (due.length) {
      due.forEach((key) => this.batchKeys.add(key));
      const batched = new Promise<void>((resolve) => this.batchWaiters.push({ keys: due, resolve }));
      due.forEach((key) => this.inflight.set(key, batched));
      if (!this.batchTimer) this.batchTimer = setTimeout(() => void this.flushBatch(), PLACEMENT_BATCH_WINDOW_MS);
      waits.push(batched);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private defer(key: string): void {
    this.deferredKeys.add(key);
    if (this.deferredTimer) return;
    const last = Math.min(...Array.from(this.deferredKeys).map((k) => this.lastNetworkAt.get(this.rateKey(k)) ?? 0));
    const wait = Math.max(0, last + PLACEMENT_MIN_REFRESH_SECONDS * 1000 - nowMs());
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      const keys = Array.from(this.deferredKeys);
      this.deferredKeys.clear();
      if (keys.length && !this.destroyed) this.fetchKeys(keys, false).catch(() => undefined);
    }, wait + 10);
  }

  private async flushBatch(): Promise<void> {
    this.batchTimer = null;
    const keys = Array.from(this.batchKeys);
    this.batchKeys.clear();
    const waiters = this.batchWaiters;
    this.batchWaiters = [];
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += PLACEMENT_MAX_KEYS_PER_REQUEST) {
      chunks.push(keys.slice(i, i + PLACEMENT_MAX_KEYS_PER_REQUEST));
    }
    try {
      await Promise.all(chunks.map((chunk) => this.request(chunk)));
    } finally {
      keys.forEach((key) => this.inflight.delete(key));
      waiters.forEach((w) => w.resolve());
    }
  }

  private async request(keys: string[], recheckEvent?: RecheckEvent | null): Promise<void> {
    const consent = this.runtime.consent();
    if (consent === null || this.destroyed) return;
    const generation = this.generation;
    const personal = consent === 'granted';
    const sentAt = nowMs();
    const rateKeys = keys.map((key) => this.rateKey(key));
    rateKeys.forEach((k) => this.lastNetworkAt.set(k, sentAt));
    // No answer or a server error: the keys may go again after
    // PLACEMENT_RETRY_AFTER_FAILURE_SECONDS, not the whole window (1.4.0-beta.12).
    const failed = () => {
      const retryAt = sentAt - (PLACEMENT_MIN_REFRESH_SECONDS - PLACEMENT_RETRY_AFTER_FAILURE_SECONDS) * 1000;
      rateKeys.forEach((k) => {
        if (this.lastNetworkAt.get(k) === sentAt) this.lastNetworkAt.set(k, retryAt);
      });
    };
    const askedFor = this.currentUrl();

    const shown: Record<string, string[]> = {};
    for (const mount of this.mounts) {
      if (keys.includes(mount.key) && mount.shown.length) shown[mount.key] = mount.shown.slice();
    }
    const userId = personal ? this.identity.getUserId() : null;
    const anonymousId = personal ? this.identity.getAnonymousId() : null;
    const body: Record<string, any> = {
      ...(userId ? { userId } : {}),
      ...(anonymousId ? { anonymousId } : {}),
      ...(personal ? { sessionId: this.session.getSessionId() } : {}),
      deviceType: 'web',
      locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
      capabilities: this.capabilities(),
      trackingConsent: consent,
      placements: keys,
      shown,
      context: this.page ? { ...this.page.current(), screen: null } : pageContext(),
    };
    // Only a re-check carries the event that caused it.
    if (recheckEvent) body.recheckEvent = recheckEvent;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), this.runtime.requestTimeoutMs ?? 10000);
    const url = `${this.apiEndpoint}/v1/in-app/placements`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...sdkIdentityHeaders(),
          // Only a consented request carries the visitor's auth: an
          // unconsented one names nobody.
          ...(personal ? this.auth?.getSdkAuthHeaders(userId, userId ? null : anonymousId) || {} : {}),
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        // 429 (the per-device limit) and every other failure: keep the cache.
        this.runtime.noteStatus?.(response.status, null);
        this.logger.debug(`Placements request answered ${response.status}; keeping the cached placements`);
        if (response.status >= 500) failed();
        return;
      }
      const data: PlacementsResponse = await response.json();
      if (generation !== this.generation) {
        this.logger.debug('Discarding a placements answer that predates an identity or consent change');
        return;
      }
      if (!data || data.success === false || !data.placements || typeof data.placements !== 'object') return;
      const fetchedAt = nowMs();
      const changed: string[] = [];
      for (const key of keys) {
        // A key the server left out is an empty placement (never an error).
        const wire = data.placements[key] || { placementKey: key, items: [] };
        const normalized = this.normalize(key, wire);
        const before = this.cache.get(key);
        this.cache.set(key, { placement: normalized, fetchedAt, url: askedFor });
        if (normalized.pageScoped) this.pageScopedKeys.add(key);
        else this.pageScopedKeys.delete(key);
        // The server's answer already applied the dismissal rule.
        for (const handle of Array.from(this.dismissedLocally)) {
          if (handle.startsWith(`${key}\u0000`)) this.dismissedLocally.delete(handle);
        }
        if (!before || JSON.stringify(before.placement) !== JSON.stringify(normalized)) changed.push(key);
      }
      this.persistCache();
      if (changed.length) this.applyChanged(changed);
    } catch (error) {
      const timedOut = (error as any)?.name === 'AbortError';
      this.logger.debug(timedOut ? 'Placements request timed out' : 'Placements request failed', error);
      failed();
    } finally {
      clearTimeout(timeout);
    }
  }

  private capabilities(): string[] {
    const caps = ['placements', 'content.native', 'content.data'];
    if (this.page) caps.push(PAGE_CONTEXT_CAPABILITY);
    if (this.runtime.allowHtml()) caps.push('content.html');
    return caps;
  }

  private normalize(key: string, wire: PlacementWire): PlacementWire {
    const items = Array.isArray(wire.items) ? wire.items.filter((i) => i && typeof i.id === 'string') : [];
    return {
      placementKey: key,
      emptyBehavior: wire.emptyBehavior === 'keep_space' ? 'keep_space' : 'collapse',
      maxItems: typeof wire.maxItems === 'number' && wire.maxItems > 0 ? wire.maxItems : 1,
      ttlSeconds: typeof wire.ttlSeconds === 'number' && wire.ttlSeconds > 0 ? wire.ttlSeconds : DEFAULT_TTL_SECONDS,
      isControl: wire.isControl === true,
      controlToken: wire.controlToken || null,
      items,
      ...(wire.pageScoped === true ? { pageScoped: true } : {}),
      ...(wire.isControl === true && wire.showWhen != null ? { showWhen: wire.showWhen } : {}),
      ...(Array.isArray(wire.deferredControls) && wire.deferredControls.length
        ? { deferredControls: wire.deferredControls.filter((d) => d && typeof d.controlToken === 'string' && d.controlToken) }
        : {}),
      ...(eventNames(wire.recheckOn).length ? { recheckOn: eventNames(wire.recheckOn) } : {}),
    };
  }

  /** Re-draw mounted placements and tell listeners, for keys whose answer changed. */
  private applyChanged(keys: string[]): void {
    for (const mount of this.mounts) {
      if (!keys.includes(mount.key)) continue;
      // Never under the reader's eyes: applied when the spot leaves the viewport.
      if (mount.hostInView && mount.shown.length) mount.pendingUpdate = true;
      else this.render(mount);
    }
    this.notify(keys);
  }

  private notify(keys: string[]): void {
    if (!this.listeners.size) return;
    const update: Record<string, Placement> = {};
    keys.forEach((key) => (update[key] = this.toPlacement(key)));
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(update);
      } catch (error) {
        this.logger.error('The onPlacementsUpdated callback threw; ignored:', error);
      }
    }
  }

  // ── what is eligible now ────────────────────────────────────────────────

  private handle(key: string, item: PlacementItemWire): string {
    return `${key}\u0000${item.deliveryToken || item.id}`;
  }

  /** The items to show now: not expired, not dismissed here, triggered when they wait on an event. */
  private visibleItems(key: string): PlacementItemWire[] {
    const entry = this.cache.get(key);
    if (!entry) return [];
    const now = nowMs();
    const max = entry.placement.maxItems || 1;
    return (entry.placement.items || [])
      .filter((item) => {
        if (item.expiresAt && Date.parse(item.expiresAt) <= now) return false;
        if (this.dismissedLocally.has(this.handle(key, item))) return false;
        // Show when: held until its moment in this page view; an unknown or invalid moment is never shown.
        if (item.showWhen !== undefined && !this.due(this.handle(key, item), item.showWhen)) return false;
        const eventTriggers = (item.triggers || []).filter((t) => t.type === 'event');
        if (eventTriggers.length) {
          const at = this.triggeredAt.get(this.handle(key, item));
          const windowS = item.placementTriggerWindowSeconds || PLACEMENT_DEFAULT_TRIGGER_WINDOW_SECONDS;
          if (at === undefined || now - at > windowS * 1000) return false;
        }
        return true;
      })
      .slice(0, max);
  }

  private toPlacement(key: string): Placement {
    const entry = this.cache.get(key);
    const wire = entry?.placement || this.normalize(key, { placementKey: key, items: [] });
    const generation = this.generation;
    return {
      placementKey: key,
      items: this.visibleItems(key).map((item) => this.toItem(key, item, generation)),
      isControl: wire.isControl === true,
      emptyBehavior: wire.emptyBehavior || 'collapse',
      maxItems: wire.maxItems || 1,
      ttlSeconds: wire.ttlSeconds || DEFAULT_TTL_SECONDS,
      markDisplayed: () => {
        if (!this.current(generation)) return;
        this.reportControl(key);
        this.markSpotViewable(key);
      },
    };
  }

  /** Created for the person still here? A Placement / item outlives an identify or reset: then it reports nothing. */
  private current(generation: number): boolean {
    return generation === this.generation;
  }

  private toItem(key: string, item: PlacementItemWire, generation: number): PlacementItem {
    return {
      id: item.id,
      variantId: item.variantId ?? null,
      kind: item.kind,
      data: { ...(item.data || {}) },
      content: item.content ?? null,
      products: toProducts(item.products),
      priority: item.priority,
      expiresAt: item.expiresAt ?? null,
      markDisplayed: () => this.current(generation) && this.report(key, item, 'displayed'),
      markClicked: (elementId?: string) => this.current(generation) && this.report(key, item, 'clicked', elementId),
      markDismissed: () => this.current(generation) && this.dismissItem(key, item),
    };
  }

  // ── reporting ───────────────────────────────────────────────────────────

  private dismissItem(key: string, item: PlacementItemWire): void {
    this.report(key, item, 'dismissed');
    this.dismissedLocally.add(this.handle(key, item));
    for (const mount of this.mounts) if (mount.key === key) this.render(mount);
  }

  /**
   * Report a transition to `/v1/in-app/track`. Only with consent (an
   * unconsented answer carries no delivery token and nothing is reported).
   * `displayed` once per delivery; a click or dismiss first counts the item
   * as displayed - the person saw it.
   */
  private report(key: string, item: PlacementItemWire, type: 'displayed' | 'clicked' | 'dismissed', elementId?: string): void {
    if (type === 'displayed') this.markSpotViewable(key);
    if (this.runtime.consent() !== 'granted') return;
    const once = `${type}:${this.handle(key, item)}`;
    if (type !== 'clicked') {
      if (this.reported.has(once)) return;
      this.reported.add(once);
    }
    if (type !== 'displayed') this.report(key, item, 'displayed');
    const at = new Date().toISOString();
    const normalizedId = normalizedElementId(elementId);
    const body: Record<string, any> = {
      campaignId: item.id,
      ...(item.variantId ? { variantId: item.variantId } : {}),
      ...(item.deliveryToken ? { deliveryToken: item.deliveryToken } : {}),
      placementKey: key,
      ...this.subject(),
      sessionId: this.session.getSessionId(),
      deviceType: 'web',
      ...(type === 'displayed' ? { action: 'displayed', displayedAt: at } : {}),
      ...(type === 'clicked' ? { action: 'clicked', clicked: true, clickedAt: at, ...(normalizedId ? { elementId: normalizedId } : {}) } : {}),
      ...(type === 'dismissed' ? { action: 'dismissed', dismissedAt: at } : {}),
    };
    this.post('/v1/in-app/track', body);
  }

  /**
   * A held-out visitor's empty spot was viewable: `in_app.control_viewed`,
   * once per control token. The token (from the answer) names the placement,
   * the campaign when it was a campaign control variant, and the visitor.
   */
  private reportControl(key: string): void {
    const entry = this.cache.get(key);
    if (!entry?.placement.isControl || !entry.placement.controlToken) return;
    // Show when: not before the moment the treatment would have shown (the spot re-draws, and
    // onPlacementsUpdated fires, at that moment - a markDisplayed before it is ignored).
    if (!this.due(`ctl:${key}:${entry.placement.controlToken}`, entry.placement.showWhen)) return;
    this.postControl(key, entry.placement.controlToken);
  }

  /** The spot of `key` was viewable in this page view: deferred control exposures may now be due. */
  private markSpotViewable(key: string): void {
    if (this.spotViewable.has(key)) return;
    this.spotViewable.add(key);
    this.reportDeferred(key);
  }

  /** `deferredControls` of the answer: each once, after its own moment, once the spot was viewable in this page view. */
  private reportDeferred(key: string): void {
    const list = this.cache.get(key)?.placement.deferredControls;
    if (!list?.length || !this.spotViewable.has(key)) return;
    for (const d of list) if (this.due(`ctl:${key}:${d.controlToken}`, d.showWhen)) this.postControl(key, d.controlToken);
  }

  /** `in_app.control_viewed`, once per control token, with consent only. */
  private postControl(key: string, controlToken: string): void {
    if (this.runtime.consent() !== 'granted') return;
    const once = `control:${controlToken}`;
    if (this.reported.has(once)) return;
    this.reported.add(once);
    this.post('/v1/in-app/track', {
      action: 'control_viewed',
      controlToken,
      placementKey: key,
      ...this.subject(),
      sessionId: this.session.getSessionId(),
      deviceType: 'web',
      viewedAt: new Date().toISOString(),
    });
  }

  private subject(): { userId?: string; anonymousId: string } {
    const userId = this.identity.getUserId();
    return { ...(userId ? { userId } : {}), anonymousId: this.identity.getAnonymousId() };
  }

  private post(path: string, body: Record<string, any>): void {
    const userId = typeof body.userId === 'string' ? body.userId : null;
    fetch(`${this.apiEndpoint}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Key': this.sdkKey,
        ...sdkIdentityHeaders(),
        ...(this.auth?.getSdkAuthHeaders(userId, userId ? null : body.anonymousId ?? null) || {}),
      },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then((response) => {
        if (!response.ok) this.runtime.noteStatus?.(response.status, null);
      })
      .catch((error) => this.logger.debug(`Placement report to ${path} failed`, error));
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  private scanDocument(): void {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    // Elements removed from the page stop being filled.
    for (const mount of Array.from(this.mounts)) {
      if ((mount.element as any).isConnected === false) this.unmount(mount);
    }
    const mountedElements = new Set(Array.from(this.mounts).map((m) => m.element));
    document.querySelectorAll<HTMLElement>('[data-joryio-placement]').forEach((element) => {
      if (mountedElements.has(element)) return;
      const key = element.getAttribute('data-joryio-placement');
      if (key) this.insertPlacement(key, element);
    });
  }

  private unmount(mount: Mount): void {
    this.mounts.delete(mount);
    mount.hostObserver?.disconnect();
    this.clearTrackers(mount);
    this.clearDrawn(mount);
    mount.element.removeAttribute?.('data-joryio-placement-state');
  }

  private clearTrackers(mount: Mount): void {
    for (const t of mount.trackers) t.cancel();
    mount.trackers = [];
  }

  private clearDrawn(mount: Mount): void {
    if (mount.serverFill) {
      // A server drawing never settled (removed before any answer): it goes with the mount.
      this.dropServerFill(mount.element, mount.serverFill.wrapper);
      mount.serverFill = null;
    }
    mount.frameIds.forEach((id) => this.frames.delete(id));
    mount.frameIds = [];
    mount.wrapper?.remove();
    mount.wrapper = null;
    mount.shown = [];
  }

  /** The marker block's fills by key (read once per page load; the plugin writes it before any script). */
  private markerFills: Map<string, { campaignId: string; variantId: string; products: string[] }> | null = null;

  private serverFillsOfMarker(): Map<string, { campaignId: string; variantId: string; products: string[] }> {
    if (this.markerFills) return this.markerFills;
    const out = new Map<string, { campaignId: string; variantId: string; products: string[] }>();
    try {
      const el = typeof document !== 'undefined' ? serverMarkerElement() : null;
      const data = el ? JSON.parse(el.textContent || 'null') : null;
      const list = data && data.v === 1 && Array.isArray(data[SERVER_FILLS_MARKER_KEY]) ? data[SERVER_FILLS_MARKER_KEY] : [];
      for (const f of list.slice(0, 20)) {
        if (!f || !validKey(f.placementKey) || typeof f.campaignId !== 'string' || !f.campaignId) continue;
        const products = Array.isArray(f.products) ? f.products.filter((p: unknown) => typeof p === 'string').slice(0, 24) : [];
        out.set(f.placementKey, { campaignId: f.campaignId, variantId: typeof f.variantId === 'string' ? f.variantId : '', products });
      }
    } catch {
      // A broken marker: no slot is treated as server-filled (their content is replaced below).
    }
    this.markerFills = out;
    return out;
  }

  /**
   * The server's drawing in a slot element, when the element, its fill and
   * the marker block agree on placement, campaign and variant. A fill they do
   * not agree on (or one this SDK may not show: HTML with
   * allowHtmlJsInAppMessages off) is removed at once and the slot is drawn
   * as any other.
   */
  private serverFillOf(key: string, element: HTMLElement): ServerFill | null {
    const token = element.getAttribute?.(SERVER_FILLED_ATTR);
    if (!token) return null;
    const wrapper = Array.from(element.children || []).find(
      (c) => (c as HTMLElement).classList?.contains('joryio-placement') && c.hasAttribute?.(SERVER_FILL_ATTR),
    ) as HTMLElement | undefined;
    const fill = this.serverFillsOfMarker().get(key);
    const ok =
      !!wrapper &&
      !!fill &&
      wrapper.getAttribute(SERVER_FILL_ATTR) === token &&
      token === `${key}:${fill.campaignId}:${fill.variantId}` &&
      (this.runtime.allowHtml() || !wrapper.querySelector('.joryio-placement-html'));
    if (!ok) {
      this.dropServerFill(element, wrapper ?? null);
      return null;
    }
    attachServerShadowRoots(wrapper!);
    return { ...fill!, wrapper: wrapper! };
  }

  private dropServerFill(element: HTMLElement, wrapper: HTMLElement | null): void {
    wrapper?.remove();
    element.removeAttribute?.(SERVER_FILLED_ATTR);
    element.removeAttribute?.('data-joryio-placement-state');
  }

  /**
   * The slot was filled by the store's server: keep that drawing when this
   * visitor's answer is the same campaign, variant and products (no redraw),
   * else drop it. True when it was kept. Before any answer it stays as it is.
   */
  private settleServerFill(mount: Mount): 'kept' | 'dropped' | 'waiting' {
    const sf = mount.serverFill;
    if (!sf) return 'dropped';
    const entry = this.cache.get(mount.key);
    if (!entry) return 'waiting';
    mount.serverFill = null;
    const items = this.visibleItems(mount.key);
    const item = items[0];
    const products = toProducts(item?.products).map((p) => p.id);
    const html = !!sf.wrapper.querySelector('.joryio-placement-html');
    const same =
      items.length === 1 &&
      entry.placement.isControl !== true &&
      item.id === sf.campaignId &&
      (item.variantId ?? '') === sf.variantId &&
      products.length === sf.products.length &&
      products.every((id, i) => id === sf.products[i]) &&
      (item.content?.kind === 'html') === html &&
      (!html || this.runtime.allowHtml()) &&
      (mount.options.showProducts !== false || !products.length);
    if (!same) {
      this.dropServerFill(mount.element, sf.wrapper);
      return 'dropped';
    }
    mount.pendingUpdate = false;
    this.clearTrackers(mount);
    mount.wrapper = sf.wrapper;
    mount.shown = [item.deliveryId || item.id];
    mount.element.setAttribute('data-joryio-placement-state', 'filled');
    const node = (sf.wrapper.firstElementChild as HTMLElement | null) || sf.wrapper;
    this.trackViewability(mount, node, () => this.report(mount.key, item, 'displayed'));
    this.bindServerFill(mount, sf.wrapper, item);
    if (mount.options.onRender) {
      try {
        mount.options.onRender(this.toPlacement(mount.key), mount.element);
      } catch (error) {
        this.logger.error('The insertPlacement onRender callback threw; ignored:', error);
      }
    }
    return 'kept';
  }

  /**
   * Clicks in a kept server drawing, with the SDK's own rules: a product card
   * reports `clicked` with placementProductElementId and opens through the
   * link router in a new tab; in HTML content an <a> or <button> reports the
   * frame's `link_click` / `cta_click` (or its data-action) and an http(s)
   * link opens in a new tab - inline content never navigates the page it
   * sits in. #anchors, mailto:, tel: and sms: are left to the browser.
   */
  private bindServerFill(mount: Mount, wrapper: HTMLElement, item: PlacementItemWire): void {
    wrapper.addEventListener(
      'click',
      (event: Event) => {
        if (!this.mounts.has(mount) || mount.wrapper !== wrapper) return;
        const path = (typeof (event as any).composedPath === 'function' ? (event as any).composedPath() : [event.target]) as Element[];
        for (const el of path) {
          if (!el || el === wrapper || typeof (el as Element).getAttribute !== 'function') break;
          const productId = el.getAttribute('data-joryio-product');
          if (productId) {
            const href = el.getAttribute('href');
            if (href) event.preventDefault?.();
            this.buttonAction(mount, item, { id: placementProductElementId(productId), action: 'deep_link', url: href || undefined });
            return;
          }
          const tag = (el.tagName || '').toUpperCase();
          if (tag === 'A' || tag === 'BUTTON') {
            const href = tag === 'A' ? el.getAttribute('href') : null;
            if (hasUserGesture()) this.report(mount.key, item, 'clicked', el.getAttribute('data-action') || (href ? 'link_click' : 'cta_click'));
            if (href && !/^(#|mailto:|tel:|sms:)/i.test(href.trim())) {
              event.preventDefault?.();
              const safe = safeHttpUrl(href.trim());
              if (safe && hasUserGesture()) this.openLink(safe, { placementKey: mount.key, itemId: item.id }, () => window.open(safe, '_blank', 'noopener'));
            }
            return;
          }
        }
      },
      true,
    );
  }

  private render(mount: Mount): void {
    if (!this.mounts.has(mount)) return;
    if (mount.serverFill && this.settleServerFill(mount) !== 'dropped') return;
    mount.pendingUpdate = false;
    this.clearTrackers(mount);
    this.clearDrawn(mount);
    const placement = this.toPlacement(mount.key);
    const entry = this.cache.get(mount.key);
    const wrapper = document.createElement('div');
    wrapper.className = 'joryio-placement';
    wrapper.setAttribute('data-joryio-placement-key', mount.key);
    const drawn: PlacementItemWire[] = [];
    for (const item of this.visibleItems(mount.key)) {
      const node = this.drawItem(mount, item);
      if (!node) continue;
      wrapper.appendChild(node);
      drawn.push(item);
      this.trackViewability(mount, node, () => this.report(mount.key, item, 'displayed'));
    }
    mount.shown = drawn.map((item) => item.deliveryId || item.id);
    mount.element.appendChild(wrapper);
    mount.wrapper = wrapper;
    const state = drawn.length ? 'filled' : placement.isControl ? 'control' : 'empty';
    mount.element.setAttribute('data-joryio-placement-state', state);
    if (!drawn.length) {
      // collapse: nothing drawn, the wrapper takes no space. keep_space: the
      // element keeps whatever box the site gave it.
      wrapper.style.display = placement.emptyBehavior === 'keep_space' ? '' : 'none';
      if (placement.isControl && entry?.placement.controlToken) {
        // The holdout's exposure: the SPOT (the site's element) was viewable.
        this.trackViewability(mount, mount.element, () => {
          this.reportControl(mount.key);
          this.markSpotViewable(mount.key);
        });
      }
    }
    if (mount.options.onRender) {
      try {
        mount.options.onRender(placement, mount.element);
      } catch (error) {
        this.logger.error('The insertPlacement onRender callback threw; ignored:', error);
      }
    }
  }

  private drawItem(mount: Mount, item: PlacementItemWire): HTMLElement | null {
    const content = item.content;
    let node: HTMLElement | null = null;
    if (content?.kind === 'html') {
      if (!this.runtime.allowHtml()) {
        this.logger.warn(`Placement ${mount.key}: HTML item skipped (allowHtmlJsInAppMessages is off)`);
        return null;
      }
      node = this.drawHtml(mount, item, content);
    } else if (content?.kind === 'native') {
      node = this.drawNative(mount, item, content);
    } else if (content) {
      return null;
    }
    // Recommended products: a row of cards below the content, or alone for a
    // data item (without products a data item is the app's to draw).
    const products = mount.options.showProducts === false ? [] : toProducts(item.products);
    if (!products.length) return node;
    const row = this.drawProducts(mount, item, products);
    if (!node) return row;
    const box = document.createElement('div');
    box.className = 'joryio-placement-item';
    box.setAttribute('data-joryio-item', item.id);
    box.appendChild(node);
    box.appendChild(row);
    return box;
  }

  /**
   * The built-in product cards: a horizontally scrolling row, one card per
   * product (image, title, price - the compare-at price struck through - and
   * the optional button). A tap reports `clicked` with
   * placementProductElementId and opens the product's link the way a
   * `deep_link` button does: http(s) in a new tab, an app link to the
   * handlers, anything else refused. Styled with the joryio-placement-product*
   * classes.
   */
  private drawProducts(mount: Mount, item: PlacementItemWire, products: PlacementProduct[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'joryio-placement-products';
    row.setAttribute('data-joryio-item', item.id);
    row.style.cssText = 'display:flex;gap:8px;overflow-x:auto;box-sizing:border-box;';
    const requested = Number(mount.options.productCardWidth);
    const width = Number.isFinite(requested) && requested > 0 ? requested : PLACEMENT_PRODUCT_CARD_WIDTH;
    for (const p of products) {
      const card = document.createElement('div');
      card.className = 'joryio-placement-product';
      card.setAttribute('data-joryio-product', p.id);
      card.style.cssText = `flex:0 0 ${width}px;width:${width}px;box-sizing:border-box;`;
      const open = p.url ? () => this.buttonAction(mount, item, { id: placementProductElementId(p.id), action: 'deep_link', url: p.url! }) : null;
      const image = safeHttpUrl(p.imageUrl);
      if (image) {
        const img = document.createElement('img');
        img.className = 'joryio-placement-product-image';
        img.src = image;
        img.alt = p.title || '';
        img.style.cssText = 'display:block;width:100%;aspect-ratio:1/1;object-fit:cover;';
        card.appendChild(img);
      }
      if (p.title) {
        const title = document.createElement('div');
        title.className = 'joryio-placement-product-title';
        title.textContent = p.title;
        card.appendChild(title);
      }
      if (p.price) {
        const price = document.createElement('div');
        price.className = 'joryio-placement-product-price';
        price.textContent = p.price;
        if (p.compareAtPrice) {
          const was = document.createElement('s');
          was.className = 'joryio-placement-product-compare';
          was.textContent = p.compareAtPrice;
          was.style.cssText = 'margin-inline-start:6px;opacity:0.6;';
          price.appendChild(was);
        }
        card.appendChild(price);
      }
      if (open && mount.options.productButtonText) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'joryio-placement-product-button';
        btn.textContent = mount.options.productButtonText;
        btn.addEventListener('click', (e?: Event) => {
          e?.stopPropagation?.();
          open();
        });
        card.appendChild(btn);
      }
      if (open) {
        card.setAttribute('role', 'link');
        card.tabIndex = 0;
        card.style.cursor = 'pointer';
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e?: KeyboardEvent) => {
          if (e?.key === 'Enter') open();
        });
      }
      row.appendChild(card);
    }
    return row;
  }

  private drawNative(
    mount: Mount,
    item: PlacementItemWire,
    content: Extract<PlacementContent, { kind: 'native' }>,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'joryio-placement-card';
    card.setAttribute('data-joryio-item', item.id);
    card.style.cssText = 'position:relative;box-sizing:border-box;';
    const image = safeHttpUrl(content.imageUrl);
    if (image) {
      const img = document.createElement('img');
      img.src = image;
      img.alt = '';
      img.style.cssText = 'display:block;max-width:100%;height:auto;';
      card.appendChild(img);
    }
    if (content.title) {
      const title = document.createElement('div');
      title.className = 'joryio-placement-title';
      title.textContent = content.title;
      card.appendChild(title);
    }
    if (content.body) {
      const body = document.createElement('div');
      body.className = 'joryio-placement-body';
      body.textContent = content.body;
      card.appendChild(body);
    }
    if (content.buttons?.length) {
      const row = document.createElement('div');
      row.className = 'joryio-placement-buttons';
      content.buttons.forEach((b, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = index === 0 ? 'primary' : 'secondary';
        btn.textContent = b.text;
        btn.addEventListener('click', () => this.buttonAction(mount, item, b));
        row.appendChild(btn);
      });
      card.appendChild(row);
    }
    // Inline content has no close control unless the author asked for one.
    if (content.closeButton === true) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'joryio-placement-close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', () => this.dismissItem(mount.key, item));
      card.appendChild(close);
    }
    return card;
  }

  /**
   * A native button: report the click, then act. Unlike an overlay, an inline
   * item stays after a click - only a `dismiss` button (or the close control)
   * removes it.
   */
  private buttonAction(mount: Mount, item: PlacementItemWire, b: { id: string; action: string; url?: string }): void {
    const key = mount.key;
    // Synchronous first: the push prompt needs the click's user activation.
    if (b.action === 'request_push_permission') this.runtime.bridge?.requestPushPermission();
    this.report(key, item, 'clicked', b.id);
    if (b.action === 'url' || b.action === 'deep_link') {
      // http(s) opens in a new tab; an app deep link goes to the site's own
      // handler (the SDK never navigates to a custom scheme); anything else -
      // javascript:, data:, intent:, ... - is refused silently.
      // The site-wide link handler (setLinkHandler) sees it first.
      const url = safeHttpUrl(b.url);
      const context: LinkContext = { placementKey: key, itemId: item.id };
      if (url) {
        this.openLink(url, context, () => window.open(url, '_blank', 'noopener'));
      } else if (b.action === 'deep_link' && isAppDeepLink(b.url) && (mount.options.onDeepLink || this.links?.hasHandler)) {
        const deepLink = (b.url as string).trim();
        this.openLink(deepLink, context, () => {
          if (!mount.options.onDeepLink) return;
          try {
            mount.options.onDeepLink(deepLink, this.toItem(key, item, this.generation));
          } catch (error) {
            this.logger.error('The insertPlacement onDeepLink callback threw; ignored:', error);
          }
        });
      }
      return;
    }
    if (b.action === 'dismiss' || b.action === 'close') {
      this.dismissItem(key, item);
    }
  }

  /** Through the site-wide link handler when there is a router, else straight to the fallback. */
  private openLink(url: string, context: LinkContext, fallback: () => void): void {
    if (this.links) this.links.route(url, 'placement', context, fallback);
    else fallback();
  }

  private drawHtml(mount: Mount, item: PlacementItemWire, content: Extract<PlacementContent, { kind: 'html' }>): HTMLElement {
    const id = `p${++this.frameSeq}`;
    const iframe = document.createElement('iframe');
    iframe.className = 'joryio-placement-frame';
    iframe.setAttribute('data-joryio-item', item.id);
    // The overlay's sandbox exactly: same-origin so the bootstrap can reach
    // the host bridge; author script is stopped by the nonce CSP in the srcdoc.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    iframe.setAttribute('title', 'Placement');
    iframe.style.cssText = 'display:block;width:100%;height:0;border:0;';
    iframe.srcdoc = buildInAppSrcdoc(id, content.html || '', content.css || '', 'placement', PLACEMENT_BRIDGE_GLOBAL);
    this.frames.set(id, { iframe, key: mount.key, item });
    mount.frameIds.push(id);
    return iframe;
  }

  /**
   * The host object the placement frames call into. Every method is keyed by
   * the frame id and acts only while that frame is drawn.
   */
  private installBridge(): void {
    if (typeof window === 'undefined') return;
    const frame = (id: string) => this.frames.get(id);
    (window as any)[PLACEMENT_BRIDGE_GLOBAL] = {
      __owner: this,
      setSize: (id: string, _w: number, height: number) => {
        const f = frame(id);
        if (f && Number.isFinite(height) && height > 0) f.iframe.style.height = `${Math.ceil(height)}px`;
      },
      // A click counts, and a link opens, only from the person's own gesture.
      logClick: (id: string, action?: string) => {
        const f = frame(id);
        if (f && hasUserGesture()) this.report(f.key, f.item, 'clicked', action);
      },
      // Always a new tab, never the host page itself: inline content does not
      // navigate the page it sits in.
      navigate: (id: string, url: string) => {
        if (!frame(id) || !hasUserGesture()) return;
        const safe = safeHttpUrl(url);
        const f = frame(id);
        if (safe && f) this.openLink(safe, { placementKey: f.key, itemId: f.item.id }, () => window.open(safe, '_blank', 'noopener'));
      },
      closeMessage: (id: string) => {
        const f = frame(id);
        if (f) this.dismissItem(f.key, f.item);
      },
      logConversion: () => undefined,
      logCustomEvent: (id: string, name: string, properties?: Record<string, any>) => {
        if (frame(id) && name) this.runtime.bridge?.logCustomEvent(name, properties);
      },
      setCustomUserAttribute: (id: string, key: string, value: any) => {
        if (frame(id) && key) this.runtime.bridge?.setCustomUserAttribute(key, value);
      },
      changeUser: (id: string, userId: string) => {
        if (frame(id) && userId) this.runtime.bridge?.changeUser(userId);
      },
      requestPushPermission: (id: string) => {
        if (frame(id)) this.runtime.bridge?.requestPushPermission();
      },
      submitForm: () => Promise.resolve({ ok: false, message: 'Forms are not available in this spot.' }),
    };
  }

  // ── viewability ─────────────────────────────────────────────────────────

  private pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  /** Whether any part of the host element is on screen (for "never swap under the reader's eyes"). */
  private observeHost(mount: Mount): void {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        mount.hostInView = e.isIntersecting;
        if (!e.isIntersecting && mount.pendingUpdate) this.render(mount);
      }
    });
    observer.observe(mount.element);
    mount.hostObserver = observer;
  }

  /** Measure `node` (the shared rule, trackViewable) while it stays drawn in `mount`. */
  private trackViewability(mount: Mount, node: Element, onViewable: () => void): void {
    let tracker: ViewTracker | null = null;
    tracker = trackViewable(node, () => {
      if (tracker && mount.trackers.includes(tracker)) onViewable();
    });
    mount.trackers.push(tracker);
  }

  private installPageVisibility(): void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    this.pageListener = () => {
      for (const mount of this.mounts) {
        for (const t of mount.trackers) {
          if (this.pageVisible()) t.resume();
          else t.pause();
        }
      }
    };
    document.addEventListener('visibilitychange', this.pageListener);
  }

  // ── session cache ───────────────────────────────────────────────────────

  private subjectKey(): string {
    return `${this.identity.getUserId() || ''}|${this.identity.getAnonymousId()}`;
  }

  private loadCache(): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.removeItem?.(LEGACY_CACHE_STORAGE_NAME);
      const raw = sessionStorage.getItem(placementsStorageKey(this.sdkKey));
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Another visitor's answers (a reset or a login since) are not this one's.
      if (!stored || stored.subject !== this.subjectKey() || typeof stored.entries !== 'object') return;
      for (const [key, entry] of Object.entries<any>(stored.entries)) {
        if (validKey(key) && entry && entry.placement && typeof entry.fetchedAt === 'number') {
          this.cache.set(key, {
            placement: this.normalize(key, entry.placement),
            fetchedAt: entry.fetchedAt,
            url: typeof entry.url === 'string' ? entry.url : null,
          });
        }
      }
    } catch {
      /* storage blocked or corrupt: start empty */
    }
  }

  private persistCache(): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      const entries: Record<string, CacheEntry> = {};
      this.cache.forEach((entry, key) => {
        entries[key] = entry;
      });
      sessionStorage.setItem(placementsStorageKey(this.sdkKey), JSON.stringify({ subject: this.subjectKey(), entries }));
    } catch {
      /* storage blocked or full: memory only */
    }
  }
}

/** The wire's product cards, defensively typed: an entry without an id is dropped. */
/**
 * A browser without declarative shadow DOM leaves the server's
 * `<template shadowrootmode="open">` inert: attach it here, as the parser
 * would have (D466).
 */
export function attachServerShadowRoots(wrapper: HTMLElement): void {
  for (const host of Array.from(wrapper.querySelectorAll?.('.joryio-placement-html') || []) as HTMLElement[]) {
    if (host.shadowRoot || typeof host.attachShadow !== 'function') continue;
    const tpl = Array.from(host.children).find((c) => c.tagName === 'TEMPLATE' && c.getAttribute('shadowrootmode') === 'open') as HTMLTemplateElement | undefined;
    if (!tpl) continue;
    try {
      host.attachShadow({ mode: 'open' }).appendChild(tpl.content);
      tpl.remove();
    } catch {
      // Left as it is: the template stays inert.
    }
  }
}

export function toProducts(raw: unknown): PlacementProduct[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (typeof (p as any).id === 'string' || typeof (p as any).id === 'number'))
    .map((p) => ({
      id: String(p.id),
      title: str(p.title),
      price: str(p.price),
      compareAtPrice: str(p.compareAtPrice),
      discountPercent: typeof p.discountPercent === 'number' ? p.discountPercent : null,
      imageUrl: str(p.imageUrl),
      url: str(p.url),
    }));
}
