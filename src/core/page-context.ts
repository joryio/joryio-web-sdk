/**
 * Page context - where the visitor is (BACKLOG D444 Phase 4,
 * docs/PLACEMENTS_WEBSITE_LAYER.md 1).
 *
 * Reports the page to targeting - the URL (origin + path, NEVER the query
 * string or the fragment), the page variables the site set, and the dataLayer
 * keys the site listed (an allow-list: nothing is scraped) - notices
 * single-page-app route changes, and measures the page triggers: exit intent,
 * scroll depth, time on page.
 *
 * The matcher below is the backend's `common/web-experience/page-context.ts`,
 * line for line: the server decides for the requests that name a page, this
 * SDK decides for the overlays /sync hands over. sdk-page-context-parity.spec.ts
 * (backend) pins both to the same wire values.
 */

export const PAGE_URL_OPERATORS = ['equals', 'contains', 'matches'] as const;
/** `query` = a parameter of the CURRENT page's address; its query string goes as `context.search` (page_query). */
export const PAGE_VARIABLE_SOURCES = ['page', 'data_layer', 'utm_session', 'utm_first_touch', 'query'] as const;
/** The UTM fields a `utm_*` rule names; reported as `context.utm.session` / `.firstTouch` (never the query string). */
export const PAGE_UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
export const PAGE_VARIABLE_OPERATORS = ['equals', 'not_equals', 'contains', 'exists', 'not_exists', 'gt', 'lt'] as const;
export const PAGE_TRIGGER_TYPES = ['page_view', 'exit_intent', 'scroll_depth', 'time_on_page'] as const;
export const PAGE_CONTEXT_CAPABILITY = 'page_context';
/** This build sends `context.search` (the page's query string) for `query` (URL parameter) rules. */
export const PAGE_QUERY_CAPABILITY = 'page_query';
/** A longer query string is not sent: `query` rules then fail closed on that page. The server's cap is the same. */
export const PAGE_SEARCH_MAX_LENGTH = 2048;

/** Variables per source this SDK reports; the server reads the same number. */
export const PAGE_CONTEXT_MAX_VARIABLES = 20;
const MAX_VALUE_LENGTH = 200;
const VARIABLE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;

export type PageVariableValue = string | number | boolean;
export type PageTriggerType = (typeof PAGE_TRIGGER_TYPES)[number];

export interface PageUrlRule {
  op: string;
  value: string;
}
export interface PageVariableRule {
  source: string;
  key: string;
  op: string;
  value?: PageVariableValue;
}
export interface PageTargeting {
  urls?: { include?: PageUrlRule[]; exclude?: PageUrlRule[] };
  variables?: PageVariableRule[];
}
export interface PageUtm {
  session?: Record<string, string>;
  firstTouch?: Record<string, string>;
}
export interface PageContext {
  url: string | null;
  pageVariables: Record<string, PageVariableValue>;
  dataLayer: Record<string, PageVariableValue>;
  /** The UTM the SDK recorded (absent when none, or UTM capture is off). */
  utm?: PageUtm;
  /**
   * The current page's query string (`location.search`, read when the
   * context is built - never stored). Sent for URL parameter rules; the
   * server uses it for that evaluation only. Absent when longer than
   * PAGE_SEARCH_MAX_LENGTH.
   */
  search?: string;
  /** `search` parsed (parsePageSearch), for the matcher. Absent = a `query` rule never holds (fail closed). */
  query?: Record<string, string[]>;
}

// ── The matcher (same as the backend) ─────────────────────────────────────────

function normalizePath(path: string): string {
  const p = (path || '/').toLowerCase();
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** `*` = within one segment, `**` = across segments. A glob walk, no RegExp built from the rule. */
export function pathPatternMatches(pattern: string, path: string): boolean {
  const pat = normalizePath(pattern);
  const str = normalizePath(path);
  const tokens: string[] = [];
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') {
      if (pat[i + 1] === '*') {
        tokens.push('**');
        while (pat[i + 1] === '*') i++;
      } else tokens.push('*');
    } else tokens.push(pat[i]);
  }
  let reach: boolean[] = new Array(str.length + 1).fill(false);
  reach[0] = true;
  for (const t of tokens) {
    const next: boolean[] = new Array(str.length + 1).fill(false);
    if (t === '*' || t === '**') {
      for (let j = 0; j <= str.length; j++) {
        if (reach[j]) next[j] = true;
        else if (j > 0 && next[j - 1] && (t === '**' || str[j - 1] !== '/')) next[j] = true;
      }
    } else {
      for (let j = 1; j <= str.length; j++) next[j] = reach[j - 1] && str[j - 1] === t;
    }
    reach = next;
  }
  return reach[str.length];
}

