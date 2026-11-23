/**
 * Page edits on web (BACKLOG D444 Phase 4, docs/PLACEMENTS_WEBSITE_LAYER.md 2).
 *
 * A page-edit campaign changes elements of the site's own page, found by CSS
 * selector: replace a text, an image, a link, hide an element, or insert a
 * placement next to it. Nothing else - no HTML, no script, no free-form DOM.
 *
 * - Text is set with `textContent` (never parsed as HTML); image and link
 *   addresses must be absolute http(s); a selector that could escape the
 *   anti-flicker style rule is refused. The server checks the same and this
 *   SDK checks again: an edit it does not trust is skipped, never half-applied.
 * - Site settings first (`GET /v1/in-app/site-settings?sdkKey=`, public,
 *   the same for every visitor; asked once per SDK session and refreshed at
 *   most every SITE_SETTINGS_SESSION_REFRESH_SECONDS, kept in sessionStorage
 *   so the session's later page loads do not wait for it): page edits off
 *   for this site, or no live page-edit campaign, = nothing is asked or
 *   applied on this page view. Otherwise the per-visitor answer.
 * - Anti-flicker: only edited elements are hidden (opacity, so the layout
 *   does not move), for at most PAGE_EDIT_ANTI_FLICKER_MS from the start of
 *   the page, never the whole body: the ones edited on this page last time,
 *   or - on a first view, when there are none - the site's list from the site
 *   settings (selectors only).
 * - Static edits from the last answer for this page apply at once, as each
 *   element appears (MutationObserver); personalized edits apply when the
 *   answer arrives and are never stored.
 * - A route change undoes this page's edits and applies the next page's.
 * - Exposure: `in_app.displayed` once an edit of the experience landed on an
 *   element; a control visitor reports `in_app.control_viewed` once one of
 *   the control's selectors is on the page.
 * - Server-applied edits (D450): a store plugin may already have written the
 *   edits that are the same for every visitor into the page's HTML. Its
 *   marker - a JSON block `#joryio-server-page-edits` and
 *   `data-joryio-applied="<campaignId>:<editId>"` on each changed element -
 *   says which. The SDK never applies those again (no double insert, no
 *   flicker), counts them as landed for the exposure (once, with its own
 *   answer's token), keeps them out of the anti-flicker rule, and undoes one
 *   (from `data-joryio-orig` and the element's `<template data-joryio-orig>`)
 *   when the definitive answer for this visitor no longer carries it -
 *   paused, edited, the visitor suppressed or in a control, page edits
 *   switched off - or on a route change to another page.
 */
import { bucketHash } from '../utils/bucket-hash';
import type { IdentityManager } from './identity';
import type { SessionManager } from './session';
import type { Logger } from '../utils/logger';
import type { InAppAuthProvider } from './inapp';
import type { PlacementConsent } from './placements';
import { sdkIdentityHeaders } from './config';
import { currentPageUrl, PAGE_CONTEXT_CAPABILITY, type PageContextTracker } from './page-context';

export const PAGE_EDIT_OPERATIONS = ['replace_text', 'replace_image', 'replace_link', 'hide', 'insert_placement'] as const;
/** `replace` ("Instead of it"): the element is hidden and the spot takes its place, right after it. */
export const PAGE_EDIT_POSITIONS = ['before', 'after', 'prepend', 'append', 'replace'] as const;
export const PAGE_EDITS_CAPABILITY = 'page_edits';
/** The longest edited elements stay hidden while the SDK waits. Never the whole body. */
export const PAGE_EDIT_ANTI_FLICKER_MS = 300;

const MAX_SELECTOR_LENGTH = 500;
const MAX_TEXT_LENGTH = 2000;
const MAX_URL_LENGTH = 2048;
const PLACEMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const STYLE_ID = 'joryio-page-edits-anti-flicker';
/**
 * Both stores are per workspace: the names carry a hash of the SDK key (the
 * flags cache's scheme), so two workspaces on one origin never share edits
 * or anti-flicker selectors. The unscoped names of earlier builds are never
 * read; they are removed on the first load.
 */
const LEGACY_ANSWER_STORE = 'jry_page_edits';
const LEGACY_SELECTOR_STORE = 'jry_page_edit_selectors';
export const pageEditsStorageKeys = (sdkKey: string): { answers: string; selectors: string; site: string } => {
  const h = bucketHash(sdkKey).toString(36);
  return { answers: `jry_page_edits_${h}`, selectors: `jry_page_edit_selectors_${h}`, site: `jry_page_edit_site_${h}` };
};
const MAX_REMEMBERED_PAGES = 50;
const DEFAULT_TTL_SECONDS = 300;
/**
 * The site settings are asked once per SDK session and then at most every
 * this many seconds within it (sessionStorage, per workspace, tied to the
 * session id: a new session asks again). The server's `ttlSeconds` (60) is
 * the HTTP cache lifetime for browsers and the CDN and no longer shortens
 * this: on a multi-page store every full page load used to re-ask, and the
 * answer is the same for every visitor and changes only when a page-edit
 * campaign is launched or page edits are switched on or off. The cost, by
 * design: a newly launched page-edit campaign reaches a visitor already on
 * the site within this time. Pausing is not delayed - `/page-edits` checks
 * every campaign's liveness itself on every page.
 */
