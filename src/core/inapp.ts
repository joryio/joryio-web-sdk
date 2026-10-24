/**
 * In-App Messaging Manager
 * Handles in-app message campaigns, display, and tracking
 */

import { Logger } from '../utils/logger';
import type { InAppDisplayOptions } from './config';
import { IdentityManager } from './identity';
import { SessionManager } from './session';
import { StorageManager } from './storage';
import { SdkAuthFailureInfo } from './network';

/**
 * The slice of NetworkClient the in-app manager needs to attach the
 * `X-Joryio-Auth` header to its own fetches and to trigger a token refresh
 * on a 401 `sdk_authentication_error`. Kept as a minimal interface so tests
 * can stub it without constructing a full NetworkClient.
 */
export interface InAppAuthProvider {
  /** `subjectUserId`: whose request it is - a logged-out user's carries that user's own token. */
  getSdkAuthHeaders(subjectUserId?: string | null): Record<string, string>;
  isSdkAuthError(status: number, data: any): boolean;
  refreshSdkAuthToken(info: SdkAuthFailureInfo): Promise<string | undefined>;
  /** The signed-in user; the host's auth handler is only asked about THEIR requests (contract item 39). */
  getCurrentUserId?(): string | null;
}

/**
 * How the SDK runs the in-app manager. Everything optional so the manager can
 * be constructed bare in tests.
 */
export interface InAppRuntimeOptions {
  /**
   * False while tracking is opted out, consent is pending or ingestion is
   * suspended: no sync, no impressions - nothing leaves the device.
   */
  canSend?: () => boolean;
  /** Per-request timeout (the `requestTimeout` init option). Default 10 s. */
  requestTimeoutMs?: number;
  /** Periodic re-sync in ms; 0 = off. Clamped by config to >= 30 s. */
  syncIntervalMs?: number;
  /** `session-start-only` disables the attribute-change and periodic re-syncs. */
  evaluationMode?: 'differential-sync' | 'session-start-only';
  /** Report an HTTP status from the manager's own fetches (402 suspends the SDK). */
  noteStatus?: (status: number, data: any) => void;
}

export interface InAppCampaign {
  id: string;
  name: string;
  type: 'modal' | 'banner' | 'slideup' | 'fullscreen' | 'custom';
  priority: number;
  evaluationMode: 'differential-sync' | 'session-start-only';
  frequencyCap?: {
    /** null / absent = UNLIMITED. checkFrequencyCap already reads it that way. */
    maxImpressions?: number | null;
    timeWindow: string;
    minDelayBetweenImpressions?: number;
  };
  variantId?: string;
  variantName?: string;
  /**
   * Opaque handle present when this message was queued by a JOURNEY node rather
   * than a standalone campaign. It MUST be echoed back on every track call: the
   * server resolves it to the canvas/node/execution that queued the message, and
   * that is the ONLY way journey in-app attribution (per-node stats, conversions)
   * is recorded. A client-supplied canvasId is never trusted for this.
   */
  pendingId?: string;
  /**
   * Signed proof that the SERVER served this exact message, to this subject, for
   * this campaign/variant. Issued per delivery in the sync response.
   *
   * MUST be echoed back verbatim on every track call. The server takes tenant,
   * campaign, variant and subject FROM THE TOKEN and ignores the equivalent body
   * fields, and permits each transition (displayed/clicked/dismissed/converted)
   * exactly once per delivery. That is what stops a holder of the publishable SDK
   * key reporting interactions with content that was never served, or replaying
   * one interaction to inflate campaign and A/B metrics.
   *
   * Treat it as opaque — never construct, parse, or reuse one across messages.
   * Absent for an anonymous visitor with no resolvable subject, and for servers
   * predating the token; the backend accepts tokenless calls until
   * IN_APP_REQUIRE_DELIVERY_TOKEN is switched on.
   */
  deliveryToken?: string;
  /** 'journey' when queued by a canvas node; absent for campaign in-apps. */
  source?: string;
  /**
   * What to render. ONE field, discriminated on `kind`.
   *
   * Replaced `template` + `renderedHtml` + `liquidEnabled`. This SDK read
   * `template.html` (which the server sent RAW) and skipped its Liquid pass
   * because the server set `liquidEnabled:false` to mean "already rendered
   * elsewhere" - so personalised messages displayed `{{ user.firstName }}`
   * verbatim on web. Server-rendered HTML is now the only thing sent.
   */
  content?:
    | { kind: 'html'; html: string; css: string; assets?: unknown[] }
    | {
        kind: 'native';
        title?: string;
        body: string;
        imageUrl?: string;
        buttons?: Array<{ id: string; text: string; action: string; url?: string }>;
        closeButton?: boolean;
        backdropDismissible?: boolean;
      };
  targeting?: {
    filterGroups: any[];
  };
  triggers: InAppTrigger[];
  /**
   * Synced as triggers WITHOUT content: ask the server at display time.
   *
   * Set per campaign in the editor. Costs the offline capability for this
   * campaign - with no content held, a trigger firing without a network shows
   * nothing, which is correct: the whole point is not to display something we
   * cannot re-verify.
   */
  reevaluateBeforeDisplay?: boolean;
  watchedAttributes?: string[];
}

export interface InAppTrigger {
  /**
   * Matches the SERVER's union (campaign.entity.ts). `time_delay` used to be
   * listed here and is NOT a type the backend or the campaign editor can
   * produce - a phantom that would have had a handler written for it.
   * `push_notification_tap` is the reverse: real, offered in the editor, and
   * declared by no SDK until now.
   */
  type:
    | 'immediate'
    | 'event'
    | 'attribute_change'
    | 'attribute_threshold'
    | 'push_notification_tap';
  event?: string;
  attribute?: string;
  operator?: string;
  value?: any;
  delay?: number;
}

export interface InAppMessage {
  campaign: InAppCampaign;
  renderedHtml: string;
  displayedAt?: Date;
}

export interface InAppSyncResponse {
  success: boolean;
  campaigns: InAppCampaign[];
  evaluatedAt: string;
  nextEvaluationStrategy?: string;
}

/**
 * What the renderer accepts.
 *
 * EXTENDS the config type rather than re-listing overlapping fields. These were
 * two independent interfaces describing the same thing, and the renderer's copy
 * silently lacked zIndex / backdropColor / closeButtonColor / defaultPosition /
 * defaultAnimation - so those config options resolved with defaults, were
 * dropped on the way in, and could never have had an effect. Extending means a
 * field added to the config surface cannot go missing here again.
 */
export interface DisplayOptions extends InAppDisplayOptions {
  container?: HTMLElement;
  closeButton?: boolean;
  backdropClose?: boolean;
  animationDuration?: number;
  onDisplay?: (message: InAppMessage) => void;
  onClick?: (message: InAppMessage, action: string) => void;
  onDismiss?: (message: InAppMessage, action: string) => void;
  onConversion?: (message: InAppMessage, event: string) => void;
}

/**
 * SDK methods the in-app `joryioBridge` proxies to. Passed in from the SDK so
 * this manager stays decoupled from JoryioSDK. `requestPushPermission` MUST
 * dispatch synchronously (it's called inside the message's click handler — the
 * same-origin iframe preserves the user gesture only if the chain stays sync).
 */
export interface InAppBridge {
  logCustomEvent: (name: string, properties?: Record<string, any>) => void;
  setCustomUserAttribute: (key: string, value: any) => void;
  changeUser: (userId: string) => void;
  requestPushPermission: () => void;
  /** Pre-warm web push (VAPID + SW) when a primer is shown, so the gesture-bound
   *  requestPushPermission() prompts reliably. No-op/never prompts. */
  preparePushPermission?: () => void;
}

/**
 * CSS placed inside a <style> element of an HTML document: `</` becomes
 * `<\/`, so no `</style>` in it can close the element (rule 57). A backslash
 * before `/` is an escape the CSS parser reads as `/`.
 */
export function escapeStyleText(css: string): string {
  return typeof css === 'string' ? css.replace(/<\//g, '<\\/') : '';
}

// Host-window key the in-app iframes call into (same-origin). Internal.
const HOST_BRIDGE_KEY = '__joryioInApp';

// Storage key for persisted per-campaign impression timestamps. Persisting these
// is what makes 'once'/'lifetime'/'session' frequency caps survive page reloads
// (in-memory only would re-fire the message on every load).
const IMPRESSIONS_STORAGE_KEY = 'inapp_impressions';

// Size limits to prevent unbounded memory growth
const MAX_DISPLAYED_MESSAGES = 500;
const MAX_IMPRESSION_TIMESTAMPS = 500;
const MAX_WATCHED_ATTRIBUTES = 200;

/** The shape of a parsed CSS rule this module cares about - a structural
 *  subset of CSSOM, so the rewriting below is testable without a browser. */
interface ScopableRule {
  selectorText?: string;
  style?: { cssText: string };
  conditionText?: string;
  cssRules?: ArrayLike<unknown>;
  cssText?: string;
  type?: number;
}

/**
 * Rewrites parsed CSS rules so each one applies only inside `scope`.
 *
 * Split out from the DOM plumbing on purpose: this is the part with the
 * security consequences, so it is a pure function that can be tested directly.
 */
export function scopeCssRules(rules: ArrayLike<unknown>, scope: string): string {
  const scopeSelector = (selectorText: string): string =>
    selectorText
      .split(',')
      .map((part) => {
        const one = part.trim();
        if (!one) return '';
        // An author writing `body` or `:root` means "this message" - that is
        // the only element they can see. Anything else nests under the scope.
        if (/^(?:html|body|:root)$/i.test(one)) return scope;
        return `${scope} ${one}`;
      })
      .filter(Boolean)
      .join(', ');

  const out: string[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as ScopableRule;
    if (rule.selectorText !== undefined && rule.style) {
      const selector = scopeSelector(rule.selectorText);
      if (selector) out.push(`${selector} { ${rule.style.cssText} }`);
    } else if (rule.cssRules && rule.conditionText !== undefined) {
      // @media / @supports: keep the condition, scope what is inside it.
      const header = (rule.cssText ?? '').slice(0, (rule.cssText ?? '').indexOf('{')).trim();
      const inner = scopeCssRules(rule.cssRules, scope);
      if (header && inner) out.push(`${header} { ${inner} }`);
    } else if (rule.type === 7 && rule.cssText) {
      // Keyframes are referenced by name, not matched by selector, so there is
      // nothing to scope - and dropping them would break any animation the
      // author's scoped rules refer to.
      out.push(rule.cssText);
    }
    // Everything else - notably @import, which would pull an unscopable remote
    // stylesheet onto the customer's page - is dropped on purpose.
  }
  return out.join('\n');
}

/**
 * Black or white, whichever stays legible on `background`.
 *
 * Rec. 709 luma, the weighting the WCAG contrast formula uses. Returns
 * undefined for anything it cannot measure, so the caller keeps the system
 * default rather than guessing.
 */
function readableForeground(background: unknown): string | undefined {
  if (typeof background !== 'string') return undefined;
  const hex = background.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/(.)/g, '$1$1') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return undefined; // named colour, rgb(), gradient - leave it
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#0A1240' : '#FFFFFF';
}

/**
 * A fresh nonce per rendered message.
 *
 * Must be unpredictable and must never repeat across documents: a nonce an
 * attacker can guess, or one reused from an earlier message, is a nonce they
 * can put on their own injected <script> - which is the entire thing this
 * defends against. crypto.getRandomValues where available; the Math.random
 * fallback is for engines so old the CSP would go unenforced anyway.
 */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Which button or link a click was on, sent as `elementId` - the same field
 * name on every SDK (backend /v1/in-app/track, max 128). A generic name
 * ("click", "button", "cta_click") says nothing about WHICH element, so it is
 * not sent; the same list as iOS and Android.
 */