export function pageUrlRuleMatches(rule: PageUrlRule, url: string): boolean {
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(url);
  if (!m) return false;
  const origin = m[1].toLowerCase();
  const path = m[2] || '/';
  let value = String(rule.value ?? '').trim();
  const target = rule.op === 'contains' ? origin + path : path;
  const full = rule.op === 'contains' ? null : /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(value);
  if (full) {
    if (full[1].toLowerCase() !== origin) return false;
    value = full[2] || '/';
  }
  switch (rule.op) {
    case 'equals':
      return normalizePath(value) === normalizePath(target);
    case 'contains':
      return !!value && target.toLowerCase().includes(value.toLowerCase());
    case 'matches':
      return pathPatternMatches(value, target);
    default:
      return false;
  }
}

function valueMatches(op: string, has: boolean, actual: PageVariableValue | undefined, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return has;
    case 'not_exists':
      return !has;
    case 'equals':
      return has && String(actual).toLowerCase() === String(expected ?? '').toLowerCase();
    case 'not_equals':
      return !has || String(actual).toLowerCase() !== String(expected ?? '').toLowerCase();
    case 'contains':
      return has && String(actual).toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'gt':
    case 'lt': {
      const a = Number(actual);
      const b = Number(expected);
      if (!has || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === 'gt' ? a > b : a < b;
    }
    default:
      return false;
  }
}

/** A `query` rule: exact (case-sensitive) name; repeated = any value matches, `not_equals` = none equals. */
function queryRuleMatches(rule: PageVariableRule, ctx: PageContext): boolean {
  if (!ctx.query) return false;
  const has = Object.prototype.hasOwnProperty.call(ctx.query, rule.key);
  const values = has && Array.isArray(ctx.query[rule.key]) ? ctx.query[rule.key] : [];
  if (rule.op === 'exists' || rule.op === 'not_exists') return valueMatches(rule.op, has, undefined, rule.value);
  if (rule.op === 'not_equals') return !values.some((v) => valueMatches('equals', true, v, rule.value));
  return values.some((v) => valueMatches(rule.op, true, v, rule.value));
}

function variableRuleMatches(rule: PageVariableRule, ctx: PageContext): boolean {
  if (rule.source === 'query') return queryRuleMatches(rule, ctx);
  const bag: Record<string, PageVariableValue> | undefined =
    rule.source === 'data_layer'
      ? ctx.dataLayer
      : rule.source === 'page'
        ? ctx.pageVariables
        : rule.source === 'utm_session'
          ? ctx.utm?.session ?? {}
          : rule.source === 'utm_first_touch'
            ? ctx.utm?.firstTouch ?? {}
            : undefined;
  if (!bag) return false; // an unknown source never matches (fail closed)
  const has = Object.prototype.hasOwnProperty.call(bag, rule.key);
  return valueMatches(rule.op, has, has ? bag[rule.key] : undefined, rule.value);
}

export function hasPageTargeting(pt: PageTargeting | null | undefined): boolean {
  return !!pt && (!!pt.urls?.include?.length || !!pt.urls?.exclude?.length || !!pt.variables?.length);
}

/** No rules = every page. Rules and no page = no (fail closed). */
export function pageTargetingMatches(pt: PageTargeting | null | undefined, ctx: PageContext): boolean {
  if (!hasPageTargeting(pt)) return true;
  const include = pt!.urls?.include ?? [];
  const exclude = pt!.urls?.exclude ?? [];
  if (include.length || exclude.length) {
    if (!ctx.url) return false;
    if (include.length && !include.some((r) => pageUrlRuleMatches(r, ctx.url!))) return false;
    if (exclude.some((r) => pageUrlRuleMatches(r, ctx.url!))) return false;
  }
  return (pt!.variables ?? []).every((r) => variableRuleMatches(r, ctx));
}

export const isPageTrigger = (t: { type?: string } | null | undefined): boolean =>
  !!t && (PAGE_TRIGGER_TYPES as readonly string[]).includes(String(t.type));

// ── Reading the page ──────────────────────────────────────────────────────────