export const SITE_SETTINGS_SESSION_REFRESH_SECONDS = 600;
/** At most this many selectors of the site list go into the style rule (the server sends at most 200). */
const MAX_SITE_SELECTORS = 200;

/**
 * The marker a store plugin writes with the edits it applied in the HTML
 * (backend common/web-experience/server-page-edits.ts, the plugins' shared
 * core; pinned by server-page-edits-parity.spec.ts).
 */
export const SERVER_PAGE_EDITS_MARKER_ID = 'joryio-server-page-edits';
export const SERVER_APPLIED_ATTR = 'data-joryio-applied';
export const SERVER_ORIG_ATTR = 'data-joryio-orig';
export const SERVER_SPOT_ATTR = 'data-joryio-server-spot';
const SERVER_MARKER_VERSION = 1;

interface ServerEdit {
  experienceId: string;
  variantId: string | null;
  edit: PageEditWire;
}

const sameEdit = (a: PageEditWire, b: PageEditWire): boolean =>
  a.id === b.id &&
  a.selector === b.selector &&
  a.operation === b.operation &&
  (a.value ?? null) === (b.value ?? null) &&
  (a.placementKey ?? null) === (b.placementKey ?? null) &&
  (a.position ?? null) === (b.position ?? null) &&
  !b.personalized;

function serverMarkerElement(): HTMLScriptElement | null {
  const head = document.head;
  if (!head) return null;
  for (const c of Array.from(head.children)) {
    if (c.id === SERVER_PAGE_EDITS_MARKER_ID) {
      return c.tagName === 'SCRIPT' && (c.getAttribute('type') || '').trim().toLowerCase() === 'application/json' ? (c as HTMLScriptElement) : null;
    }
  }
  return null;
}

/** An address the undo may write back: absolute http(s) or relative (no scheme). Anything else is dropped. */
function safeRestoredUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return v;
  // A scheme is letters before a ':' that comes before any '/', '?' or '#'.
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? null : v;
}

const safeRestoredSrcset = (v: unknown): string | null =>
  typeof v === 'string' && v.split(',').every((c) => !c.trim() || safeRestoredUrl(c.trim().split(/\s+/)[0]) !== null) ? v : null;

const HIDE_DECLARATION = 'display:none !important';

/** Hide one element (display:none !important); returns how to show it again as it was. */
function hideElement(h: HTMLElement): () => void {
  const display = h.style.getPropertyValue('display');
  const priority = h.style.getPropertyPriority('display');
  h.style.setProperty('display', 'none', 'important');
  return () => (display ? h.style.setProperty('display', display, priority) : h.style.removeProperty('display'));
}

/**
 * Undo a hide the server wrote (`hide`, and `insert_placement` at `replace`).
 * Never a style string from the marker: the original is put back only when
 * the attribute is exactly it plus the server's one declaration; otherwise
 * that one declaration is removed.
 */
function undoServerHide(el: Element, orig: Record<string, any>): void {
  const current = el.getAttribute('style') || '';
  const before = typeof orig.style === 'string' ? orig.style : null;
  const base = before === null ? '' : before.trim().replace(/;+$/, '');
  if (current === (base ? base + ';' : '') + HIDE_DECLARATION) {
    if (before === null) el.removeAttribute('style');
    else el.setAttribute('style', before);
  } else if ((el as HTMLElement).style?.getPropertyValue('display') === 'none') {
    (el as HTMLElement).style.removeProperty('display');
  }
}

/**
 * Inline text markup a replaced element's original content may come back with.
 * Everything else is unwrapped to its text (its children are kept, checked the same way):
 * no script, frame, object, embed, meta, base, link, style, form, svg or math element is
 * ever created, and no attribute outside RESTORE_ATTRIBUTES (no on*, style, srcdoc, data).
 */
const RESTORE_ELEMENTS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I', 'IMG', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR']);
const RESTORE_ATTRIBUTES = new Set(['class', 'id', 'title', 'lang', 'dir', 'alt', 'width', 'height', 'datetime', 'href', 'src', 'srcset', 'rel', 'target']);
const MAX_RESTORE_NODES = 500;

function restoreInline(from: DocumentFragment): DocumentFragment {
  const out = document.createDocumentFragment();
  let budget = MAX_RESTORE_NODES;
  const copy = (src: Node, into: Node): void => {
    for (const n of Array.from(src.childNodes)) {
      if (budget-- <= 0) return;
      if (n.nodeType === 3) {
        into.appendChild(document.createTextNode(n.nodeValue || ''));
      } else if (n.nodeType === 1) {
        const e = n as Element;
        if (e.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !RESTORE_ELEMENTS.has(e.tagName)) {
          // Not allowed: only its text and allowed descendants, never the element.
          if (!/^(SCRIPT|STYLE|TEMPLATE|IFRAME|OBJECT|EMBED|NOSCRIPT|TEXTAREA|TITLE)$/.test(e.tagName)) copy(e, into);
          continue;
        }
        const made = document.createElement(e.tagName.toLowerCase());
        for (const a of Array.from(e.attributes)) {
          const name = a.name.toLowerCase();
          if (!RESTORE_ATTRIBUTES.has(name)) continue;
          if (name === 'href' || name === 'src') {
            const v = safeRestoredUrl(a.value);
            if (v !== null) made.setAttribute(name, v);
          } else if (name === 'srcset') {
            const v = safeRestoredSrcset(a.value);
            if (v !== null) made.setAttribute(name, v);
          } else {
            made.setAttribute(name, a.value);
          }
        }
        into.appendChild(made);
        copy(e, made);
      }
    }
  };
  copy(from, out);
  return out;
}