const GENERIC_ELEMENT_NAMES = new Set(['click', 'clicked', 'button', 'link', 'cta_click', 'link_click', 'button_click']);
export function normalizedElementId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || GENERIC_ELEMENT_NAMES.has(trimmed.toLowerCase())) return undefined;
  return trimmed.slice(0, 128);
}

/** Message types that carry their own placement; `displayOptions.defaultPosition` places the rest. */
const BUILT_IN_POSITIONS = new Set(['modal', 'banner', 'slideup', 'fullscreen']);

/**
 * A colour (or other single CSS value) from `displayOptions`, safe to write
 * into a stylesheet: anything that could close the declaration or the rule is
 * refused rather than escaped.
 */
export function cssValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 100 || /[;{}<>\\]/.test(value)) return null;
  return value;
}

export class InAppMessagingManager {
  /** Messages waiting out a display delay, so they can be cancelled. */
  private pendingDelays = new Map<string, ReturnType<typeof setTimeout>>();

  private logger: Logger;
  private identity: IdentityManager;
  private session: SessionManager;
  private storage: StorageManager | null;
  private apiEndpoint: string;
  private sdkKey: string;

  private campaigns: Map<string, InAppCampaign> = new Map();
  private displayedMessages: Map<string, InAppMessage> = new Map();
  private impressionTimestamps: Map<string, number[]> = new Map();
  private watchedAttributes: Set<string> = new Set();
  /** The 5 s local attribute-diff poll. */
  private syncInterval?: number;
  /** The optional periodic server re-sync (`inApp.syncInterval`). */
  private periodicSyncTimer?: ReturnType<typeof setInterval>;
  /** The one-shot retry after a failed sync. */
  private syncRetryTimer?: ReturnType<typeof setTimeout>;
  private runtime: Required<Omit<InAppRuntimeOptions, 'noteStatus'>> & Pick<InAppRuntimeOptions, 'noteStatus'>;
  private displayOptions: DisplayOptions = {};
  private isSyncing = false;
  private syncRetried = false;
  /**
   * Bumped whenever WHO the campaigns are for changes (reset, wipeData,
   * identify, a consent or opt-out change). A sync or resolve that started
   * under an older generation is discarded when it answers: reset() during an
   * in-flight sync used to install the previous user's campaigns for the next
   * one (contract item 26).
   */
  private generation = 0;
  /** A sync was asked for while one was in flight: run one more right after it. */
  private syncAgain = false;
  private syncAgainChanges: Record<string, any> | undefined;
  /**
   * Campaigns claimed for display while the async part of displayCampaign
   * runs (re-check, render). Claimed SYNCHRONOUSLY, so two triggers in one
   * burst cannot both pass the "already shown?" check (contract item 27).
   */
  private claimed = new Set<string>();
  // Per-campaign content iframe (so we can auto-size + clean it up).
  private iframes: Map<string, HTMLIFrameElement> = new Map();

  /**
   * Whether HTML in-app messages are displayed. Off by default. The markup
   * is kept as written by the server, and author scripts in it do NOT run:
   * the frame's per-message nonce CSP (buildSrcdoc) lets only the SDK's own
   * bridge bootstrap execute. But that frame can execute script at the host
   * page's origin, so a gap in the CSP would be XSS - hence opt-in. Native
   * messages are unaffected: they are data rendered as DOM, with no
   * interpreter.
   */
  private allowHtmlJsInAppMessages = false;

  /**
   * What this build can actually render, sent on every session sync.
   *
   * Derived from the live config rather than hardcoded, so it cannot drift from
   * what `undisplayableReason` will decide moments later - the whole value of
   * this field is that the server's picture matches the device's behaviour.
   *
   * `content.native` is unconditional: native messages are DOM this SDK draws
   * itself, with no interpreter and nothing to opt into. `content.html` appears
   * only when the integration opted in, because for everyone else HTML
   * genuinely cannot display - which is precisely what the campaign editor
   * needs to be told before someone publishes into silence.
   */
  private capabilities(): string[] {
    const caps = ['content.native'];
    if (this.allowHtmlJsInAppMessages) caps.push('content.html');
    return caps;
  }