/** origin + path of the current page, never the query string or the fragment. */
export function currentPageUrl(): string | null {
  try {
    const loc = typeof window !== 'undefined' ? window.location : undefined;
    return loc && loc.origin && loc.origin !== 'null' ? `${loc.origin}${loc.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * `?a=1&b=2` -> `{ a: ['1'], b: ['2'] }` (URLSearchParams: decoded, `+` is a
 * space), as the server parses `context.search`. Null-prototype, so a
 * parameter named `__proto__` is just a name. Undefined when not a string or
 * over PAGE_SEARCH_MAX_LENGTH.
 */
export function parsePageSearch(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== 'string' || raw.length > PAGE_SEARCH_MAX_LENGTH) return undefined;
  const out: Record<string, string[]> = Object.create(null);
  try {
    new URLSearchParams(raw).forEach((value, name) => {
      (out[name] = out[name] || []).push(value);
    });
  } catch {
    return undefined;
  }
  return out;
}

/** The current page's query string, '' when none, undefined when over the cap or unreadable. */
export function currentPageSearch(): string | undefined {
  try {
    const search = typeof window !== 'undefined' && window.location ? window.location.search || '' : '';
    return search.length <= PAGE_SEARCH_MAX_LENGTH ? search : undefined;
  } catch {
    return undefined;
  }
}

function primitive(v: unknown): PageVariableValue | undefined {
  if (typeof v === 'string') return v.slice(0, MAX_VALUE_LENGTH);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return undefined;
}

/** `a.b.c` inside an object, own properties only. */
function readPath(root: unknown, path: string): unknown {
  let cur: any = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export interface PageContextOptions {
  /** Global variables to report, by name (`pageType`, `shop.page.type`). Nothing else is read. */
  pageVariables?: string[];
  /** dataLayer keys to report (`pageType`, `ecommerce.value`): the latest value pushed for each. Nothing else is read. */
  dataLayerVariables?: string[];
  /** The dataLayer array's global name. Default `dataLayer`. */
  dataLayerName?: string;
}

/**
 * Exit intent on a touch device. There is no pointer to leave through the top
 * of the window, so the signal is a fast scroll UP after reading down the page:
 * the visitor heading back for the address bar or the tab switcher (mobile
 * browsers reveal their toolbar on exactly that gesture).
 *
 * - a touch device: the PRIMARY input has no hover and is coarse,
 *   `(hover: none) and (pointer: coarse)`. A laptop with a touch screen, or a
 *   tablet with a mouse or trackpad attached, reports its primary input as fine
 *   with hover and keeps the desktop rule - a scroll wheel moving up fast there
 *   is reading, not leaving. Read live (a MediaQueryList), never cached.
 * - armed only once the visitor has scrolled down at least `armPercent` of the
 *   page or `armPx` CSS pixels (whichever comes first) in this page view;
 * - fires on a scroll up of at least `upPx` within `windowMs`;
 * - never in the first `minMs` after the page view started (load or route
 *   change), so a page restoring its scroll position or a jump to an anchor
 *   is not an exit;
 * - scroll positions are sampled at most every `sampleMs` (passive listener).
 *
 * Once per page view, like the desktop rule: the same `exitFired` flag, reset
 * by a route change.
 */
export const TOUCH_EXIT_INTENT = {
  armPercent: 25,
  armPx: 400,
  upPx: 120,
  windowMs: 300,
  minMs: 3000,
  sampleMs: 50,
} as const;

const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)';

export type PageSignal = { type: 'page_change'; url: string | null } | { type: 'exit_intent' } | { type: 'scroll_depth'; percent: number } | { type: 'time_on_page'; seconds: number };

/**
 * The page as targeting sees it, and the moments the page triggers wait for.
 * One instance per SDK; `start()` installs the listeners, `destroy()` removes
 * them (and restores history.pushState / replaceState if this instance
 * patched them).
 */
export class PageContextTracker {
  private explicit: Record<string, PageVariableValue> = {};
  private listeners = new Set<(s: PageSignal) => void>();
  private url: string | null = currentPageUrl();
  private maxScrollPercent = 0;
  private visibleMs = 0;
  private visibleSince: number | null = null;
  private exitFired = false;
  /** Touch exit intent: when this page view started, the deepest scrollY, and the recent samples. */
  private pageStartedAt = Date.now();
  private maxScrollY = 0;
  private scrollSamples: Array<{ y: number; t: number }> = [];
  private touchQuery: MediaQueryList | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private undo: Array<() => void> = [];
  private started = false;

  private utmSource: (() => { current?: object | null; firstTouch?: object | null } | null) | null = null;

  constructor(private options: PageContextOptions = {}) {}

  /**
   * Where the UTM comes from: the SDK's UTMManager (`getUTMData()`), set by
   * the SDK when UTM capture is on. Only the five standard fields cross, as
   * `context.utm.session` (this session's) and `.firstTouch` (this browser's
   * first) - never the query string itself.
   */
  setUtmSource(source: typeof this.utmSource): void {
    this.utmSource = source;
  }

  private utm(): PageUtm | undefined {
    let data: ReturnType<NonNullable<typeof this.utmSource>> = null;
    try {
      data = this.utmSource ? this.utmSource() : null;
    } catch {
      return undefined;
    }
    if (!data) return undefined;
    const pick = (o: object | null | undefined): Record<string, string> | undefined => {
      if (!o || typeof o !== 'object') return undefined;
      const raw = o as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const k of PAGE_UTM_KEYS) {
        const v = raw[`utm_${k}`];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, MAX_VALUE_LENGTH);
      }
      return Object.keys(out).length ? out : undefined;
    };
    const session = pick(data.current);
    const firstTouch = pick(data.firstTouch);
    return session || firstTouch ? { ...(session ? { session } : {}), ...(firstTouch ? { firstTouch } : {}) } : undefined;
  }

  /** Replaces the page variables the site set (`null` clears them). Primitives only, 20 at most. */
  setPageVariables(vars: Record<string, unknown> | null): void {
    const out: Record<string, PageVariableValue> = {};
    let n = 0;
    for (const [k, v] of Object.entries(vars || {})) {
      if (n >= PAGE_CONTEXT_MAX_VARIABLES || !VARIABLE_KEY_PATTERN.test(k)) continue;
      const p = primitive(v);
      if (p === undefined) continue;
      out[k] = p;
      n++;
    }
    this.explicit = out;
  }

  current(): PageContext {
    const pageVariables: Record<string, PageVariableValue> = { ...this.explicit };
    const w: any = typeof window !== 'undefined' ? window : {};
    for (const name of (this.options.pageVariables || []).slice(0, PAGE_CONTEXT_MAX_VARIABLES)) {
      if (Object.keys(pageVariables).length >= PAGE_CONTEXT_MAX_VARIABLES) break;
      if (!VARIABLE_KEY_PATTERN.test(name) || name in pageVariables) continue;
      try {
        const p = primitive(readPath(w, name));
        if (p !== undefined) pageVariables[name] = p;
      } catch {
        /* a getter that throws is not our page's problem */
      }
    }
    const dataLayer: Record<string, PageVariableValue> = {};
    const keys = (this.options.dataLayerVariables || []).filter((k) => VARIABLE_KEY_PATTERN.test(k)).slice(0, PAGE_CONTEXT_MAX_VARIABLES);
    if (keys.length) {
      try {
        const dl = w[this.options.dataLayerName || 'dataLayer'];
        if (Array.isArray(dl)) {
          // The latest push that carries a key wins - what the tag manager itself does.
          for (let i = dl.length - 1; i >= 0 && Object.keys(dataLayer).length < keys.length; i--) {
            const entry = dl[i];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            for (const k of keys) {
              if (k in dataLayer) continue;
              const p = primitive(readPath(entry, k));
              if (p !== undefined) dataLayer[k] = p;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    const utm = this.utm();
    const search = currentPageSearch();
    return { url: this.url, pageVariables, dataLayer, ...(utm ? { utm } : {}), ...(search !== undefined ? { search } : {}) };
  }

  /** Scroll depth (max percent reached) and visible seconds on this page so far. */
  progress(): { scrollPercent: number; seconds: number; exitIntent: boolean } {
    const running = this.visibleSince !== null ? Date.now() - this.visibleSince : 0;
    return { scrollPercent: this.maxScrollPercent, seconds: Math.floor((this.visibleMs + running) / 1000), exitIntent: this.exitFired };
  }

  onSignal(cb: (s: PageSignal) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.started || typeof window === 'undefined' || typeof document === 'undefined') return;
    this.started = true;
    this.patchHistory();
    const on = (target: any, ev: string, fn: any, opts?: any) => {
      target.addEventListener(ev, fn, opts);
      this.undo.push(() => target.removeEventListener(ev, fn, opts));
    };
    on(window, 'popstate', () => this.checkRoute());
    this.pageStartedAt = Date.now();
    try {
      this.touchQuery = typeof window.matchMedia === 'function' ? window.matchMedia(TOUCH_PRIMARY_QUERY) : null;
    } catch {
      this.touchQuery = null;
    }
    on(
      window,
      'scroll',
      () => {
        this.measureScroll();
        this.touchExitIntent();
      },
      { passive: true },
    );
    on(document, 'mouseout', (e: MouseEvent) => {
      // Leaving through the top of the window, toward the tabs and the address bar.
      if (this.exitFired || e.relatedTarget || (e as any).toElement) return;
      if (typeof e.clientY === 'number' && e.clientY <= 0) {
        this.exitFired = true;
        this.emit({ type: 'exit_intent' });
      }
    });
    on(document, 'visibilitychange', () => this.visibilityChanged());
    if (document.visibilityState !== 'hidden') this.visibleSince = Date.now();
    this.timer = setInterval(() => {
      const { seconds } = this.progress();
      if (this.visibleSince !== null) this.emit({ type: 'time_on_page', seconds });
      this.checkRoute(); // a router that changes the path without history events
    }, 1000);
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.undo.splice(0).reverse()) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.listeners.clear();
    this.scrollSamples = [];
    this.touchQuery = null;
    this.started = false;
  }

  /** A route change: the page triggers start over. */
  private checkRoute(): void {
    const url = currentPageUrl();
    if (url === this.url) return;
    this.url = url;
    this.maxScrollPercent = 0;
    this.visibleMs = 0;
    this.visibleSince = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? null : Date.now();
    this.exitFired = false;
    this.pageStartedAt = Date.now();
    this.maxScrollY = 0;
    this.scrollSamples = [];
    this.emit({ type: 'page_change', url });
  }

  private patchHistory(): void {
    const h: any = typeof history !== 'undefined' ? history : null;
    if (!h) return;
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = h[name];
      if (typeof original !== 'function') continue;
      const self = this;
      const patched = function (this: unknown, ...args: unknown[]) {
        const r = original.apply(this, args);
        try {
          self.checkRoute();
        } catch {
          /* never break the site's router */
        }
        return r;
      };
      h[name] = patched;
      this.undo.push(() => {
        if (h[name] === patched) h[name] = original;
      });
    }
  }

  private measureScroll(): void {
    try {
      const el = document.documentElement;
      const scrollable = Math.max(el.scrollHeight, document.body?.scrollHeight || 0) - window.innerHeight;
      const percent = scrollable <= 0 ? 100 : Math.min(100, Math.round(((window.scrollY || el.scrollTop) / scrollable) * 100));
      if (percent > this.maxScrollPercent) {
        this.maxScrollPercent = percent;
        this.emit({ type: 'scroll_depth', percent });
      }
    } catch {
      /* ignore */
    }
  }

  /** Exit intent on a touch device: a fast scroll up once the page was read down (TOUCH_EXIT_INTENT). */
  private touchExitIntent(): void {
    if (this.exitFired || !this.touchQuery?.matches) return;
    try {
      const c = TOUCH_EXIT_INTENT;
      const now = Date.now();
      const last = this.scrollSamples[this.scrollSamples.length - 1];
      if (last && now - last.t < c.sampleMs) return;
      const y = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
      if (y > this.maxScrollY) this.maxScrollY = y;
      this.scrollSamples = this.scrollSamples.filter((s) => now - s.t <= c.windowMs);
      this.scrollSamples.push({ y, t: now });
      if (now - this.pageStartedAt < c.minMs) return;
      if (this.maxScrollY < c.armPx && this.maxScrollPercent < c.armPercent) return;
      let peak = y;
      for (const s of this.scrollSamples) if (s.y > peak) peak = s.y;
      if (peak - y >= c.upPx) {
        this.exitFired = true;
        this.scrollSamples = [];
        this.emit({ type: 'exit_intent' });
      }
    } catch {
      /* ignore */
    }
  }

  private visibilityChanged(): void {
    if (document.visibilityState === 'hidden') {
      if (this.visibleSince !== null) this.visibleMs += Date.now() - this.visibleSince;
      this.visibleSince = null;
    } else if (this.visibleSince === null) {
      this.visibleSince = Date.now();
    }
  }

  private emit(s: PageSignal): void {
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(s);
      } catch {
        /* a listener never breaks the others */
      }
    }
  }
}

/** Does this page trigger fire now? `fired` = types already fired for this campaign on this page. */
export function pageTriggerMet(trigger: { type?: string; value?: unknown }, signal: PageSignal, progress: { scrollPercent: number; seconds: number }): boolean {
  const n = Number(trigger.value);
  switch (trigger.type) {
    case 'page_view':
      return signal.type === 'page_change';
    case 'exit_intent':
      return signal.type === 'exit_intent';
    case 'scroll_depth':
      return (signal.type === 'scroll_depth' || signal.type === 'page_change') && Number.isFinite(n) && n > 0 && progress.scrollPercent >= n;
    case 'time_on_page':
      return signal.type === 'time_on_page' && Number.isFinite(n) && n > 0 && progress.seconds >= n;
    default:
      return false;
  }
}