const tokensOf = (el: Element): string[] => (el.getAttribute(SERVER_APPLIED_ATTR) || '').split(/\s+/).filter(Boolean);

/** `GET /v1/in-app/site-settings` (backend common/web-experience/page-edit-site.ts). */
export interface SiteSettingsResponse {
  success?: boolean;
  ttlSeconds?: number;
  pageEdits?: { enabled?: boolean; active?: boolean; antiFlickerSelectors?: string[] };
}
export interface PageEditSite {
  enabled: boolean;
  active: boolean;
  antiFlickerSelectors: string[];
}

export type PageEditOperation = (typeof PAGE_EDIT_OPERATIONS)[number];
export type PageEditPosition = (typeof PAGE_EDIT_POSITIONS)[number];

export interface PageEditWire {
  id: string;
  selector: string;
  operation: PageEditOperation;
  value?: string;
  placementKey?: string;
  position?: PageEditPosition;
  personalized?: true;
}

export interface PageEditExperienceWire {
  id: string;
  variantId: string | null;
  deliveryId: string | null;
  deliveryToken: string | null;
  isControl: boolean;
  controlToken: string | null;
  selectors: string[];
  edits: PageEditWire[];
}

export interface PageEditsResponse {
  success?: boolean;
  ttlSeconds?: number;
  experiences?: PageEditExperienceWire[];
}

export interface PageEditRuntime {
  /** As placements: null = send nothing; `granted` = personal serving and reporting. */
  consent: () => PlacementConsent | null;
  requestTimeoutMs?: number;
  noteStatus?: (status: number, data: any) => void;
}

/** Same rule as the server: nothing that could close the style rule, no comment, no control character. */
export function isSafeSelector(selector: unknown): selector is string {
  if (typeof selector !== 'string') return false;
  const s = selector.trim();
  if (!s || s.length > MAX_SELECTOR_LENGTH) return false;
  if (/[{};<@]/.test(s) || s.includes('/*') || s.includes('*/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    if (typeof document !== 'undefined') document.createDocumentFragment().querySelector(s);
  } catch {
    return false; // not a selector this browser parses
  }
  return true;
}

export function isSafeEditUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > MAX_URL_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(u)) return false;
  return /^https?:\/\/[^/?#\s]+/i.test(u);
}

/** The edit as this SDK will apply it, or null - an edit it does not trust is skipped whole. */
export function trustedEdit(e: any): PageEditWire | null {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !isSafeSelector(e.selector)) return null;
  const base = { id: e.id, selector: e.selector.trim(), ...(e.personalized === true ? { personalized: true as const } : {}) };
  switch (e.operation) {
    case 'hide':
      return { ...base, operation: 'hide' };
    case 'replace_text':
      return typeof e.value === 'string' && e.value.length <= MAX_TEXT_LENGTH ? { ...base, operation: 'replace_text', value: e.value } : null;
    case 'replace_image':
    case 'replace_link':
      return isSafeEditUrl(e.value) ? { ...base, operation: e.operation, value: e.value.trim() } : null;
    case 'insert_placement':
      return typeof e.placementKey === 'string' && PLACEMENT_KEY_PATTERN.test(e.placementKey)
        ? { ...base, operation: 'insert_placement', placementKey: e.placementKey, position: (PAGE_EDIT_POSITIONS as readonly string[]).includes(e.position) ? e.position : 'after' }
        : null;
    default:
      return null;
  }
}

interface Applied {
  el: Element;
  editId: string;
  undo: () => void;
}

interface Experience {
  wire: PageEditExperienceWire;
  edits: PageEditWire[];
}

/** The site settings as stored for one SDK session (`sid`), answered at `at`. */
interface StoredSite {
  sid: string;
  at: number;
  value: PageEditSite;
}

export class PageEditManager {
  private page: PageContextTracker | null = null;
  private pageUnsubscribe: (() => void) | null = null;
  private experiences: Experience[] = [];
  private applied: Applied[] = [];
  private reported = new Set<string>();
  private observer: MutationObserver | null = null;
  private scheduled = false;
  private flickerTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current page started: the anti-flicker never lasts past this + PAGE_EDIT_ANTI_FLICKER_MS. */
  private pageStartedAt = 0;
  /** The last site settings answer, for its session id (mirrors the sessionStorage entry). */
  private site: StoredSite | null = null;
  private siteRequest: Promise<PageEditSite | null> | null = null;
  private readonly stores: { answers: string; selectors: string; site: string };
  /** Edits the page's HTML arrived with (token -> edit); null until the marker was read. */
  private server: Map<string, ServerEdit> | null = null;
  /** The page those were written for: a route change elsewhere undoes them. */
  private serverUrl: string | null = null;
  private generation = 0;
  private started = false;
  private destroyed = false;