  /**
   * Run a host-app callback. A callback that throws must never stop the SDK's
   * own bookkeeping (the dismissal, the impression, the cleanup) - contract
   * item 34.
   */
  private callHost(name: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.error(`The ${name} callback threw; ignored:`, error);
    }
  }

  /**
   * The audience changed (reset, wipeData, identify, consent): answers to
   * requests made before now are stale. A sync in flight is followed by a
   * fresh one.
   */
  invalidate(): void {
    this.generation++;
    if (this.isSyncing) this.syncAgain = true;
  }

  /** Set from SDK init (allowHtmlJsInAppMessages). */
  setAllowHtmlJsInAppMessages(value: boolean): void {
    this.allowHtmlJsInAppMessages = value;
  }
  private bridge: InAppBridge | null = null;
  private auth: InAppAuthProvider | null = null;

  constructor(
    apiEndpoint: string,
    sdkKey: string,
    identity: IdentityManager,
    session: SessionManager,
    logger: Logger,
    storage?: StorageManager | null,
    options?: DisplayOptions,
    bridge?: InAppBridge,
    auth?: InAppAuthProvider | null,
    runtime?: InAppRuntimeOptions,
  ) {
    this.runtime = {
      canSend: runtime?.canSend || (() => true),
      requestTimeoutMs: runtime?.requestTimeoutMs || 10_000,
      syncIntervalMs: runtime?.syncIntervalMs || 0,
      evaluationMode: runtime?.evaluationMode || 'differential-sync',
      noteStatus: runtime?.noteStatus,
    };
    this.apiEndpoint = apiEndpoint;
    this.sdkKey = sdkKey;
    this.identity = identity;
    this.session = session;
    this.logger = logger;
    this.storage = storage || null;
    this.displayOptions = options || {};
    this.bridge = bridge || null;
    this.auth = auth || null;
    this.loadImpressionTimestamps();
    this.installHostBridge();
  }

  /**
   * Load persisted per-campaign impression timestamps into memory so 'once'/
   * 'lifetime'/'session' frequency caps hold across page reloads and sessions.
   */
  private loadImpressionTimestamps(): void {
    if (!this.storage) return;
    try {
      const stored = this.storage.get<Record<string, number[]>>(IMPRESSIONS_STORAGE_KEY);
      if (stored && typeof stored === 'object') {
        for (const [campaignId, timestamps] of Object.entries(stored)) {
          if (Array.isArray(timestamps)) {
            this.impressionTimestamps.set(campaignId, timestamps.filter((t) => typeof t === 'number'));
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to load persisted impression timestamps:', error);
    }
  }

  /**
   * Persist the current per-campaign impression timestamps to storage.
   */
  private persistImpressionTimestamps(): void {
    if (!this.storage) return;
    try {
      const serialized: Record<string, number[]> = {};
      this.impressionTimestamps.forEach((timestamps, campaignId) => {
        serialized[campaignId] = timestamps;
      });
      this.storage.set(IMPRESSIONS_STORAGE_KEY, serialized);
    } catch (error) {
      this.logger.error('Failed to persist impression timestamps:', error);
    }
  }

  /**
   * Expose the host-side bridge object the message iframes call into. Each
   * method is scoped by campaignId (validated against displayed messages) so a
   * message can only act on itself. Same-origin, synchronous — which is what
   * lets requestPushPermission keep the user-gesture activation. Installed once
   * (idempotent); the in-app HTML reaches it via `window.parent[HOST_BRIDGE_KEY]`.
   */
  private installHostBridge(): void {
    if (typeof window === 'undefined') return;
    // Overwrite unconditionally. The SDK is a singleton, so there's one manager;
    // overwriting (vs skip-if-exists) means a destroy()+re-init rebinds to the
    // LIVE instance instead of leaving a stale bridge that no-ops every call.
    // NOTE: every method GUARDS on displayedMessages.has(campaignId) — a message
    // can only act while it's on screen. The id scopes ANALYTICS attribution only;
    // it unlocks no per-campaign capability (all methods proxy the one SDK
    // singleton), so a cross-campaign id at most mis-attributes a click. Keep this
    // guard on any NEW method too.
    (window as any)[HOST_BRIDGE_KEY] = {
      logCustomEvent: (campaignId: string, name: string, properties?: Record<string, any>) => {
        if (!this.displayedMessages.has(campaignId) || !name) return;
        this.bridge?.logCustomEvent(name, properties);
      },
      setCustomUserAttribute: (campaignId: string, key: string, value: any) => {
        if (!this.displayedMessages.has(campaignId) || !key) return;
        this.bridge?.setCustomUserAttribute(key, value);
      },
      changeUser: (campaignId: string, userId: string) => {
        if (!this.displayedMessages.has(campaignId) || !userId) return;
        this.bridge?.changeUser(userId);
      },
      requestPushPermission: (campaignId: string) => {
        if (!this.displayedMessages.has(campaignId)) return;
        // Synchronous — preserves the click's user activation for the OS prompt.
        this.bridge?.requestPushPermission();
      },
      logConversion: (campaignId: string, event: string) => {
        if (!this.displayedMessages.has(campaignId) || !event) return;
        this.trackConversion(campaignId, event).catch(() => {});
      },
      logClick: (campaignId: string, action?: string) => {
        if (!this.displayedMessages.has(campaignId)) return;
        const elementId = normalizedElementId(action);
        this.trackImpression(campaignId, 'clicked', elementId ? { elementId } : undefined).catch(() => {});
        const message = this.displayedMessages.get(campaignId);
        if (message) this.callHost('onMessageClick', () => this.displayOptions.onClick?.(message, action || 'click'));
      },
      // Navigate a CTA link. The sandboxed iframe can't navigate the top page
      // itself, so the parent does it (within the click's user gesture). Only
      // http(s)/relative URLs — never javascript:/data: etc.
      navigate: (campaignId: string, url: string, target?: string) => {
        if (!this.displayedMessages.has(campaignId) || typeof url !== 'string') return;
        // Absolute http(s) or a single-leading-slash root path (resolved against
        // the TOP origin). Rejects javascript:/data:/mailto:/tel: and protocol-
        // relative `//host` (open-redirect) — those aren't routed here.
        if (!/^(https?:\/\/|\/(?!\/))/i.test(url)) return;
        if (target === '_top' || target === '_self') {
          if (window.top) window.top.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
      },
      closeMessage: (campaignId: string) => {
        if (!this.displayedMessages.has(campaignId)) return;
        this.dismiss(campaignId, 'bridge_close').catch(() => {});
      },
      // A form inside the message (landing pages phase C): the values go to the
      // backend with THIS SDK's identity, so an anonymous visitor's submission
      // lands on their profile once the form names them. Returns the server's
      // answer ({ ok, message | redirect | errors }) to the message's runtime.
      submitForm: (campaignId: string, values: Record<string, unknown>) => {
        if (!this.displayedMessages.has(campaignId) || !values || typeof values !== 'object') return Promise.resolve({ ok: false, message: 'This message is no longer open.' });
        this.trackImpression(campaignId, 'clicked').catch(() => {});
        return this.submitForm(campaignId, values);
      },
      // Size the content iframe from the message's reported dimensions. For
      // content-sized types (modal/slideup) both width + height track the content;
      // banner/fullscreen stay full-width (height tracks content for banner).
      setSize: (campaignId: string, width: number, height: number) => {
        // Guard on the iframe (the thing being sized), set synchronously in
        // display() — not displayedMessages, so a setSize on iframe-load is never
        // rejected by a timing gap.
        const iframe = this.iframes.get(campaignId);
        if (!iframe || !Number.isFinite(height) || height <= 0) return;
        const type = this.displayedMessages.get(campaignId)?.campaign.type;
        iframe.style.height = type === 'fullscreen' ? '100%' : `${Math.ceil(height)}px`;
        if ((type === 'modal' || type === 'slideup') && Number.isFinite(width) && width > 0) {
          iframe.style.width = `${Math.ceil(width)}px`;
        }
      },
    };
  }

  
  /**
   * Initialize in-app messaging
   */
  async initialize(): Promise<void> {
    if (!this.runtime.canSend()) return;
    this.logger.info('Initializing in-app messaging');

    // Idempotent: a second initialize() (consent granted again, identify,
    // reset) used to start a SECOND attribute-watch interval on top of the
    // first. Stop whatever is running before starting it again.
    this.stop();

    // Sync eligible campaigns. A failure is retried once by sync() itself and
    // must not stop the watchers from starting.
    await this.sync().catch((error) => {
      this.logger.error('Initial in-app sync failed:', error);
    });

    // Start watching for attribute changes (if differential-sync campaigns exist)
    this.startAttributeWatching();
    this.startPeriodicSync();
  }

  /**
   * Stop every timer this manager owns - the attribute poll, the periodic
   * re-sync, the failed-sync retry, and display delays not yet elapsed - while
   * keeping the campaigns already synced. Used when tracking is switched off
   * (opt-out, consent withdrawn) and by clearAll()/destroy().
   */
  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = undefined;
    }
    if (this.syncRetryTimer) {
      clearTimeout(this.syncRetryTimer);
      this.syncRetryTimer = undefined;
    }
    this.syncRetried = false;
    this.pendingDelays.forEach((timer) => clearTimeout(timer));
    this.pendingDelays.clear();
  }

  /**
   * `inApp.syncInterval`: ask the server again every N ms, so a campaign
   * published while the visitor sits on one page still reaches them. Off by
   * default, skipped while the tab is hidden, and never in
   * `session-start-only` mode.
   */
  private startPeriodicSync(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = undefined;
    }
    if (this.runtime.evaluationMode !== 'differential-sync' || !(this.runtime.syncIntervalMs > 0)) return;
    this.periodicSyncTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.runtime.canSend()) return;
      this.sync().catch((error) => this.logger.debug('Periodic in-app sync failed:', error));
    }, this.runtime.syncIntervalMs);
  }

  /**
   * Who this device is, for every in-app request: `userId` only once
   * identified, `anonymousId` always.
   *
   * Never an email as `externalId`. The old code sent
   * `externalId = attributes.externalId || attributes.email || ...`; the server
   * looks a contact up by EXACT externalId, so the moment a site called
   * setAttributes({ email }) every sync matched nobody and returned no
   * campaigns, and every impression was dropped.
   */
  private subject(): { userId?: string; anonymousId: string } {
    const userId = this.identity.getUserId();
    return { ...(userId ? { userId } : {}), anonymousId: this.identity.getAnonymousId() };
  }

  /**
   * If a raw in-app fetch was rejected with a 401 `sdk_authentication_error`,
   * fire the host refresh callback so the NEXT sync/track carries a fresh token.
   * In-app requests are polled/best-effort, so we deliberately do NOT inline-retry
   * here — the refreshed token flows through on the following call.
   */
  private async maybeHandleSdkAuthError(response: Response, endpoint: string, subjectUserId: string | null): Promise<void> {
    if (!this.auth || response.status !== 401) {
      return;
    }
    // A request of a user who has since logged out (a dismissal tracked
    // during reset(), say) must never make the host sign out the person now
    // using the app (contract item 39).
    const current = this.auth.getCurrentUserId ? this.auth.getCurrentUserId() : this.identity.getUserId();
    if ((subjectUserId || null) !== (current || null)) return;
    let data: any = null;
    try {
      data = await response.clone().json();
    } catch {
      return;
    }
    if (!this.auth.isSdkAuthError(response.status, data)) {
      return;
    }
    this.logger.warn(`In-app request rejected by SDK authentication (${data?.reason || 'invalid'}) on ${endpoint} – refreshing token`);
    try {
      await this.auth.refreshSdkAuthToken({
        reason: data?.reason || 'invalid',
        endpoint,
        userId: subjectUserId,
      });
    } catch (err) {
      this.logger.error('Failed to refresh SDK authentication token for in-app request:', err);
    }
  }

  /**
   * Sync eligible campaigns from server
   */
  async sync(attributeChanges?: Record<string, any>): Promise<InAppSyncResponse> {
    if (!this.runtime.canSend()) {
      return { success: false, campaigns: [], evaluatedAt: new Date().toISOString() };
    }
    if (this.isSyncing) {
      // Not dropped: the in-flight answer may already be out of date (an
      // identify, a reset), so one more sync runs right after it.
      this.syncAgain = true;
      if (attributeChanges) this.syncAgainChanges = { ...(this.syncAgainChanges || {}), ...attributeChanges };
      return { success: false, campaigns: [], evaluatedAt: new Date().toISOString() };
    }

    this.isSyncing = true;
    const generation = this.generation;
    this.logger.debug('Syncing in-app campaigns');

    const sessionId = this.session.getSessionId();
    const userAttributes = this.identity.getAttributes();

    const controller = new AbortController();
    const timeoutMs = this.runtime.requestTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const subjectUser = this.identity.getUserId();
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/in-app/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...(this.auth?.getSdkAuthHeaders(subjectUser) || {}),
        },
        body: JSON.stringify({
          ...this.subject(),
          sessionId,
          userAttributes: attributeChanges || userAttributes,
          // Only what the server has not acknowledged. Its PRESENCE (even
          // empty) tells the backend this SDK has a durable attribute queue,
          // so the stored profile is authoritative and only these few keys may
          // override it - a device's cache must not out-vote the database.
          pendingAttributes: this.identity.pending.pending(this.identity.getAnonymousId()),
          deviceType: 'web',
          locale: navigator.language,
          capabilities: this.capabilities(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.runtime.noteStatus?.(response.status, null);
        // On a 401 SDK-auth error, trigger a token refresh so the NEXT sync
        // carries a valid token (in-app sync is polled, so no inline retry).
        await this.maybeHandleSdkAuthError(response, `${this.apiEndpoint}/v1/in-app/sync`, subjectUser);
        throw new Error(`Sync failed: ${response.status} ${response.statusText}`);
      }

      const data: InAppSyncResponse = await response.json();
      if (generation !== this.generation) {
        // Asked for someone who is no longer this visitor (reset, identify,
        // consent change meanwhile): discarded; the follow-up sync asks again.
        this.logger.debug('Discarding an in-app sync answer that predates an identity or consent change');
        this.syncAgain = true;
        return { success: false, campaigns: [], evaluatedAt: new Date().toISOString() };
      }
      if (!data || data.success === false || !Array.isArray(data.campaigns)) {
        // A 2xx that did not do what was asked (contract addendum 15).
        throw new Error('Sync failed: the server reported success: false');
      }
      this.syncRetried = false;

      // Update campaigns cache
      this.campaigns.clear();
      for (const campaign of data.campaigns) {
        this.campaigns.set(campaign.id, campaign);

        // Track watched attributes for differential sync
        if (campaign.evaluationMode === 'differential-sync' && campaign.watchedAttributes) {
          campaign.watchedAttributes.forEach((attr) => this.boundedSetAdd(this.watchedAttributes, attr, MAX_WATCHED_ATTRIBUTES));
        }
      }

      this.logger.info(`Synced ${data.campaigns.length} eligible campaigns`);

      // Process immediate triggers
      this.processImmediateTriggers();

      return data;
    } catch (error) {
      const timedOut = (error as any)?.name === 'AbortError';
      this.logger.error(timedOut ? `Campaign sync timed out after ${timeoutMs}ms` : 'Failed to sync campaigns:', error);

      // Retry ONCE after 5 seconds on failure. The handle is kept so stop() /
      // reset() / destroy() can cancel it - it used to outlive all three.
      //
      // `syncRetried` is cleared by a SUCCESSFUL sync (or stop()), never by
      // the retry itself: the timer used to reset it before retrying, so a
      // persistently failing API was asked again every 5 seconds for as long
      // as the page stayed open.
      if (generation === this.generation && !this.syncRetried && this.runtime.canSend()) {
        this.syncRetried = true;
        this.syncRetryTimer = setTimeout(() => {
          this.syncRetryTimer = undefined;
          this.sync().catch(() => {});
        }, 5000);
      }

      throw timedOut ? new Error('Campaign sync timed out') : error;
    } finally {
      clearTimeout(timeoutId);
      this.isSyncing = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        const changes = this.syncAgainChanges;
        this.syncAgainChanges = undefined;
        if (this.runtime.canSend()) {
          // A full sync when the audience changed, a differential one otherwise.
          this.sync(generation !== this.generation ? undefined : changes).catch((error) =>
            this.logger.debug('Follow-up in-app sync failed:', error));
        }
      }
    }
  }

  /**
   * Process campaigns with immediate triggers
   */
  private processImmediateTriggers(): void {
    for (const campaign of this.campaigns.values()) {
      const triggers = campaign.triggers || [];
      const hasImmediateTrigger = triggers.some((t) => t.type === 'immediate');
      if (hasImmediateTrigger) {
        this.displayCampaign(campaign).catch((error) =>
          this.logger.error('In-app display failed:', error));
      }
    }
  }

  /**
   * An event just happened in the app - show anything waiting on it.
   *
   * The server sends five trigger types and, until now, `event` was evaluated
   * by NOBODY. A campaign set to "show when the user does add_to_cart" waited
   * for the event to upload and the next sync to decide, so it appeared on the
   * user's next visit rather than at the moment they did the thing.
   *
   * Everything needed was already on the device: the sync response carries the
   * triggers and the content. Only the wire from track() was missing.
   *
   * NO eligibility re-check here. The server sent this campaign because the
   * user matched it; re-deciding on the device can only subtract, using data
   * the device does not have - which is exactly how Android came to suppress
   * every segment-targeted campaign. The device evaluates only what the server
   * cannot know: did this event just fire, and does it match the trigger's own
   * property filter.
   */
  onEventTracked(eventName: string, properties?: Record<string, any>): void {
    if (!eventName) return;
    for (const campaign of this.campaigns.values()) {
      const match = (campaign.triggers || []).find(
        (t) => t.type === 'event' && t.event === eventName && this.triggerFilterMatches(t, properties),
      );
      if (match) {
        this.displayCampaign(campaign).catch((error) =>
          this.logger.error('In-app display failed:', error));
        // One per event: a single action should not stack modals.
        return;
      }
    }
  }

  /**
   * A trigger's own property condition, e.g. "add_to_cart where value > 100".
   *
   * A trigger with no condition matches on the event name alone. An UNKNOWN
   * operator does NOT match - failing closed, because showing the wrong people
   * a message is worse than showing nobody, and a silent match would make a
   * typo look like it worked.
   */
  private triggerFilterMatches(trigger: InAppTrigger, properties?: Record<string, any>): boolean {
    if (!trigger.attribute) return true;
    const actual = properties?.[trigger.attribute];
    const expected = trigger.value;
    switch (trigger.operator) {
      case undefined:
      case 'equals':
      case 'eq':
        return actual === expected;
      case 'not_equals':
      case 'neq':
        return actual !== expected;
      case 'greater_than':
      case 'gt':
        return Number(actual) > Number(expected);
      case 'less_than':
      case 'lt':
        return Number(actual) < Number(expected);
      case 'contains':
        return String(actual ?? '').includes(String(expected));
      case 'exists':
        return actual !== undefined && actual !== null;
      default:
        return false;
    }
  }

  /**
   * Fetch a re-check campaign's content, re-verifying eligibility server-side.
   *
   * Returns null when the user is no longer eligible OR the request fails.
   * Both mean "show nothing": a campaign in this mode is one the marketer
   * said must not display on stale information, so falling back to anything
   * cached would defeat the setting they chose.
   */
  private async resolveForDisplay(campaign: InAppCampaign): Promise<InAppCampaign | null> {
    if (!this.runtime.canSend()) return null;
    const generation = this.generation;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.runtime.requestTimeoutMs);
    try {
      const res = await fetch(`${this.apiEndpoint}/v1/in-app/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...(this.auth?.getSdkAuthHeaders(this.identity.getUserId()) || {}),
        },
        body: JSON.stringify({
          ...this.subject(),
          campaignId: campaign.id,
          sessionId: this.session.getSessionId(),
          userAttributes: this.identity.getAttributes(),
          pendingAttributes: this.identity.pending.pending(this.identity.getAnonymousId()),
          deviceType: 'web',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.runtime.noteStatus?.(res.status, null);
        return null;
      }
      const data = await res.json();
      // Answered for a visitor who is no longer this one: show nothing.
      if (generation !== this.generation) return null;
      return data?.eligible && data.campaign ? (data.campaign as InAppCampaign) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Display a campaign
   */
  /**
   * Whether the browser can still be prompted for web push — i.e. the Notification
   * permission is 'default' and the API exists. Used to gate push primers: there's
   * no point showing an "Enable notifications" message once permission is granted
   * (already subscribed) or denied (the browser won't re-prompt).
   */
  private canPromptForPush(): boolean {
    try {
      return typeof Notification !== 'undefined' && Notification.permission === 'default';
    } catch {
      return false;
    }
  }

  async displayCampaign(campaign: InAppCampaign): Promise<void> {
    // Claimed BEFORE the first await (contract item 27). The "already shown?"
    // check used to sit after the re-check and render awaits, so two triggers
    // in one burst (an event fired twice, a re-sync's immediate trigger) both
    // passed it and the message appeared - and was counted - twice.
    const id = campaign.id;
    if (this.claimed.has(id) || this.displayedMessages.has(id) || this.pendingDelays.has(id)) {
      this.logger.debug(`Campaign ${id} already displayed, scheduled or being prepared`);
      return;
    }
    this.claimed.add(id);
    const generation = this.generation;
    try {
      // Re-check mode: this campaign arrived WITHOUT content. Ask the server,
      // which re-verifies eligibility and renders personalization now. Nothing
      // displays if that fails - the marketer chose this mode precisely so the
      // message never shows on stale information.
      if (campaign.reevaluateBeforeDisplay) {
        const resolved = await this.resolveForDisplay(campaign);
        if (!resolved) {
          this.logger.info(`Campaign ${campaign.id} not displayed: re-check said no`);
          return;
        }
        // Continue with the SERVER's version - freshly rendered, freshly checked.
        campaign = resolved;
      }

      // Check if already displayed - or already scheduled. A campaign waiting
      // out its display delay is not in displayedMessages yet, so a second
      // trigger (a re-sync's immediate trigger, a repeated event) scheduled a
      // second timer and the message appeared twice.
      if (this.displayedMessages.has(campaign.id) || this.pendingDelays.has(campaign.id)) {
        this.logger.debug(`Campaign ${campaign.id} already displayed or scheduled`);
        return;
      }

      // Check frequency cap
      if (!this.checkFrequencyCap(campaign)) {
        this.logger.debug(`Campaign ${campaign.id} blocked by frequency cap`);
        return;
      }

      // Render template
      const renderedHtml = await this.renderTemplate(campaign);

      // The visitor changed while this was being prepared (reset, identify,
      // consent): it was the previous audience's message.
      if (generation !== this.generation || !this.runtime.canSend()) {
        this.logger.debug(`Campaign ${campaign.id} not displayed: the visitor or consent changed meanwhile`);
        return;
      }

      /**
       * Nothing will appear → do not claim anything did.
       *
       * Everything that can stop this campaign reaching the screen is decided
       * HERE, before commitDisplay(), because commitDisplay is the point of no
       * return: it consumes the frequency cap (so the campaign is 'seen' and a
       * later, valid payload is suppressed) and reports an `in_app.displayed`
       * impression. A refusal that happens after it makes a delivery failure look
       * like a successful delivery in reporting, so nobody goes looking.
       * Analytics that quietly counts non-events is worse than analytics that
       * counts nothing.
       *
       * This gate used to be `if (!renderedHtml.trim())`, which is the WORKAROUND
       * for the property, not the property - and both of its errors shipped:
       *
       *  - A native campaign has no HTML by construction, so it was
       *    indistinguishable from a broken payload and returned here. The native
       *    branch in display() was therefore unreachable: native in-app messages
       *    never displayed on web at all.
       *  - An HTML campaign in an integration that has not set
       *    allowHtmlJsInAppMessages renders fine and is refused later, inside
       *    display() - i.e. AFTER the cap was burned and the impression tracked.
       *    QA saw exactly that: displayed:true, markerInDom:false.
       *
       * So the question asked is the real one: can this campaign appear?
       * Returning WITHOUT recording anything leaves it eligible, so a corrected
       * payload - or an integration that later opts in - displays normally on the
       * next evaluation instead of being permanently capped out.
       */
      const blocked = this.undisplayableReason(campaign, renderedHtml);
      if (blocked) {
        this.logger.warn(
          `Campaign ${campaign.id} not displayed (${blocked}). No impression ` +
            'recorded and no frequency cap consumed, so it stays eligible.',
        );
        return;
      }

      // A push primer (a message whose CTA requests notification permission) is only
      // useful while the browser can still prompt — i.e. Notification.permission is
      // 'default'. If the visitor already granted (they're subscribed) or denied
      // (the browser won't re-prompt), or push isn't supported, the message is a
      // dead-end, so suppress it — don't nag a subscribed user with "Enable
      // notifications" on every load. Skipped WITHOUT recording an impression so it
      // re-evaluates cleanly if the permission state later changes.
      if (renderedHtml.includes('requestPushPermission') && !this.canPromptForPush()) {
        this.logger.debug(
          `Campaign ${campaign.id} is a push primer but the browser can't be prompted ` +
            `(permission not 'default'); suppressing.`,
        );
        return;
      }

      const message: InAppMessage = {
        campaign,
        renderedHtml,
        displayedAt: new Date(),
      };

      /**
       * Everything that means "this was shown", in one place.
       *
       * Registering the message BEFORE the async impression-track is deliberate:
       * the content iframe's bootstrap calls back (setSize/logClick/...) on load,
       * which fires before a network trackImpression resolves, and the
       * host-bridge guards key off displayedMessages - so registering after would
       * leave the iframe rejected and stuck at height:0.
       *
       * All of it happens at DISPLAY time, including the frequency-cap
       * timestamp. Recording the cap when the message was merely SCHEDULED burns
       * an impression on a message the user never saw - which is precisely the
       * bug fixed on iOS earlier (an impression tracked before a render that then
       * failed), and my delay had just reintroduced it here.
       */
      const commitDisplay = () => {
        this.boundedMapSet(this.displayedMessages, campaign.id, message, MAX_DISPLAYED_MESSAGES);
        const timestamps = this.impressionTimestamps.get(campaign.id) || [];
        timestamps.push(Date.now());
        this.boundedMapSet(this.impressionTimestamps, campaign.id, timestamps, MAX_IMPRESSION_TIMESTAMPS);
        // Persist so 'once'/'lifetime'/'session' caps survive reloads and sessions.
        this.persistImpressionTimestamps();
        this.display(message);
      };

      // Display delay: the campaign's `delay` is SECONDS to wait after the
      // trigger fires before showing. The server never used to send it, so this
      // was silently always 0 - a marketer's "wait 30 seconds" did nothing.
      const delayMs = Math.max(0, Number((campaign as any).delay) || 0) * 1000;

      if (delayMs > 0) {
        const timer = setTimeout(() => {
          this.pendingDelays.delete(campaign.id);
          // Tied to WHO and WHETHER (contract item 43): an identify of another
          // user (even without reset()), an opt-out or a consent change while
          // the delay ran bumps the generation, and the message was the
          // previous audience's - or may no longer be shown at all.
          if (generation !== this.generation || !this.runtime.canSend()) {
            this.logger.debug(`Campaign ${campaign.id} not displayed after its delay: the visitor or consent changed`);
            return;
          }
          // Re-checked at display time: the cap may have been spent meanwhile
          // (manual displayInAppCampaign, another tab's impression after a reload).
          if (this.displayedMessages.has(campaign.id) || !this.checkFrequencyCap(campaign)) return;
          commitDisplay();
          this.trackImpression(campaign.id, 'displayed').catch(() => undefined);
        }, delayMs);
        // Tracked so dismiss()/clear() can cancel a message that has not appeared
        // yet, instead of it popping up after the user navigated away.
        this.pendingDelays.set(campaign.id, timer);
        return;
      }

      commitDisplay();

      // Track impression (fire-and-forget analytics; the message is already shown)
      await this.trackImpression(campaign.id, 'displayed');
    } finally {
      this.claimed.delete(id);
    }
  }

  /**
   * The HTML to display.
   *
   * No Liquid pass: the server resolves personalisation before sending and
   * withholds a campaign whose tags did not resolve. Rendering here as well
   * was how web and mobile ended up showing different content for the same
   * campaign - and how web showed raw `{{ }}` tags whenever the server HAD
   * rendered (it set liquidEnabled:false, which this read as "no Liquid here").
   *
   * The client-side Liquid engine is gone entirely - it had no other caller,
   * and removing it drops the liquidjs dependency from a bundle that ships on
   * customer sites. It also removes one source of per-channel filter drift:
   * there is now exactly one Liquid implementation, server-side.
   */
  private async renderTemplate(campaign: InAppCampaign): Promise<string> {
    const content = campaign.content;
    if (!content || content.kind !== 'html') {
      // Not an error: a native campaign has no HTML by design and is rendered
      // as DOM by display(). Only `undisplayableReason` decides what is wrong.
      return '';
    }
    return content.html;
  }

  /**
   * Why this campaign cannot appear on screen, or null if it can.
   *
   * ONE predicate, so the pre-commit gate in displayCampaign() and the refusal
   * inside display() cannot drift apart. They did: display() refused HTML when
   * allowHtmlJsInAppMessages was false, but the gate before it only checked
   * for empty HTML - so that refusal ran after the cap and impression were
   * already committed.
   */
  private undisplayableReason(campaign: InAppCampaign, renderedHtml: string): string | null {
    const kind = campaign.content?.kind;

    if (!campaign.content) return 'the payload carries no `content`';

    // Rendered as DOM by this SDK's own views - no interpreter, no opt-in
    // needed, and no HTML expected.
    if (kind === 'native') return null;

    if (kind === 'html') {
      if (!renderedHtml.trim()) return 'its `content.html` is empty';
      // A SKIP, not a failure: HTML is shown in a frame that can execute script
      // at the host page's origin (only the SDK bridge, under the nonce CSP),
      // so an integration that has not opted in never creates the iframe.
      if (!this.allowHtmlJsInAppMessages) {
        return 'it is an HTML message and allowHtmlJsInAppMessages is false';
      }
      return null;
    }

    return `this SDK cannot render content kind '${String(kind)}'`;
  }

  
  
  /**
   * Display message in DOM
   */
  private display(message: InAppMessage): void {
    const { campaign, renderedHtml } = message;

    // Create container
    const container = document.createElement('div');
    container.id = `joryio-inapp-${campaign.id}`;
    // `displayOptions` (inApp.displayOptions). All five used to be resolved
    // and then ignored by this renderer, so setting them did nothing:
    //  - defaultPosition: where a message whose type has no placement of its
    //    own (`custom`) sits - modal/banner/slideup/fullscreen keep theirs;
    //  - defaultAnimation: how every message enters (fade, slide or none);
    //  - backdropColor / closeButtonColor / zIndex: as named.
    const position = BUILT_IN_POSITIONS.has(campaign.type)
      ? null
      : (['top', 'center', 'bottom'] as const).find((p) => p === this.displayOptions.defaultPosition) || 'center';
    const animation = (['fade', 'slide', 'none'] as const).find((a) => a === this.displayOptions.defaultAnimation) || 'fade';
    container.className =
      `joryio-inapp joryio-inapp-${campaign.type}` +
      (position ? ` joryio-inapp-pos-${position}` : '') +
      (animation !== 'none' ? ` joryio-inapp-anim-${animation}` : '');

    // Create style element (with id for cleanup on dismiss)
    const style = document.createElement('style');
    style.id = `joryio-style-${campaign.id}`;
    // Configurable, because 999999 is not always enough: a site whose own header
    // or cookie banner sits higher would render the message behind it, and the
    // option to fix that existed in config while being ignored here.
    const zIndex = Number.isFinite(this.displayOptions.zIndex) ? Number(this.displayOptions.zIndex) : 999999;
    const backdropColor = cssValue(this.displayOptions.backdropColor) || 'rgba(0, 0, 0, 0.5)';
    const closeButtonColor = cssValue(this.displayOptions.closeButtonColor) || 'inherit';
    style.textContent = `
      .joryio-inapp {
        position: fixed;
        z-index: ${zIndex};
      }

      /* displayOptions.defaultPosition - only for types with no placement of their own. */
      .joryio-inapp-pos-top {
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 90%;
      }
      .joryio-inapp-pos-center {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        max-width: 90%;
        max-height: 90%;
      }
      .joryio-inapp-pos-bottom {
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 90%;
      }

      /* displayOptions.defaultAnimation. The individual \`translate\` property
         composes with the positioning \`transform\` above instead of
         replacing it. Motion is skipped for visitors who asked for less. */
      @keyframes joryio-inapp-fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes joryio-inapp-slide-in { from { opacity: 0; translate: 0 16px; } to { opacity: 1; translate: 0 0; } }
      .joryio-inapp-anim-fade { animation: joryio-inapp-fade-in 200ms ease-out both; }
      .joryio-inapp-anim-slide { animation: joryio-inapp-slide-in 240ms ease-out both; }
      @media (prefers-reduced-motion: reduce) {
        .joryio-inapp-anim-fade, .joryio-inapp-anim-slide { animation: none; }
      }

      /* The message content lives in a sandboxed iframe; its own CSS stays
         inside it (no leak to/from the host page). Only SDK chrome is here. */
      .joryio-inapp > iframe {
        border: 0;
        width: 100%;
        display: block;
        background: transparent;
        color-scheme: normal;
      }

      .joryio-inapp-modal {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        max-width: 90%;
        max-height: 90%;
      }

      .joryio-inapp-banner {
        top: 0;
        left: 0;
        right: 0;
      }

      .joryio-inapp-slideup {
        bottom: 20px;
        right: 20px;
        max-width: 400px;
      }

      .joryio-inapp-fullscreen {
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
      }

      /* Native card. Deliberately minimal and system-font: the host page's
         typography is the closest thing the web has to "the app's look", and
         a shipped palette would clash with every site.

         Every author-settable value comes through a CUSTOM PROPERTY with the
         system default as its fallback. That is what lets the campaign's own
         CSS override the colour pickers: inline styles beat a stylesheet, so
         setting the pickers inline would have made "advanced" strictly weaker
         than "basic" - the opposite of what an escape hatch is for. */
      .joryio-inapp-native {
        /* Positioning context for the close button, which sits in the card's
           top trailing corner rather than in the content flow. */
        position: relative;
        background: var(--joryio-inapp-bg, Canvas);
        color: var(--joryio-inapp-fg, CanvasText);
        color-scheme: light dark;
        border-radius: var(--joryio-inapp-radius, 14px);
        padding: 20px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.18);
        font: menu;
        font-family: var(--joryio-inapp-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
        /* Direction-relative, so a Hebrew or Arabic message reads from the
           right without the campaign having to know which way it runs. The
           card carries dir=auto, so 'start' resolves per message. */
        text-align: var(--joryio-inapp-align, start);
        max-width: 420px;
      }
      .joryio-inapp-fullscreen .joryio-inapp-native {
        border-radius: 0;
        max-width: none;
        height: 100%;
      }
      .joryio-inapp-native img {
        width: 100%;
        height: 140px;
        object-fit: cover;
        border-radius: 8px;
        display: block;
        margin-bottom: 14px;
      }
      .joryio-inapp-native h2 {
        margin: 0 0 8px;
        /* Room for the close button in the trailing corner. Logical, so in a
           Hebrew message the gap is on the left, where the button is. */
        padding-inline-end: 28px;
        /* Derived from the body size so one control keeps the hierarchy. */
        font-size: calc(var(--joryio-inapp-size, 14.5px) * 1.3);
        font-weight: var(--joryio-inapp-title-weight, 700);
        line-height: 1.3;
      }
      .joryio-inapp-native p {
        margin: 0 0 16px;
        font-size: var(--joryio-inapp-size, 14.5px);
        line-height: 1.5;
        opacity: 0.85;
      }
      .joryio-inapp-buttons {
        display: flex;
        gap: 8px;
      }
      .joryio-inapp-buttons.stacked {
        flex-direction: column;
      }
      .joryio-inapp-native button {
        flex: 1;
        min-height: 44px;
        border-radius: 8px;
        font: inherit;
        font-size: 14px;
        cursor: pointer;
        border: 1px solid transparent;
      }
      .joryio-inapp-native button.primary {
        background: var(--joryio-inapp-primary, AccentColor);
        color: var(--joryio-inapp-primary-fg, AccentColorText);
      }
      .joryio-inapp-native button.secondary {
        background: transparent;
        color: inherit;
        border-color: rgba(128,128,128,0.4);
      }
      /*
       * Native messages used to override the shared close button into a
       * full-width "Close" text row under the buttons, while HTML messages in
       * this same SDK drew an ✕ in the corner. One SDK, two dismiss designs -
       * and the text row also hardcoded the English word "Close", which is
       * wrong in a Hebrew or Arabic app. The ✕ needs no translation, so native
       * now uses the shared button and this override is gone.
       */

      .joryio-inapp-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: ${backdropColor};
        z-index: ${zIndex - 1};
      }

      .joryio-inapp-close {
        position: absolute;
        top: 6px;
        /* inset-inline-end, not right: the card carries dir=auto, so a Hebrew
           or Arabic message puts the ✕ in ITS trailing corner - the left one -
           without the campaign having to know which way the text runs. */
        inset-inline-end: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        /* 32px is the tap target; the glyph inside is smaller. Anything less
           is hard to hit on a phone, and it is the only way out of a
           full-screen message. */
        width: 32px;
        height: 32px;
        padding: 0;
        cursor: pointer;
        background: transparent;
        border: none;
        border-radius: 50%;
        font: inherit;
        font-size: 22px;
        line-height: 1;
        opacity: 0.55;
        color: ${closeButtonColor};
      }
      .joryio-inapp-close:hover,
      .joryio-inapp-close:focus-visible {
        opacity: 1;
      }
    `;

    // Render the message HTML inside a SAME-ORIGIN SANDBOXED iframe. The sandbox
    // (allow-scripts allow-same-origin) is the isolation/encapsulation boundary
    // — message CSS can't leak to the host and host CSS can't bleed in — and it
    // lets the SDK's bridge bootstrap run AND reach `joryioBridge`. Same-origin
    // is required so `joryioBridge.requestPushPermission()` keeps the click's
    // user-gesture activation (a cross-origin postMessage hop would lose it).
    // Author scripts and on* handlers do NOT run: the server keeps the markup
    // as written (sanitizeInAppHtml drops only <base> and meta refresh), and
    // the srcdoc's nonce CSP (buildSrcdoc) is what stops them. The sandbox and
    // the navigation rules contain the rest; there is no server sanitiser in
    // front of this.
    const iframe = document.createElement('iframe');
    iframe.id = `joryio-iframe-${campaign.id}`;
    // ── Native content: build DOM directly, no iframe ───────────────────────
    //
    // The iframe exists to contain UNTRUSTED MARKUP - authored HTML with its
    // own scripts and styles. Native content is data: strings, a URL and an
    // action enum. There is nothing to sandbox, so wrapping it in an iframe
    // would add the srcdoc round-trip, the height-reporting shim and the bridge
    // hop for no benefit.
    //
    // Everything below uses textContent, never innerHTML. The server does not
    // HTML-escape native fields (escaping would show the user `A &amp; B`), so
    // innerHTML here would reintroduce exactly the injection native avoids.
    // Hand-written CSS from the campaign's advanced section, picked up in the
    // native branch below and injected (scoped) once the container exists.
    let authorCss: string | undefined;

    if (campaign.content?.kind === 'native') {
      const native = campaign.content;
      const card = document.createElement('div');
      card.className = 'joryio-inapp-native';
      // `auto` resolves direction from the message's OWN first strong
      // character, per message. Not the page's dir and not the app's locale:
      // one workspace sends Hebrew and English from the same campaign list, so
      // anything but the text itself gets one of them wrong.
      //
      // On the card rather than on each label, because a flex row inherits it:
      // the primary button lands on the right in Hebrew without a second rule.
      card.dir = 'auto';

      // Author overrides, set as CUSTOM PROPERTIES rather than as direct inline
      // styles. Both are inline, but a custom property only feeds the
      // stylesheet rule above - so campaign CSS can still override it, while an
      // inline `background` could only be beaten with !important. Each is
      // optional: unset leaves the system default, which is what makes an
      // unstyled message look like it belongs on the page rather than carrying
      // our palette onto it.
      const st = (native as { style?: Record<string, unknown> }).style;
      if (typeof st?.customCss === 'string') authorCss = st.customCss;
      if (st) {
        const token = (name: string, value: unknown, suffix = '') => {
          if (typeof value === 'string' && value.trim()) {
            card.style.setProperty(name, value.trim() + suffix);
          } else if (typeof value === 'number' && Number.isFinite(value)) {
            card.style.setProperty(name, String(value) + suffix);
          }
        };
        token('--joryio-inapp-bg', st.backgroundColor);
        token('--joryio-inapp-fg', st.textColor);
        token('--joryio-inapp-font', st.fontFamily);
        token('--joryio-inapp-radius', st.cornerRadius, 'px');
        token('--joryio-inapp-size', st.fontSize, 'px');
        if (typeof st.titleWeight === 'string') {
          const WEIGHTS: Record<string, string> = {
            regular: '400',
            medium: '500',
            semibold: '600',
            bold: '700',
          };
          token('--joryio-inapp-title-weight', WEIGHTS[st.titleWeight]);
        }
        if (typeof st.textAlign === 'string' && st.textAlign !== 'auto') {
          // `start`/`end` are already direction-relative in CSS, so they do the
          // right thing under dir="auto" without a second branch for RTL.
          token('--joryio-inapp-align', st.textAlign);
        }
        token('--joryio-inapp-primary', st.primaryButtonColor);
        // No explicit label colour: derive one from the FILL rather than
        // leaving AccentColorText, which is white on most systems. An author
        // who picks a pale brand colour and stops there would otherwise get an
        // invisible label - and it would look right in the editor preview.
        token(
          '--joryio-inapp-primary-fg',
          typeof st.primaryButtonTextColor === 'string' && st.primaryButtonTextColor.trim()
            ? st.primaryButtonTextColor
            : readableForeground(st.primaryButtonColor),
        );
      }

      if (native.imageUrl && /^https:\/\//i.test(native.imageUrl)) {
        const img = document.createElement('img');
        img.src = native.imageUrl;
        img.alt = '';
        // A failed image hides rather than leaving a broken-image icon in the
        // middle of the message.
        img.onerror = () => img.remove();
        card.appendChild(img);
      }

      if (native.title) {
        const h = document.createElement('h2');
        h.textContent = native.title;
        card.appendChild(h);
      }

      const p = document.createElement('p');
      p.textContent = native.body;
      card.appendChild(p);

      if (native.buttons?.length) {
        const row = document.createElement('div');
        row.className =
          native.buttons.length <= 2 ? 'joryio-inapp-buttons' : 'joryio-inapp-buttons stacked';
        native.buttons.forEach((b, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = b.text;
          // The author's order decides which action leads; the first is primary.
          btn.className = index === 0 ? 'primary' : 'secondary';
          btn.addEventListener('click', () => {
            // The backend's vocabulary action (`clicked`), never the button
            // id: an id like `cta` is outside the vocabulary, so the server
            // recorded "unknown_action" and the click never counted.
            const elementId = normalizedElementId(b.id);
            this.trackImpression(
              campaign.id,
              'clicked',
              {
                ...(b.url && /^https?:\/\//i.test(b.url) ? { clickedUrl: b.url } : {}),
                ...(elementId ? { elementId } : {}),
              },
            ).catch(() => {});
            this.callHost('onMessageClick', () => this.displayOptions.onClick?.(message, b.id || b.action || 'button'));
            // The push-permission action carries no url, so the url branch
            // below skipped it and the button silently did nothing on web -
            // while iOS, Android, React Native and Unity all act on it. The
            // capability was already here for HTML messages (the bridge's
            // requestPushPermission); only the native renderer never called it.
            //
            // FIRST and synchronously: this must run inside the click handler's
            // user activation or the browser refuses to show the OS prompt, and
            // an await anywhere above it loses that activation.
            if (b.action === 'request_push_permission') {
              if (this.canPromptForPush()) {
                this.bridge?.requestPushPermission();
              }
            } else if (
              // Named actions only. `!== 'dismiss'` would have been enough
              // today but is the exact shape that let the push action through
              // the wrong branch in the first place - and a stored `dismiss`
              // button that still carries a stale url would open it.
              (b.action === 'url' || b.action === 'deep_link') &&
              b.url &&
              /^https?:\/\//i.test(b.url)
            ) {
              // http(s) only - same rule as every other renderer.
              window.open(b.url, '_blank', 'noopener');
            }
            // EVERY button dismisses, and an unknown action was already decoded
            // to dismiss server-side, so a future action type cannot leave a
            // button that does nothing.
            this.dismiss(campaign.id, 'button').catch(() => {});
          });
          row.appendChild(btn);
        });
        card.appendChild(row);
      }

      if (native.closeButton !== false) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'joryio-inapp-close';
        // The glyph is decorative; the accessible name is what a screen reader
        // announces. Without aria-label an icon-only button reads as "button".
        close.innerHTML = '&times;';
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', () => {
          this.dismiss(campaign.id, 'close_button').catch(() => {});
        });
        card.appendChild(close);
      }

      container.appendChild(card);
      // No early return and no impression here. This branch used to append
      // the card to <body> WITHOUT the stylesheet (so it was unpositioned),
      // track a second `displayed` (commitDisplay's caller already tracks it -
      // every native impression counted twice), and return before onDisplay,
      // which therefore never fired for native messages. Native now shares the
      // mounting below with HTML.
    }

    // Guard against multiple rapid dismiss calls (e.g., double-click)
    let isDismissing = false;

    if (campaign.content?.kind !== 'native') {
      // HTML is shown in an iframe that can execute script at this page's
      // origin (only the SDK bridge - the nonce CSP blocks author script). An
      // integration that has not opted in never creates one. This is a SKIP, not a failure: native messages still display,
      // because they are data rendered as DOM with no interpreter.
      if (!this.allowHtmlJsInAppMessages) {
        this.logger.warn(
          `Campaign ${campaign.id} is an HTML in-app message, but ` +
            `allowHtmlJsInAppMessages is false - not displaying it.`,
        );
        return;
      }

      // allow-scripts/allow-same-origin: run the SDK bridge bootstrap (the
      // nonce CSP blocks every other script) + reach the host bridge.
      // allow-popups: a CTA may open a new tab. NOT allow-top-navigation: every
      // link and redirect goes through the bridge's `navigate`, which the HOST
      // page carries out (rule 57) - the message document itself may never
      // navigate anything.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
      // Only the initial document may load (rule 57). A second `load` means the
      // frame navigated away from its srcdoc (a meta refresh, a link the
      // bootstrap did not catch): the message is removed rather than left
      // showing - and bridging - a document Joryio did not render.
      let frameLoads = 0;
      iframe.addEventListener('load', () => {
        frameLoads++;
        let onSrcdoc = true;
        try {
          const href = iframe.contentWindow?.location?.href;
          onSrcdoc = href === undefined || href === 'about:srcdoc';
        } catch {
          onSrcdoc = false; // cross-origin: it navigated
        }
        if (frameLoads > 1 || !onSrcdoc) {
          this.logger.warn(`In-app message ${campaign.id} tried to navigate its frame; it has been closed`);
          this.dismiss(campaign.id, 'navigation_blocked').catch(() => undefined);
        }
      });
      iframe.setAttribute('title', campaign.name || 'Message');
      // Start at 0 height (avoids the ~150px default-iframe flash); the bootstrap
      // reports real size on load via the bridge's setSize. Banner/fullscreen fill
      // width; modal/slideup get their content width from setSize.
      iframe.style.height = '0';
      if (campaign.type === 'banner' || campaign.type === 'fullscreen') {
        iframe.style.width = '100%';
      }
      iframe.srcdoc = this.buildSrcdoc(
        campaign.id,
        renderedHtml,
        campaign.content?.kind === 'html' ? campaign.content.css : '',
        campaign.type,
      );
      container.appendChild(iframe);
      this.iframes.set(campaign.id, iframe);

      // If this looks like a push primer, pre-warm web push (VAPID + SW) now so the
      // later gesture-bound requestPushPermission() prompts reliably. Fire-and-forget;
      // never prompts. Only for messages that actually reference the push action, so
      // non-primer messages don't register the SW.
      if (renderedHtml.includes('requestPushPermission')) {
        this.bridge?.preparePushPermission?.();
      }

      // Add close button if enabled (native draws its own inside the card)
      if (this.displayOptions.closeButton !== false) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'joryio-inapp-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.onclick = async () => {
          if (isDismissing) return;
          isDismissing = true;
          await this.dismiss(campaign.id, 'close_button').catch(() => {});
        };
        container.appendChild(closeBtn);
      }
    }

    // Add backdrop for modal/fullscreen
    let backdrop: HTMLElement | null = null;
    if (campaign.type === 'modal' || campaign.type === 'fullscreen') {
      backdrop = document.createElement('div');
      backdrop.className = 'joryio-inapp-backdrop';
      backdrop.id = `joryio-backdrop-${campaign.id}`;

      const nativeBackdropDismissible =
        campaign.content?.kind !== 'native' || campaign.content.backdropDismissible !== false;
      if (this.displayOptions.backdropClose !== false && nativeBackdropDismissible) {
        backdrop.onclick = async () => {
          if (isDismissing) return;
          isDismissing = true;
          await this.dismiss(campaign.id, 'backdrop').catch(() => {});
        };
      }
    }

    // Click tracking + CTA actions now happen INSIDE the iframe (cross-frame
    // clicks aren't visible to the host) — see buildSrcdoc's bootstrap, which
    // auto-logs a/button clicks and routes `data-joryio-action` to joryioBridge.

    // Append to DOM. Default to <html> (documentElement), NOT <body>: a
    // position:fixed element's containing block is the viewport ONLY if no
    // ancestor has a transform/filter/perspective/will-change. Many themes
    // (e.g. RTL Elementor) put a transform on <body>, which silently makes the
    // backdrop + modal anchor to <body>'s box instead of the viewport — the
    // overlay then renders off to one side on wide screens (centered fine on
    // narrow ones, where body ≈ viewport). Anchoring to <html> sidesteps a
    // transformed <body>. An explicit displayOptions.container still wins.
    const targetContainer = this.displayOptions.container || document.documentElement;
    if (backdrop) {
      targetContainer.appendChild(backdrop);
    }
    targetContainer.appendChild(style);

    // The advanced escape hatch: CSS the campaign author wrote by hand. It is
    // appended AFTER the base sheet so equal-specificity rules win, and every
    // selector in it is rewritten to sit under this message's container.
    //
    // The scoping is not a nicety. Native content is NOT in an iframe (there is
    // no markup to sandbox), so an unscoped `body { display: none }` typed into
    // a campaign would blank the customer's website. Scoping makes the blast
    // radius the message itself.
    if (typeof authorCss === 'string' && authorCss.trim()) {
      const scoped = this.scopeCss(authorCss, `#joryio-inapp-${campaign.id}`);
      if (scoped) {
        const custom = document.createElement('style');
        custom.id = `joryio-css-${campaign.id}`;
        custom.textContent = scoped;
        targetContainer.appendChild(custom);
      }
    }

    targetContainer.appendChild(container);

    // Call onDisplay callback
    this.callHost('onMessageDisplay', () => this.displayOptions.onDisplay?.(message));

    this.logger.info(`Displayed campaign: ${campaign.name} (${campaign.id})`);
  }

  /**
   * Build the iframe srcdoc: the message HTML + its CSS + a bootstrap that
   * (a) exposes `window.joryioBridge` (proxying same-origin to the host bridge),
   * (b) auto-routes `data-joryio-action="<method>"` clicks to it + logs a/button
   * clicks, and (c) reports content height so the host can size the iframe.
   *
   * A declarative CTA may carry ONE argument, in `data-joryio-event`. Before
   * that the router called the verb with no arguments at all, which is why
   * `logConversion` had to be pulled from the editor's dropdown: it needs an
   * event name, received `undefined`, and the host guard dropped it - a control
   * that looked like it worked and logged nothing. Verbs taking two arguments
   * (`navigate`) still cannot be driven declaratively.
   * NOT sanitized here, nor by the server beyond <base> and meta refresh: the
   * nonce CSP below is what keeps author script from running, and the sandbox
   * and navigation rules contain the document. campaignId + the host
   * key are injected as JSON literals (our own values).
   */
  private buildSrcdoc(
    campaignId: string,
    html: string,
    css: string,
    type: InAppCampaign['type'],
  ): string {
    const cid = JSON.stringify(campaignId);
    const key = JSON.stringify(HOST_BRIDGE_KEY);
    // Content-sized types shrink the body to its content so scrollWidth reflects
    // the authored width (the host sets the iframe to it). Full-bleed types keep
    // body at full width (the host forces the iframe to 100%, ignoring width).
    const contentSized = type === 'modal' || type === 'slideup';
    const bodySizing = contentSized ? 'body{display:inline-block;max-width:100vw;}' : '';
    const bootstrap = `(function(){
      var CID=${cid},KEY=${key};
      // Per-device visibility: tag the root with the REAL device class from the
      // HOST page viewport (the iframe is message-sized, so its own innerWidth is
      // useless here). The jr-vp-* → jr-hide-* rules in <style> then hide elements
      // the dashboard marked "Mobile only" / "Desktop only". <=480 = mobile.
      try{var __vp=0;try{__vp=window.parent.innerWidth||0;}catch(e){}if(!__vp)__vp=window.innerWidth||0;document.documentElement.className+=(__vp<=480?' jr-vp-mobile':' jr-vp-desktop');}catch(e){}
      function host(){try{return window.parent[KEY]||null;}catch(e){return null;}}
      function call(m,args){var b=host();if(b&&typeof b[m]==='function'){try{return b[m].apply(b,[CID].concat(args||[]));}catch(e){}}}
      window.joryioBridge={
        logCustomEvent:function(name,props){call('logCustomEvent',[name,props]);},
        setCustomUserAttribute:function(k,v){call('setCustomUserAttribute',[k,v]);},
        changeUser:function(uid){call('changeUser',[uid]);},
        requestPushPermission:function(){call('requestPushPermission',[]);},
        logConversion:function(ev){call('logConversion',[ev||'in_app_conversion']);},
        submitForm:function(values){return call('submitForm',[values]);},
        logClick:function(action){call('logClick',[action]);},
        navigate:function(url,target){call('navigate',[url,target]);},
        closeMessage:function(){call('closeMessage',[]);}
      };
      document.addEventListener('click',function(e){
        var el=e.target;
        while(el&&el!==document.body&&el!==document.documentElement){
          var action=el.getAttribute&&el.getAttribute('data-joryio-action');
          if(action&&typeof window.joryioBridge[action]==='function'){e.preventDefault();window.joryioBridge[action](el.getAttribute('data-joryio-event')||undefined);return;}
          var tag=el.tagName;
          if(tag==='A'||tag==='BUTTON'){
            var da=el.getAttribute('data-action');
            var href=tag==='A'?el.getAttribute('href'):null;
            window.joryioBridge.logClick(da||(href?'link_click':'cta_click'));
            // Route only http(s)/root-relative links through the host (top-nav,
            // since the sandbox can't navigate the top page itself). Leave
            // #anchors, mailto:, tel:, sms: to the browser. Any other link
            // would navigate THIS frame away from the message: cancelled (rule 57).
            if(href&&/^(https?:\\/\\/|\\/(?!\\/))/i.test(href)){e.preventDefault();window.joryioBridge.navigate(href,el.getAttribute('target'));}
            else if(href&&!/^(#|mailto:|tel:|sms:)/i.test(href)){e.preventDefault();}
            return;
          }
          el=el.parentNode;
        }
      },true);
      // Forms (data-jry-form): serialize, hand the values to the host, show the
      // answer in place. A redirect goes through navigate (the sandbox cannot).
      document.addEventListener('submit',function(ev){var f=ev.target;if(!(f&&f.tagName==='FORM'&&f.hasAttribute('data-jry-form')))return;ev.preventDefault();if(f.getAttribute('data-jry-busy'))return;
        var d={},els=f.querySelectorAll('input,select,textarea');for(var i=0;i<els.length;i++){var el=els[i],n=el.name;if(!n||el.disabled)continue;if(el.type==='checkbox'){if(!el.checked)continue;if(d[n]===undefined)d[n]=[];d[n].push(el.value||'on')}else if(el.type==='radio'){if(el.checked)d[n]=el.value}else d[n]=el.value}
        function msg(text,ok){var b=f.querySelector('[data-jry-message]');if(!b){b=document.createElement('div');b.setAttribute('data-jry-message','');b.setAttribute('role','status');f.appendChild(b)}b.textContent=text;b.className=ok?'jry-form-success':'jry-form-error';reportSize()}
        f.setAttribute('data-jry-busy','1');var btn=f.querySelector('button[type="submit"],input[type="submit"]');if(btn)btn.disabled=true;
        var p=window.joryioBridge.submitForm(d);if(!p||typeof p.then!=='function'){msg('This form cannot be sent here.',false);f.removeAttribute('data-jry-busy');if(btn)btn.disabled=false;return}
        p.then(function(r){if(r&&r.ok){if(r.redirect){window.joryioBridge.navigate(r.redirect,'_top');return}var els2=f.querySelectorAll('input,select,textarea,button');for(var j=0;j<els2.length;j++){els2[j].disabled=true}msg(r.message||'Thank you.',true)}else{msg((r&&(r.message||(r.errors&&r.errors[0])))||'Something went wrong. Please try again.',false);f.removeAttribute('data-jry-busy');if(btn)btn.disabled=false}}).catch(function(){msg('Something went wrong. Please try again.',false);f.removeAttribute('data-jry-busy');if(btn)btn.disabled=false});
      },true);
      function reportSize(){try{var b=document.body,de=document.documentElement;var w=Math.max(b?b.scrollWidth:0,de.scrollWidth);var h=Math.max(b?b.scrollHeight:0,de.scrollHeight);call('setSize',[w,h]);}catch(e){}}
      if(document.readyState!=='loading')reportSize();else document.addEventListener('DOMContentLoaded',reportSize);
      window.addEventListener('load',reportSize);
      try{if(window.ResizeObserver&&document.body){new ResizeObserver(reportSize).observe(document.body);}}catch(e){}
    })();`;
    // Per-device visibility rules (kept in sync with the editor's
    // inAppEditorPanels.VISIBILITY_RULES_CSS). The bootstrap above sets the
    // jr-vp-* root class from the real device.
    const visRules =
      '.jr-vp-mobile .jr-hide-mobile{display:none!important}.jr-vp-desktop .jr-hide-desktop{display:none!important}';
    /*
     * A per-document CSP, and the nonce is the point.
     *
     * The server keeps the author's markup as written (sanitizeInAppHtml drops
     * only <base> and meta refresh), so author <script> blocks and on*
     * handlers ARE in this document. Because this iframe is `allow-scripts
     * allow-same-origin`, they would run at the HOST PAGE'S ORIGIN - XSS on a
     * customer's site, reachable from a compromised marketing account.
     *
     * `script-src 'nonce-...'` is the control: only the bootstrap below carries
     * the nonce, so nothing the author wrote executes. There is no server
     * sanitiser in front of it; this CSP is the first line, not a backstop.
     *
     * The rest is least-privilege for content that is only ever a message:
     *   default-src 'none'  nothing is allowed unless named below
     *   style-src unsafe-inline  author style="" attributes are kept, so this
     *                       must stay permissive; styles cannot execute
     *   img/media/font https: data:  no http subresources - the mixed-content
     *                       control Android enforced and iOS could not
     *   upgrade-insecure-requests  an author's http image is upgraded rather
     *                       than simply broken, so it still has a chance to load
     *   connect-src 'none'  the bridge is a same-origin property call, not a
     *                       fetch, so nothing legitimate needs the network
     */
    const nonce = randomNonce();
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      'img-src https: data:',
      'media-src https: data:',
      'font-src https: data:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    // The author's CSS goes inside <style>: a `</style>` in it would end the
    // sheet and inject markup (a meta refresh, a form) into the message
    // document. `</` is written `<\/` - the same characters to the CSS parser,
    // never an end tag to the HTML parser (rule 57).
    css = escapeStyleText(css);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;}img,video{max-width:100%;height:auto;}${bodySizing}${visRules}${css}</style></head><body>${html}<script nonce="${nonce}">${bootstrap}</script></body></html>`;
  }

  /**
   * Rewrites author CSS so every rule applies only inside `scope`.
   *
   * Parsed with the BROWSER's own CSS parser rather than a regex: a hand-rolled
   * splitter gets strings, comments, nested @media and escaped braces wrong,
   * and every one of those mistakes is a rule that escapes onto the customer's
   * page. The probe sheet is attached with `media="not all"` so it never
   * applies while being parsed, then removed.
   *
   * Returns '' when nothing usable survives - and SAYS SO in the log, because
   * a marketer who wrote CSS and got no error would otherwise be left thinking
   * their code ran.
   */
  private scopeCss(css: string, scope: string): string {
    let probe: HTMLStyleElement | null = null;
    try {
      probe = document.createElement('style');
      probe.media = 'not all';
      probe.textContent = css;
      document.head.appendChild(probe);
      const sheet = probe.sheet;
      if (!sheet) {
        this.logger.warn('Custom CSS could not be parsed; ignoring it');
        return '';
      }
      const scoped = scopeCssRules(sheet.cssRules, scope);
      if (!scoped) {
        this.logger.warn('Custom CSS contained no rules that can be scoped; ignoring it');
      }
      return scoped;
    } catch (error) {
      this.logger.warn('Custom CSS could not be parsed; ignoring it', error);
      return '';
    } finally {
      probe?.remove();
    }
  }

  /**
   * Dismiss a message
   */
  async dismiss(campaignId: string, action: string = 'dismiss'): Promise<void> {
    // A message still waiting out its delay is cancelled rather than shown
    // later: the user has already dealt with it.
    const pending = this.pendingDelays.get(campaignId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDelays.delete(campaignId);
    }

    const container = document.getElementById(`joryio-inapp-${campaignId}`);
    const backdrop = document.getElementById(`joryio-backdrop-${campaignId}`);
    const style = document.getElementById(`joryio-style-${campaignId}`);
    const customCss = document.getElementById(`joryio-css-${campaignId}`);

    if (container) {
      container.remove(); // also removes the child content iframe
    }
    this.iframes.delete(campaignId);
    if (backdrop) {
      backdrop.remove();
    }
    if (style) {
      style.remove();
    }
    // Leaving this behind would restyle the NEXT message on the page, since the
    // author's rules are keyed by campaign id but the class names are shared.
    if (customCss) {
      customCss.remove();
    }

    const message = this.displayedMessages.get(campaignId);
    if (message) {
      // `action` (close_button, backdrop, ...) goes to the onDismiss callback;
      // the wire carries the vocabulary value, which trackImpression sets.
      // The slot is released whatever happens to the report (sending blocked,
      // a failed request) - contract item 43.
      await this.trackImpression(campaignId, 'dismissed').catch(() => undefined);

      this.callHost('onMessageDismiss', () => this.displayOptions.onDismiss?.(message, action));

      this.displayedMessages.delete(campaignId);
    }

    this.logger.info(`Dismissed campaign: ${campaignId}`);
  }

  /**
   * Track conversion for a message
   */
  async trackConversion(campaignId: string, event: string): Promise<void> {
    await this.trackImpression(campaignId, 'converted', { conversionEvent: event });

    const message = this.displayedMessages.get(campaignId);
    if (message) this.callHost('onConversion', () => this.displayOptions.onConversion?.(message, event));
  }

  /**
   * Track impression
   */
  /** Post a message form's values with this SDK's identity; the answer is the server's verdict for the message runtime. */
  private async submitForm(campaignId: string, values: Record<string, unknown>): Promise<{ ok: boolean; message?: string; redirect?: string; errors?: string[] }> {
    const message = this.displayedMessages.get(campaignId);
    if (!this.runtime.canSend()) return { ok: false, message: 'This form cannot be sent right now.' };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.runtime.requestTimeoutMs);
    const subjectUser = this.identity.getUserId();
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/in-app/form-submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...(this.auth?.getSdkAuthHeaders(subjectUser) || {}),
        },
        body: JSON.stringify({
          campaignId,
          variantId: (message?.campaign as any)?.variantId,
          userId: this.identity.getUserId() || undefined,
          anonymousId: this.identity.getAnonymousId(),
          values,
        }),
        signal: controller.signal,
      });
      await this.maybeHandleSdkAuthError(response, `${this.apiEndpoint}/v1/in-app/form-submit`, subjectUser);
      const json = await response.json().catch(() => null);
      if (!json || typeof json !== 'object') return { ok: false, message: 'Something went wrong. Please try again.' };
      return json;
    } catch {
      return { ok: false, message: 'Something went wrong. Please try again.' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async trackImpression(
    campaignId: string,
    type: 'displayed' | 'clicked' | 'dismissed' | 'converted',
    extra?: Record<string, any>,
  ): Promise<void> {
    const campaign = this.campaigns.get(campaignId) || this.displayedMessages.get(campaignId)?.campaign;
    if (!campaign) return;
    // Opted out / consent pending / suspended: an impression is tracking too.
    if (!this.runtime.canSend()) return;

    const sessionId = this.session.getSessionId();

    const data: any = {
      campaignId,
      variantId: campaign.variantId,
      ...this.subject(),
      sessionId,
      deviceType: 'web',
      locale: navigator.language,
      userAgent: navigator.userAgent,
      // Echo the journey handle when the server queued this message from a
      // canvas node — without it the impression/click is recorded against the
      // campaign only and the journey node shows no stats.
      ...(campaign.pendingId ? { pendingId: campaign.pendingId } : {}),
      // Echo the delivery token — proof the server actually served this message.
      // The server prefers it over every identity field above, and uses it to
      // make each transition one-shot. Omitting it does not fail today, but the
      // impression is then unverifiable and will be rejected once the backend
      // requires it.
      ...(campaign.deliveryToken ? { deliveryToken: campaign.deliveryToken } : {}),
      ...extra,
    };

    // Timestamps are ISO-8601 UTC (toISOString always ends in Z).
    //
    // `action` is ALWAYS the backend's vocabulary word
    // (common/events/in-app-action-vocabulary.ts). This used to send the
    // button id, 'close_button', 'backdrop', 'form_submit'... - none of which
    // the server knows, so each was answered `recorded: false,
    // reason: unknown_action` and web in-app clicks and dismissals never
    // reached reporting. (Fallbacks 'click' / 'dismiss' are synonyms the
    // vocabulary also accepts.)
    if (type === 'displayed') {
      data.displayedAt = new Date().toISOString();
    } else if (type === 'clicked') {
      data.clicked = true;
      data.clickedAt = new Date().toISOString();
      data.action = 'clicked';
    } else if (type === 'dismissed') {
      data.dismissedAt = new Date().toISOString();
      data.action = 'dismissed';
    } else if (type === 'converted') {
      data.converted = true;
      data.convertedAt = new Date().toISOString();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.runtime.requestTimeoutMs);

    const subjectUser = typeof data.userId === 'string' && data.userId ? data.userId : null;
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/in-app/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...(this.auth?.getSdkAuthHeaders(subjectUser) || {}),
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      if (!response.ok) this.runtime.noteStatus?.(response.status, null);
      // Refresh the token on a 401 SDK-auth error so subsequent calls succeed.
      await this.maybeHandleSdkAuthError(response, `${this.apiEndpoint}/v1/in-app/track`, subjectUser);

      this.logger.debug(`Tracked ${type} for campaign ${campaignId}`);
    } catch (error) {
      if ((error as any)?.name === 'AbortError') {
        this.logger.error(`Impression tracking timed out after ${this.runtime.requestTimeoutMs}ms for campaign ${campaignId}`);
      } else {
        this.logger.error(`Failed to track ${type}:`, error);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check frequency cap
   */
  private checkFrequencyCap(campaign: InAppCampaign): boolean {
    if (!campaign.frequencyCap) return true;

    const { maxImpressions, timeWindow, minDelayBetweenImpressions } = campaign.frequencyCap;
    if (!maxImpressions || !timeWindow) return true;
    const timestamps = this.impressionTimestamps.get(campaign.id) || [];

    // Calculate time window in milliseconds
    const now = Date.now();
    let windowStart = 0;

    if (timeWindow === 'once' || timeWindow === 'lifetime') {
      // Check if ever displayed
      return timestamps.length === 0;
    } else if (timeWindow === 'session') {
      // Check only in current session
      windowStart = this.session.getSessionInfo().sessionStart;
    } else {
      // Parse time window (e.g. "1h", "7d", "30min", "3mo").
      //
      // LONGEST SUFFIX FIRST. Reading the last character alone was fine while
      // every unit was one letter, but "30min" and "3mo" both end in a letter
      // that means something else - `slice(-1)` reads "30min" as 30 MONTHS.
      // Shared vocabulary: backend common/in-app-frequency-window.ts.
      const units: Array<[string, number]> = [
        ['min', 60 * 1000],
        ['mo', 30 * 24 * 60 * 60 * 1000],
        ['h', 60 * 60 * 1000],
        ['d', 24 * 60 * 60 * 1000],
        ['w', 7 * 24 * 60 * 60 * 1000],
        ['m', 30 * 24 * 60 * 60 * 1000],
      ];
      const oneDay = 24 * 60 * 60 * 1000;
      let windowMs = oneDay;
      for (const [suffix, ms] of units) {
        if (!timeWindow.endsWith(suffix)) continue;
        const value = parseInt(timeWindow.slice(0, -suffix.length), 10);
        if (!Number.isNaN(value) && value > 0) windowMs = value * ms;
        break;
      }
      windowStart = now - windowMs;
    }

    // Count impressions in window
    const recentTimestamps = timestamps.filter((t) => t >= windowStart);

    if (recentTimestamps.length >= maxImpressions) {
      return false;
    }

    // Check min delay between impressions
    if (minDelayBetweenImpressions && timestamps.length > 0) {
      const lastTimestamp = timestamps[timestamps.length - 1];
      const timeSinceLast = now - lastTimestamp;
      if (timeSinceLast < minDelayBetweenImpressions * 1000) {
        return false;
      }
    }

    return true;
  }

  /**
   * Start watching for attribute changes (for differential-sync)
   */
  private startAttributeWatching(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
    if (this.watchedAttributes.size === 0) return;

    this.logger.debug(`Watching ${this.watchedAttributes.size} attributes for changes`);

    // Store current attribute values
    const previousAttributes: Record<string, any> = {};
    this.watchedAttributes.forEach((attr) => {
      previousAttributes[attr] = this.identity.getAttribute(attr);
    });

    // Check for changes periodically
    this.syncInterval = window.setInterval(() => {
      // Skip the diff + network re-sync while the tab is backgrounded — nothing
      // is changing user-visibly and we don't want to poll/fetch on hidden tabs.
      // Picks back up automatically when the tab becomes visible again.
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      const changes: Record<string, any> = {};
      let hasChanges = false;

      this.watchedAttributes.forEach((attr) => {
        const currentValue = this.identity.getAttribute(attr);
        if (currentValue !== previousAttributes[attr]) {
          changes[attr] = currentValue;
          previousAttributes[attr] = currentValue;
          hasChanges = true;
        }
      });

      if (hasChanges) {
        // FAST PATH: a campaign already held whose attribute_threshold is now
        // satisfied displays immediately, with no round trip.
        this.checkAttributeThresholds(Object.keys(changes));

        // SLOW PATH, and NOT redundant: a changed attribute can make the user
        // newly eligible for a campaign this device has never been sent - the
        // server pre-authorises, so only it can know that. The difference from
        // `event` triggers, where the campaign is already here by definition.
        // Not in session-start-only mode, which syncs at session start only.
        if (this.runtime.evaluationMode === 'session-start-only' || !this.runtime.canSend()) return;
        this.logger.info('Attribute changes detected, re-syncing campaigns');
        this.sync(changes).catch((error) => {
          this.logger.error('Failed to re-sync on attribute change:', error);
        });
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Display a held campaign whose `attribute_threshold` is now met.
   *
   * A trigger type the editor offers and the server sends, evaluated by no
   * SDK: "show when loyaltyPoints passes 1000" only ever appeared on a later
   * sync, if at all.
   *
   * Evaluated against the CURRENT attribute values, not the changed keys alone
   * - a threshold is about where the value landed, not that it moved.
   */
  private checkAttributeThresholds(changedKeys: string[]): void {
    if (!changedKeys.length) return;
    const attributes = this.identity.getAttributes() || {};

    for (const campaign of this.campaigns.values()) {
      const hit = (campaign.triggers || []).some(
        (t) =>
          t.type === 'attribute_threshold' &&
          !!t.attribute &&
          changedKeys.includes(t.attribute) &&
          this.triggerFilterMatches(t, attributes),
      );
      if (hit) {
        this.displayCampaign(campaign).catch((error) =>
          this.logger.error('In-app display failed:', error));
        return;
      }
    }
  }

  /**
   * Get all active campaigns
   */
  getCampaigns(): InAppCampaign[] {
    return Array.from(this.campaigns.values());
  }

  /**
   * Get a specific campaign
   */
  getCampaign(campaignId: string): InAppCampaign | undefined {
    return this.campaigns.get(campaignId);
  }

  /**
   * Clear all in-app messaging state (used during reset)
   */
  clearAll(): void {
    this.logger.info('Clearing in-app messaging state');

    // Answers to requests made for the outgoing visitor are now stale.
    this.invalidate();

    // Every timer: attribute poll, periodic sync, sync retry, display delays.
    // reset() used to leave a pending delayed message and the 5 s retry
    // running, so user A's message could pop up after user B logged in.
    this.stop();

    // Dismiss all displayed messages
    for (const campaignId of this.displayedMessages.keys()) {
      this.dismiss(campaignId, 'clear').catch((error) =>
        this.logger.error('In-app dismiss failed:', error));
    }

    // Clear caches. NOT the impression history: frequency caps are kept per
    // browser and survive a reload anyway, and clearing only the in-memory
    // copy meant the next display re-persisted that one campaign alone - the
    // stored caps of every other campaign were silently erased.
    this.campaigns.clear();
    this.displayedMessages.clear();
    this.watchedAttributes.clear();
    this.iframes.clear();

    this.logger.info('In-app messaging state cleared');
  }

  /** Erase the stored impression history (wipeData): every frequency cap starts again. */
  forgetImpressions(): void {
    this.impressionTimestamps.clear();
    try {
      this.storage?.remove(IMPRESSIONS_STORAGE_KEY);
    } catch {
      // best-effort
    }
  }

  
  
  
  /**
   * Add an entry to a Map, evicting the oldest entry (first key) if it exceeds maxSize.
   */
  private boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
    map.set(key, value);
    if (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
  }

  /**
   * Add an entry to a Set, evicting the oldest entry (first value) if it exceeds maxSize.
   */
  private boundedSetAdd<V>(set: Set<V>, value: V, maxSize: number): void {
    set.add(value);
    if (set.size > maxSize) {
      const oldestValue = set.values().next().value;
      if (oldestValue !== undefined) {
        set.delete(oldestValue);
      }
    }
  }

  /**
   * Destroy in-app messaging
   */
  destroy(): void {
    this.logger.info('Destroying in-app messaging');

    // Every timer, including display delays and the sync retry, which used
    // to outlive destroy().
    this.stop();

    // Dismiss all displayed messages
    for (const campaignId of this.displayedMessages.keys()) {
      this.dismiss(campaignId, 'destroy').catch((error) =>
        this.logger.error('In-app dismiss failed:', error));
    }

    // Clear caches
    this.campaigns.clear();
    this.displayedMessages.clear();
    this.impressionTimestamps.clear();
    this.watchedAttributes.clear();
    this.iframes.clear();

    // Tear down the host bridge so a later new JoryioSDK() rebinds a fresh one
    // (installHostBridge overwrites, but clearing here avoids a dangling closure
    // over this destroyed instance if no re-init happens).
    if (typeof window !== 'undefined') {
      delete (window as any)[HOST_BRIDGE_KEY];
    }
  }
}