  constructor(
    private apiEndpoint: string,
    private sdkKey: string,
    private identity: IdentityManager,
    private session: SessionManager,
    private logger: Logger,
    private runtime: PageEditRuntime,
    private auth?: InAppAuthProvider,
  ) {
    this.stores = pageEditsStorageKeys(sdkKey);
    try {
      // Not workspace-scoped: another workspace on this origin may have written them.
      localStorage.removeItem(LEGACY_SELECTOR_STORE);
      sessionStorage.removeItem(LEGACY_ANSWER_STORE);
    } catch {
      /* storage blocked */
    }
  }

  setPageContext(tracker: PageContextTracker | null): void {
    this.pageUnsubscribe?.();
    this.pageUnsubscribe = null;
    this.page = tracker;
    if (tracker) {
      this.pageUnsubscribe = tracker.onSignal((s) => {
        if (s.type === 'page_change' && this.started) this.loadPage();
      });
    }
  }

  /** Hide what was edited here last time, apply what is known, observe the DOM, ask the server. */
  start(): void {
    if (this.started || this.destroyed || typeof document === 'undefined') return;
    this.started = true;
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    this.loadPage();
  }

  /**
   * The audience changed (identify, reset, consent): forget this visitor's
   * answers and ask again. `siteSettings: true` (reset, wipeData, a consent
   * change) forgets the stored site settings too; identify keeps them - they
   * are the same for every visitor of the site.
   */
  invalidate(opts: { siteSettings?: boolean } = {}): void {
    this.generation++;
    this.reported.clear();
    if (opts.siteSettings) this.forgetSite();
    try {
      sessionStorage.removeItem(this.stores.answers);
    } catch {
      /* ignore */
    }
    if (this.started) this.loadPage();
  }

  destroy(): void {
    this.destroyed = true;
    this.pageUnsubscribe?.();
    this.observer?.disconnect();
    this.observer = null;
    this.revertAll();
    this.showAll();
  }

  /** Currently applied edits, for tests and debugging. */
  appliedCount(): number {
    return this.applied.length;
  }

  /** Edits the page arrived with from the server and still carries, for tests and debugging. */
  serverAppliedCount(): number {
    return this.serverEdits().size;
  }

  // ── one page ─────────────────────────────────────────────────────────────

  private url(): string | null {
    return this.page ? this.page.current().url : currentPageUrl();
  }

  private loadPage(): void {
    const generation = ++this.generation;
    this.revertAll();
    const url = this.url();
    if (!url) {
      this.experiences = [];
      return;
    }
    this.pageStartedAt = Date.now();
    // The server's edits belong to the page they were written for.
    const server = this.serverEdits();
    if (this.serverUrl === null) this.serverUrl = url;
    else if (url !== this.serverUrl && server.size) this.reconcileServer([]);
    // 1. Anti-flicker: the elements edited on this page last time, at most 300 ms.
    const remembered = this.rememberedSelectors(url);
    this.hide(remembered);
    // 2. Static edits from the last answer for this page, applied as elements appear.
    this.experiences = this.cachedExperiences(url);
    this.applyAll();
    // 3. The site settings (cached), then the answer for this page and visitor.
    void this.siteThenFetch(url, generation, remembered.length > 0);
  }

  private async siteThenFetch(url: string, generation: number, rememberedAny: boolean): Promise<void> {
    // A stored answer for this session is used at once - no wait before the
    // per-visitor request - and refreshed in the background when it is older
    // than SITE_SETTINGS_SESSION_REFRESH_SECONDS. Only without one (first
    // page of a session) does the page wait for the site settings.
    const stored = this.storedSite();
    let site: PageEditSite | null;
    if (stored) {
      site = stored.value;
      if (Date.now() - stored.at >= SITE_SETTINGS_SESSION_REFRESH_SECONDS * 1000) {
        void this.requestSite().then((fresh) => {
          // Was off or idle and is live now: this page asks after all.
          if (fresh && fresh.enabled && fresh.active && !(site!.enabled && site!.active) && generation === this.generation && !this.destroyed) {
            void this.fetch(url, generation);
          }
        });
      }
    } else {
      site = await this.siteSettings();
    }
    if (generation !== this.generation || this.destroyed) return;
    if (site && (!site.enabled || !site.active)) {
      // Off for this site, or nothing live: undo what the cache (or the server) applied, ask nothing.
      this.revertAll();
      this.reconcileServer([]);
      this.experiences = [];
      this.showAll();
      return;
    }
    // First view on this page: hold back the site's edited elements, inside the same 300 ms.
    if (site && !rememberedAny && site.antiFlickerSelectors.length) this.hide(site.antiFlickerSelectors);
    await this.fetch(url, generation);
  }

  /**
   * The site settings: one GET per SDK session, then at most one per
   * SITE_SETTINGS_SESSION_REFRESH_SECONDS within it, kept in sessionStorage
   * per workspace across the session's page loads. A CORS-simple request (no
   * custom header, the key in the query string - the server refuses a key in
   * a header there, the URL being the cache key), so no preflight. Null when
   * unknown (network error, an HTTP error, an answer it cannot read): then
   * the SDK asks /page-edits as it always did, and nothing is stored.
   */
  siteSettings(): Promise<PageEditSite | null> {
    const stored = this.storedSite();
    if (stored && Date.now() - stored.at < SITE_SETTINGS_SESSION_REFRESH_SECONDS * 1000) return Promise.resolve(stored.value);
    return this.requestSite();
  }

  /** The stored answer for the current session id (any age), or null. */
  private storedSite(): StoredSite | null {
    const sid = this.session.getSessionId();
    if (!sid) return null; // no session (after wipeData): nothing to tie it to
    if (this.site && this.site.sid === sid) return this.site;
    this.site = null;
    try {
      const raw = JSON.parse(sessionStorage.getItem(this.stores.site) || 'null');
      const v = raw?.value;
      if (raw && raw.sid === sid && typeof raw.at === 'number' && raw.at <= Date.now() && v && typeof v === 'object') {
        this.site = {
          sid,
          at: raw.at,
          value: {
            enabled: v.enabled !== false,
            active: v.active !== false,
            antiFlickerSelectors: (Array.isArray(v.antiFlickerSelectors) ? v.antiFlickerSelectors : []).filter(isSafeSelector).slice(0, MAX_SITE_SELECTORS),
          },
        };
      } else if (raw) {
        sessionStorage.removeItem(this.stores.site); // another session's answer
      }
    } catch {
      /* storage blocked or unreadable: ask */
    }
    return this.site;
  }

  private forgetSite(): void {
    this.site = null;
    try {
      sessionStorage.removeItem(this.stores.site);
    } catch {
      /* ignore */
    }
  }

  private requestSite(): Promise<PageEditSite | null> {
    if (this.siteRequest) return this.siteRequest;
    const request = (async (): Promise<PageEditSite | null> => {
      const sid = this.session.getSessionId();
      try {
        const res = await fetch(`${this.apiEndpoint}/v1/in-app/site-settings?sdkKey=${encodeURIComponent(this.sdkKey)}`, { method: 'GET', credentials: 'omit' });
        if (!res.ok) {
          this.runtime.noteStatus?.(res.status, null);
          this.forgetSite();
          return null;
        }
        const data: SiteSettingsResponse = await res.json();
        const pe = data?.pageEdits;
        if (!pe || typeof pe !== 'object') {
          this.forgetSite();
          return null;
        }
        const value: PageEditSite = {
          enabled: pe.enabled !== false,
          active: pe.active !== false,
          antiFlickerSelectors: (Array.isArray(pe.antiFlickerSelectors) ? pe.antiFlickerSelectors : []).filter(isSafeSelector).slice(0, MAX_SITE_SELECTORS),
        };
        // data.ttlSeconds is the HTTP cache lifetime; the SDK keeps the
        // answer for the session (SITE_SETTINGS_SESSION_REFRESH_SECONDS).
        if (sid) {
          this.site = { sid, at: Date.now(), value };
          try {
            sessionStorage.setItem(this.stores.site, JSON.stringify(this.site));
          } catch {
            /* storage full or blocked: kept in memory for this page */
          }
        }
        return value;
      } catch (error) {
        this.logger.debug('Site settings request failed', error);
        // Unknown: a stale stored answer is not trusted past its refresh time.
        this.forgetSite();
        return null;
      } finally {
        this.siteRequest = null;
      }
    })();
    this.siteRequest = request;
    return request;
  }

  private async fetch(url: string, generation: number): Promise<void> {
    const consent = this.runtime.consent();
    if (consent === null || this.destroyed) {
      this.showAll();
      return;
    }
    const personal = consent === 'granted';
    const userId = personal ? this.identity.getUserId() : null;
    const anonymousId = personal ? this.identity.getAnonymousId() : null;
    const body = {
      ...(userId ? { userId } : {}),
      ...(anonymousId ? { anonymousId } : {}),
      ...(personal ? { sessionId: this.session.getSessionId() } : {}),
      deviceType: 'web',
      locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
      capabilities: [PAGE_CONTEXT_CAPABILITY, PAGE_EDITS_CAPABILITY],
      trackingConsent: consent,
      context: this.page ? this.page.current() : { url, pageVariables: {}, dataLayer: {} },
    };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), this.runtime.requestTimeoutMs ?? 10000);
    try {
      const res = await fetch(`${this.apiEndpoint}/v1/in-app/page-edits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...sdkIdentityHeaders(),
          ...(personal ? this.auth?.getSdkAuthHeaders(userId, userId ? null : anonymousId) || {} : {}),
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (generation !== this.generation) return;
      if (!res.ok) {
        // 429 and every other failure: keep what is applied (the cached static edits).
        this.runtime.noteStatus?.(res.status, null);
        return;
      }
      const data: PageEditsResponse = await res.json();
      if (generation !== this.generation || !data || data.success === false || !Array.isArray(data.experiences)) return;
      const experiences = data.experiences
        .filter((x) => x && typeof x.id === 'string')
        .map((wire) => ({ wire, edits: (Array.isArray(wire.edits) ? wire.edits : []).map(trustedEdit).filter((e): e is PageEditWire => !!e) }));
      this.revertAll();
      this.experiences = experiences;
      // The definitive answer: a server-applied edit it no longer carries is undone first.
      this.reconcileServer(experiences);
      this.remember(url, experiences, data.ttlSeconds);
      this.applyAll();
    } catch (error) {
      this.logger.debug('Page edits request failed', error);
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.showAll();
    }
  }

  // ── applying ─────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.applyAll();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else void Promise.resolve().then(run);
  }

  private applyAll(): void {
    if (this.destroyed || typeof document === 'undefined') return;
    // Our own DOM writes would wake the observer; it is paused while we write.
    this.observer?.disconnect();
    try {
      for (const x of this.experiences) {
        if (x.wire.isControl) {
          const seen = (x.wire.selectors || []).some((s) => isSafeSelector(s) && this.query(s).length > 0);
          if (seen) this.reportControl(x.wire);
          continue;
        }
        let landed = false;
        for (const edit of x.edits) {
          const token = `${x.wire.id}:${edit.id}`;
          const server = this.serverEdits().get(token);
          const byServer = !!server && server.variantId === (x.wire.variantId ?? null) && sameEdit(server.edit, edit);
          for (const el of this.query(edit.selector)) {
            if (this.applied.some((a) => a.el === el && a.editId === edit.id)) {
              landed = true;
              continue;
            }
            // Already in the HTML the server sent: never applied a second time.
            if (byServer && tokensOf(el).includes(token)) {
              landed = true;
              continue;
            }
            const undo = this.applyOne(el, edit);
            if (undo) {
              this.applied.push({ el, editId: edit.id, undo });
              landed = true;
            }
          }
        }
        if (landed) this.reportDisplayed(x.wire);
      }
    } finally {
      if (this.observer && document.documentElement) this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  private query(selector: string): Element[] {
    try {
      return Array.from(document.querySelectorAll(selector)).filter((el) => !(el as HTMLElement).closest?.('[data-joryio-editor]'));
    } catch {
      return [];
    }
  }

  /** One edit on one element; returns how to undo it, or null when it does not fit the element. */
  private applyOne(el: Element, edit: PageEditWire): (() => void) | null {
    const h = el as HTMLElement;
    switch (edit.operation) {
      case 'replace_text': {
        const before = Array.from(el.childNodes);
        el.textContent = edit.value ?? '';
        return () => {
          el.textContent = '';
          before.forEach((n) => el.appendChild(n));
        };
      }
      case 'replace_image': {
        if (el.tagName !== 'IMG') return null;
        const src = el.getAttribute('src');
        const srcset = el.getAttribute('srcset');
        el.setAttribute('src', edit.value!);
        // A srcset would win over the new src in every browser.
        el.removeAttribute('srcset');
        return () => {
          if (src === null) el.removeAttribute('src');
          else el.setAttribute('src', src);
          if (srcset !== null) el.setAttribute('srcset', srcset);
        };
      }
      case 'replace_link': {
        if (el.tagName !== 'A') return null;
        const href = el.getAttribute('href');
        el.setAttribute('href', edit.value!);
        return () => (href === null ? el.removeAttribute('href') : el.setAttribute('href', href));
      }
      case 'hide':
        return hideElement(h);
      case 'insert_placement': {
        const spot = document.createElement('div');
        spot.setAttribute('data-joryio-placement', edit.placementKey!);
        spot.setAttribute('data-joryio-edit', edit.id);
        const where: InsertPosition =
          edit.position === 'before' ? 'beforebegin' : edit.position === 'prepend' ? 'afterbegin' : edit.position === 'append' ? 'beforeend' : 'afterend';
        el.insertAdjacentElement(where, spot);
        if (edit.position !== 'replace') return () => spot.remove();
        // "Instead of it": the spot sits where the element was, the element is hidden.
        const show = hideElement(h);
        return () => {
          spot.remove();
          show();
        };
      }
      default:
        return null;
    }
  }

  private revertAll(): void {
    const applied = this.applied.splice(0).reverse();
    if (!applied.length) return;
    this.observer?.disconnect();
    try {
      for (const a of applied) {
        try {
          a.undo();
        } catch {
          /* the element may be gone */
        }
      }
    } finally {
      if (this.observer && typeof document !== 'undefined' && document.documentElement) {
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
  }

  // ── anti-flicker ─────────────────────────────────────────────────────────

  private hide(selectors: string[]): void {
    const safe = selectors.filter(isSafeSelector);
    if (!safe.length || typeof document === 'undefined') return;
    // Never past PAGE_EDIT_ANTI_FLICKER_MS from the start of this page, however late the list arrived.
    const left = PAGE_EDIT_ANTI_FLICKER_MS - (Date.now() - (this.pageStartedAt || Date.now()));
    if (left <= 0) return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    // Only these elements, never the body; opacity, so the layout does not move.
    // Elements the server already edited are never held back.
    style.textContent = this.serverEdits().size
      ? `:is(${safe.join(',')}):not([${SERVER_APPLIED_ATTR}]){opacity:0 !important}`
      : `${safe.join(',')}{opacity:0 !important}`;
    if (this.flickerTimer) clearTimeout(this.flickerTimer);
    this.flickerTimer = setTimeout(() => this.showAll(), left);
  }

  private showAll(): void {
    if (this.flickerTimer) clearTimeout(this.flickerTimer);
    this.flickerTimer = null;
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch {
      /* ignore */
    }
  }

  // ── what is remembered (selectors and static edits only, never a personalized value) ──

  private subjectKey(): string {
    return `${this.identity.getUserId() || ''}|${this.identity.getAnonymousId()}`;
  }

  private remember(url: string, experiences: Experience[], ttlSeconds?: number): void {
    const selectors = [...new Set(experiences.flatMap((x) => (x.wire.isControl ? [] : x.edits.map((e) => e.selector))))];
    try {
      const all = JSON.parse(localStorage.getItem(this.stores.selectors) || '{}') || {};
      delete all[url];
      if (selectors.length) all[url] = selectors.slice(0, 50);
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PAGES))) delete all[k];
      localStorage.setItem(this.stores.selectors, JSON.stringify(all));
    } catch {
      /* storage blocked: no anti-flicker next time, nothing else */
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.stores.answers) || '{}') || {};
      const pages = stored.subject === this.subjectKey() && stored.pages ? stored.pages : {};
      pages[url] = {
        at: Date.now(),
        ttl: (ttlSeconds && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000,
        experiences: experiences
          .filter((x) => !x.wire.isControl)
          .map((x) => ({ ...x.wire, deliveryToken: null, edits: x.edits.filter((e) => !e.personalized) }))
          .filter((x) => x.edits.length),
      };
      sessionStorage.setItem(this.stores.answers, JSON.stringify({ subject: this.subjectKey(), pages }));
    } catch {
      /* ignore */
    }
  }

  private rememberedSelectors(url: string): string[] {
    try {
      const all = JSON.parse(localStorage.getItem(this.stores.selectors) || '{}') || {};
      return Array.isArray(all[url]) ? all[url].filter((s: unknown) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  private cachedExperiences(url: string): Experience[] {
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.stores.answers) || '{}') || {};
      if (stored.subject !== this.subjectKey()) return [];
      const entry = stored.pages?.[url];
      if (!entry || Date.now() - entry.at > entry.ttl) return [];
      // Applied, never reported: the exposure belongs to the answer with a token.
      return (entry.experiences || []).map((wire: PageEditExperienceWire) => ({
        wire: { ...wire, isControl: false, deliveryToken: null },
        edits: (wire.edits || []).map(trustedEdit).filter((e): e is PageEditWire => !!e && !e.personalized),
      }));
    } catch {
      return [];
    }
  }

  // ── edits the server applied (D450) ──────────────────────────────────────

  /** The marker, read once it is in the DOM (it sits right after <head>). */
  private serverEdits(): Map<string, ServerEdit> {
    if (this.server) return this.server;
    const found = new Map<string, ServerEdit>();
    if (typeof document === 'undefined') return found;
    // Trusted only where the plugin writes it: a JSON <script> directly in <head>
    // (the plugin inserts it right after <head>, before any page script). An
    // element with that id anywhere else - user content in the body, DOM
    // clobbering - is ignored.
    const el = serverMarkerElement();
    if (!el) {
      // Not (yet) in the DOM: asked again on the next call while the page is still loading.
      if (document.readyState !== 'loading') this.server = found;
      return found;
    }
    try {
      const data = JSON.parse(el.textContent || '{}');
      if (data && data.v === SERVER_MARKER_VERSION && Array.isArray(data.experiences)) {
        for (const x of data.experiences) {
          if (!x || typeof x.id !== 'string' || !Array.isArray(x.edits)) continue;
          for (const raw of x.edits) {
            const edit = trustedEdit(raw);
            if (edit && !edit.personalized) found.set(`${x.id}:${edit.id}`, { experienceId: x.id, variantId: typeof x.variantId === 'string' ? x.variantId : null, edit });
          }
        }
      }
    } catch {
      /* a marker this SDK cannot read: treated as none; the edits it lists stay as the page has them */
    }
    this.server = found;
    return found;
  }

  /**
   * Keep the server-applied edits the definitive answer still carries for this
   * visitor (same campaign, variant and edit); undo every other one.
   */
  private reconcileServer(experiences: Experience[]): void {
    const server = this.serverEdits();
    if (!server.size || typeof document === 'undefined') return;
    const keep = new Set<string>();
    for (const x of experiences) {
      if (x.wire.isControl) continue;
      for (const e of x.edits) {
        const token = `${x.wire.id}:${e.id}`;
        const s = server.get(token);
        if (s && s.variantId === (x.wire.variantId ?? null) && sameEdit(s.edit, e)) keep.add(token);
      }
    }
    const undo = [...server.keys()].filter((t) => !keep.has(t));
    if (!undo.length) return;
    this.observer?.disconnect();
    try {
      for (const token of undo) {
        this.undoServerEdit(token, server.get(token)!.edit);
        server.delete(token);
      }
    } finally {
      if (this.observer && document.documentElement) this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  /** Put back what the server changed for one edit, from the undo data it left on each element. */
  private undoServerEdit(token: string, edit: PageEditWire): void {
    for (const el of Array.from(document.querySelectorAll(`[${SERVER_APPLIED_ATTR}]`))) {
      const tokens = tokensOf(el);
      if (!tokens.includes(token)) continue;
      let all: Record<string, any> = {};
      try {
        all = JSON.parse(el.getAttribute(SERVER_ORIG_ATTR) || '{}') || {};
      } catch {
        all = {};
      }
      const orig = all[token] || {};
      // Only an element that still shows exactly what the server applied is put back,
      // and only with values that pass the same checks as an edit.
      try {
        switch (edit.operation) {
          case 'replace_text': {
            const tpl = Array.from(el.children).find((c) => c.tagName === 'TEMPLATE' && c.getAttribute(SERVER_ORIG_ATTR) === token) as HTMLTemplateElement | undefined;
            if (tpl && tpl.content && el.textContent === edit.value) {
              // Rebuilt node by node through an allowlist - never the template's markup made live.
              const restored = restoreInline(tpl.content);
              el.textContent = '';
              el.appendChild(restored);
            }
            break;
          }
          case 'replace_image':
            if (el.tagName === 'IMG' && el.getAttribute('src') === edit.value) {
              const src = safeRestoredUrl(orig.src);
              const srcset = safeRestoredSrcset(orig.srcset);
              if (src === null) el.removeAttribute('src');
              else el.setAttribute('src', src);
              if (srcset !== null) el.setAttribute('srcset', srcset);
            }
            break;
          case 'replace_link':
            if (el.tagName === 'A' && el.getAttribute('href') === edit.value) {
              const href = safeRestoredUrl(orig.href);
              if (href === null) el.removeAttribute('href');
              else el.setAttribute('href', href);
            }
            break;
          case 'hide':
            undoServerHide(el, orig);
            break;
          case 'insert_placement':
            // "Instead of it" also hid the element (the spot itself is removed below).
            if (edit.position === 'replace') undoServerHide(el, orig);
            break;
          default:
            break;
        }
      } catch {
        /* the element changed since: leave it */
      }
      const left = tokens.filter((t) => t !== token);
      if (left.length) el.setAttribute(SERVER_APPLIED_ATTR, left.join(' '));
      else el.removeAttribute(SERVER_APPLIED_ATTR);
      delete all[token];
      if (Object.keys(all).length) el.setAttribute(SERVER_ORIG_ATTR, JSON.stringify(all));
      else el.removeAttribute(SERVER_ORIG_ATTR);
    }
    if (edit.operation === 'insert_placement') {
      for (const spot of Array.from(document.querySelectorAll(`div[${SERVER_SPOT_ATTR}][data-joryio-placement]`))) {
        if (spot.getAttribute(SERVER_SPOT_ATTR) === token && spot.getAttribute('data-joryio-placement') === edit.placementKey) spot.remove();
      }
    }
  }

  // ── reporting ────────────────────────────────────────────────────────────

  private reportDisplayed(x: PageEditExperienceWire): void {
    if (!x.deliveryToken || this.runtime.consent() !== 'granted') return;
    const once = `displayed:${x.deliveryId || x.deliveryToken}`;
    if (this.reported.has(once)) return;
    this.reported.add(once);
    this.post({
      campaignId: x.id,
      ...(x.variantId ? { variantId: x.variantId } : {}),
      deliveryToken: x.deliveryToken,
      action: 'displayed',
      displayedAt: new Date().toISOString(),
    });
  }

  private reportControl(x: PageEditExperienceWire): void {
    if (!x.controlToken || this.runtime.consent() !== 'granted') return;
    const once = `control:${x.controlToken}`;
    if (this.reported.has(once)) return;
    this.reported.add(once);
    this.post({ action: 'control_viewed', controlToken: x.controlToken, viewedAt: new Date().toISOString() });
  }

  private post(body: Record<string, any>): void {
    const userId = this.identity.getUserId();
    const full = { ...body, ...(userId ? { userId } : {}), anonymousId: this.identity.getAnonymousId(), sessionId: this.session.getSessionId(), deviceType: 'web' };
    fetch(`${this.apiEndpoint}/v1/in-app/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Key': this.sdkKey,
        ...sdkIdentityHeaders(),
        ...(this.auth?.getSdkAuthHeaders(userId, userId ? null : this.identity.getAnonymousId()) || {}),
      },
      body: JSON.stringify(full),
      keepalive: true,
    })
      .then((r) => {
        if (!r.ok) this.runtime.noteStatus?.(r.status, null);
      })
      .catch((error) => this.logger.debug('Page edit report failed', error));
  }
}
