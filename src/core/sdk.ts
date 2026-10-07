/**
 * Joryio Web SDK
 * Main SDK class
 */

import { InitConfig, ResolvedConfig, resolveConfig, SDK_VERSION } from './config';
import { StorageManager } from './storage';
import { SessionManager, SESSION_ID_KEY } from './session';
import { IdentityManager } from './identity';
import { QueueManager, QueuedEvent, PendingIdentify, FlushOutcome, QUEUE_KEY, INFLIGHT_KEY, PENDING_IDENTIFY_KEY } from './queue';
import {
  NetworkClient,
  NetworkResponse,
  AttributeOps,
  SdkAuthFailureCallback,
  utf8Length,
} from './network';
import { UTMManager } from './utm';
import { InAppMessagingManager, InAppCampaign } from './inapp';
import { User } from './user';
import { Logger } from '../utils/logger';
import { getDeviceProperties } from './device';
import { generateUUID } from '../utils/uuid';
import { EcommerceTracker, EcommerceConfig, createEcommerceTracker } from './ecommerce';
import { PushManager, PENDING_UNREGISTER_KEY } from './push';
import {
  WriteRecord,
  WriteOwner,
  isWithdrawal,
  classifyWriteResponse,
  WRITE_MAX_ATTEMPTS,
} from './write-retry';
import { WriteOutbox, OutboxEntry, OUTBOX_KEY } from './outbox';
import { valueProblem, withoutUnsendableValues } from './values';

/**
 * The visitor's own opt-out, persisted so it survives a reload. It used to
 * live only in memory: a visitor who opted out was tracked again on the very
 * next page view unless every page passed `optOut: true` at init.
 */
const OPT_OUT_KEY = 'tracking_opted_out';
/**
 * A `denied` consent answer, persisted (contract item 24). `granted` is not
 * stored - it is the absence of a denial - and `pending` never is: it holds
 * for one page view.
 */
const CONSENT_KEY = 'tracking_consent';
/**
 * Written (a timestamp) on every explicit grant, so another tab holding in
 * 'pending' - which stores nothing, and so hears no change of CONSENT_KEY -
 * follows the grant. Never read at init: 'pending' is per page view.
 */
const CONSENT_GRANT_SIGNAL_KEY = 'tracking_consent_granted_at';
/**
 * When the stored denial / opt-out was DECIDED, and when the visitor last
 * opted in (rule 77, scan 7 N1). A tab that stores its denial again after
 * another tab's localStorage.clear() writes the decision's own time, so an
 * explicit grant or opt-in made in the clearing tab right after the clear -
 * newer than that decision - is not undone by it: a stored "no" counts only
 * while no newer explicit "yes" is stored.
 */
const CONSENT_DENIED_AT_KEY = 'tracking_consent_denied_at';
const OPT_OUT_AT_KEY = 'tracking_opted_out_at';
const OPT_IN_SIGNAL_KEY = 'tracking_opt_in_at';
/** The `tracking_opted_out` value the server ACKNOWLEDGED (contract item 33). */
const REPORTED_OPT_OUT_KEY = 'reported_tracking_opted_out';
/**
 * A `tracking_opted_out` value the server refused for good, or that failed
 * too often (contract item 40): not re-sent on every page view until the
 * switch changes again.
 */
const OPT_OUT_MARKER_GIVEN_UP_KEY = 'tracking_opted_out_marker_given_up';
/** The session whose Session Start has been queued (so a later grant or opt-in sends one, once). */
const SESSION_START_SENT_KEY = 'session_start_sent';
/**
 * A user id given to identify() while tracking was off (consent denied or
 * opted out) - owner decision D-b. Kept on this device only and used ONLY so
 * withdrawals (an unsubscribe, the opt-out marker) reach the right person;
 * the normal identify runs when tracking is allowed again.
 */
const WITHDRAWAL_USER_KEY = 'withdrawal_user_id';
/** Logged-out users' SDK-auth tokens, kept for their queued items (D-a). */
const RETIRED_SDK_AUTH_TOKENS_KEY = 'retired_sdk_auth_tokens';
/** Stored queues that may hold a logged-out user's items (by any tab of the site). */
const PERSISTED_ITEM_KEYS = [QUEUE_KEY, INFLIGHT_KEY, PENDING_IDENTIFY_KEY, OUTBOX_KEY, PENDING_UNREGISTER_KEY, 'held_attribute_writes'];

/** Every `userId` string anywhere in a stored value (formats differ per queue). */
function collectUserIds(value: unknown, into: Set<string>, depth: number = 0): void {
  if (!value || typeof value !== 'object' || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectUserIds(item, into, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'userId' && typeof item === 'string' && item) into.add(item);
    else collectUserIds(item, into, depth + 1);
  }
}
/**
 * The privacy state each SDK started from, before the snippet's queued
 * decisions were applied: the snippet replay drops data calls queued while
 * tracking was off (rule 73). Internal - not exported from the package.
 */
export const PRE_INIT_BASELINE = new WeakMap<object, { optedOut: boolean; consent: TrackingConsent }>();

/**
 * Why a replayed ready() callback is data-gated (rule 92): queued while the
 * visitor was opted out (lifted only by an optIn() the callback makes),
 * while consent was denied (lifted only by its own grant), or before a
 * queued optOut() / denial (the pre-init purge - never lifted from inside:
 * that decision came after the callback).
 */
export type DataGateReason = 'optedOut' | 'denied' | 'purged';

/**
 * Run `run` with the SDK's data calls dropped (rule 83): the snippet replays
 * a ready() callback queued while tracking was off through this. Internal -
 * not exported from the package.
 */
export function runWithDataCallsDropped(sdk: JoryioSDK, reasons: Iterable<DataGateReason>, run: () => void): void {
  const gate = sdk as unknown as { dataGate: Set<DataGateReason> };
  const previous = gate.dataGate;
  gate.dataGate = new Set([...previous, ...reasons]);
  try {
    run();
  } finally {
    gate.dataGate = previous;
  }
}

/** Identity keys another tab may change (reset(), identify()). */
const ANONYMOUS_ID_STORAGE_KEY = 'anonymous_id';
const USER_ID_STORAGE_KEY = 'user_id';

/**
 * SDK keys of another device platform. The backend issues
 * `jry_sdk_<platform>_<random>`; a web page runs web keys and the store
 * integrations' keys (`shopify`, `woocommerce`, `magento`), never a mobile
 * app's (rule 60).
 */
const FOREIGN_PLATFORM_KEY_PREFIXES = ['jry_sdk_ios_', 'jry_sdk_android_'];

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as any).onLine === false;
}

/**
 * The profile attribute recording the opt-out. NO `$` prefix: the API strips
 * `$`-prefixed attribute keys from SDK writes, so the old
 * `$tracking_opted_out` never reached a profile on any platform. The same key
 * on all five SDKs (contract addendum 14).
 */
export const TRACKING_OPTED_OUT_ATTRIBUTE = 'tracking_opted_out';

/**
 * Attribute writes not acknowledged yet, kept in storage so a navigation does
 * not lose them (contract item 37) - the same durability the mobile SDKs'
 * databases give. Removed entry by entry as the server acknowledges them.
 * (The key name predates 1.3.0, when only writes held by pending consent
 * were stored.)
 */
const ATTRIBUTE_WRITES_KEY = 'held_attribute_writes';
/** Leave room in the browser's 64 KiB keepalive budget for profile writes at unload. */
const UNLOAD_WRITES_BUDGET_BYTES = 8 * 1024;
/** The push_permission value the server ACKNOWLEDGED (written on ack, not on send). */
const REPORTED_PUSH_PERMISSION_KEY = 'joryio_reported_push_permission';
const PUSH_PERMISSION_ATTRIBUTE = 'push_permission';

/** The backend's `@MaxLength(255)` on event type and userId. */
const MAX_NAME_LENGTH = 255;

/**
 * The API's limits on one event's properties (backend
 * `validate-event-properties.util.ts`). An event over them is refused for
 * good, so it is dropped at track() with a log line rather than sent, refused
 * and - before `rejectedIndices` existed - retried forever (contract item 29).
 */
export const EVENT_PROPERTY_LIMITS = {
  /**
   * JSON.stringify(properties).length, in characters - exactly what the
   * backend measures (SDK_EVENT_LIMITS.propertiesMaxJsonChars). Not UTF-8
   * bytes: those count Hebrew or emoji text 2-4 times and refused events the
   * server accepts.
   */
  maxJsonChars: 51200,
  /** Top-level keys. */
  maxKeys: 200,
  /** Object/array nesting, the properties object itself being level 1. */
  maxDepth: 5,
} as const;

/** Why these properties would be refused by the API, or null when they are fine. */
export function eventPropertiesProblem(properties: Record<string, any>): string | null {
  const keys = Object.keys(properties).length;
  if (keys > EVENT_PROPERTY_LIMITS.maxKeys) {
    return `${keys} property keys (the limit is ${EVENT_PROPERTY_LIMITS.maxKeys})`;
  }
  const tooDeep = (value: any, depth: number): boolean => {
    if (depth > EVENT_PROPERTY_LIMITS.maxDepth) return true;
    if (value === null || typeof value !== 'object') return false;
    const children = Array.isArray(value) ? value : Object.values(value);
    return children.some((child) => child !== null && typeof child === 'object' && tooDeep(child, depth + 1));
  };
  if (tooDeep(properties, 1)) return `properties nested deeper than ${EVENT_PROPERTY_LIMITS.maxDepth} levels`;
  let json: string;
  try {
    json = JSON.stringify(properties);
  } catch {
    return 'properties that cannot be serialized (a circular reference?)';
  }
  if (json.length > EVENT_PROPERTY_LIMITS.maxJsonChars) {
    return `${json.length} characters of properties (the limit is ${EVENT_PROPERTY_LIMITS.maxJsonChars})`;
  }
  return null;
}

export type TrackingConsent = 'granted' | 'denied' | 'pending';

/**
 * A privacy decision made before the SDK started (the async snippet queues
 * calls until the bundle loads). Applied BEFORE any side effect of init - no
 * Session Start, in-app sync, push re-registration or attribute write happens
 * under the state the decision replaces (contract item 25).
 * @internal
 */
export type PreInitDecision =
  | { method: 'optOut' }
  | { method: 'optIn' }
  | { method: 'updateConsent'; consent: TrackingConsent }
  | { method: 'wipeData' };

export class JoryioSDK {
  private static instance: JoryioSDK | null = null;

  private config!: ResolvedConfig;
  private logger!: Logger;
  private storage!: StorageManager;
  private session!: SessionManager;
  /** Coalescing window for attribute writes. */
  private static readonly ATTRIBUTE_FLUSH_DEBOUNCE_MS = 800;
  private attributeFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes attribute flushes; see flushAttributeOps. */
  private attributeFlushInFlight = false;
  private attributeFlushAgain = false;
  /** Bumped when the pending store is cleared: an answer for the old store is ignored. */
  private attributeGeneration = 0;
  /** Consecutive failed attribute flushes, for the retry backoff. */
  private attributeFailures = 0;
  private identity!: IdentityManager;
  private queue!: QueueManager;
  private network!: NetworkClient;
  private utm!: UTMManager;
  private inapp!: InAppMessagingManager;
  private _user!: User;
  private _push!: PushManager;
  private _ecommerce: EcommerceTracker | null = null;
  private isInitialized: boolean = false;
  /**
   * Collect NOTHING: the visitor opted out, Do Not Track is on, or consent
   * was denied. Derived by applyPrivacyState(); never set directly.
   */
  private isOptedOut: boolean = false;
  /** The SDK key was missing or malformed: an inert instance (see the constructor). */
  private disabled: boolean = false;
  /** Consent pending: collect locally, send nothing until it is granted. */
  private consentPending: boolean = false;
  private userOptedOut: boolean = false;
  private dntEnabled: boolean = false;
  private trackingConsent: TrackingConsent = 'granted';
  /** Profile writes (subscriptions, aliases, the opt-out marker): persisted and ordered. */
  private outbox!: WriteOutbox;
  private lastTrackedUrl: string | null = null;
  private deviceId!: string;
  private boundHandlePageUnload: (() => void) | null = null;
  private boundHandleOnline: (() => void) | null = null;
  private boundHandleStorage: ((event: any) => void) | null = null;
  /** See WITHDRAWAL_USER_KEY. */
  private withdrawalUserId: string | null = null;
  /** When this tab's opt-out / denial was decided (see CONSENT_DENIED_AT_KEY); 0 = unknown. */
  private optedOutAt = 0;
  private consentDeniedAt = 0;
  /** The latest privacy-decision time this tab wrote or saw: stamps only increase. */
  private lastDecisionStamp = 0;
  /**
   * Another tab logged out and this one followed: the session it starts may
   * be stored after its new anonymous id (scan 7 N4), and is followed then.
   */
  private awaitingSessionOf: string | null = null;

  private pruneTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param preInit - internal: privacy decisions queued before the SDK loaded
   *   (see installSnippetQueue). Not part of the public API.
   */
  constructor(config: InitConfig, preInit?: PreInitDecision[]) {
    // Singleton pattern: return existing instance if already initialized
    if (JoryioSDK.instance) {
      // eslint-disable-next-line no-console -- this.logger is not assigned yet on the singleton early-return path
      console.warn('[Joryio] SDK already initialized. Returning existing instance.');
      return JoryioSDK.instance;
    }
    // Validate required config. Never THROWN (contract item 12): a missing or
    // malformed key used to throw out of the constructor, which in a bundle
    // took the host page's own script down with it. The instance is built
    // inert instead - every call on it is a logged no-op and nothing is sent,
    // stored for sending, or registered - and the reason is printed once,
    // whatever the log level.
    const keyProblem =
      !config || typeof config !== 'object' || typeof config.sdkKey !== 'string' || !config.sdkKey
        ? 'sdkKey is required'
        : !config.sdkKey.startsWith('jry_sdk_')
          ? 'invalid SDK key format, expected jry_sdk_*'
          : FOREIGN_PLATFORM_KEY_PREFIXES.some((prefix) => config.sdkKey.startsWith(prefix))
            ? 'this is a mobile app key - use the web SDK key (jry_sdk_web_...) from Settings -> Apps'
            : null;
    if (keyProblem) {
      // eslint-disable-next-line no-console -- the logger is silent by default and this is the reason nothing works
      console.error(`[Joryio] SDK not started: ${keyProblem}. Calls on this instance are ignored.`);
      this.disabled = true;
    }

    // Resolve config with defaults
    this.config = resolveConfig(
      keyProblem
        ? { ...(config && typeof config === 'object' ? config : {}), sdkKey: 'jry_sdk_invalid', optOut: false }
        : config,
    );

    // Logger: silent unless `enableDebug` or an explicit `logLevel` was set.
    this.logger = new Logger(this.config.loggingEnabled, this.config.logLevel);

    this.logger.info(`Initializing Joryio SDK v${SDK_VERSION}`);

    // Initialize core components
    this.storage = new StorageManager(this.config.sdkKey, this.logger);

    // --- Privacy state -------------------------------------------------
    // Two independent switches (contract item 24): the app's consent banner
    // and the visitor's own opt-out. Anything is collected only when consent
    // is granted AND the visitor has not opted out; any "no" wins.
    this.dntEnabled = this.config.respectDoNotTrack && this.isDoNotTrackEnabled();
    if (this.dntEnabled) {
      this.logger.warn('Do Not Track is enabled, SDK will not track events');
    }
    if (this.config.optOut) {
      this.writeOptOut();
    }
    this.userOptedOut = this.config.optOut || this.storedOptOut();
    if (this.userOptedOut) this.optedOutAt = this.storedStamp(OPT_OUT_AT_KEY);
    this.trackingConsent = this.initialConsent(this.config.trackingConsent);

    // Initialize UTM tracking (before session to check for campaign changes)
    this.utm = new UTMManager(
      this.storage,
      this.logger,
      this.config.resetSessionOnNewCampaign,
    );

    // Check if we should reset session due to new campaign
    const shouldResetSession = this.config.resetSessionOnNewCampaign &&
                                 this.config.captureUTM &&
                                 this.utm.hasNewCampaign();

    this.session = new SessionManager(this.storage, this.logger, this.config.sessionTimeout);

    // Reset session if new campaign detected
    if (shouldResetSession) {
      this.logger.info('New campaign detected, resetting session');
      this.session.resetSession();
    }

    this.identity = new IdentityManager(
      this.storage,
      this.logger,
      this.config.userId,
      this.config.anonymousId,
    );

    this.deviceId = this.getOrCreateDeviceId();
    this.queue = new QueueManager(
      this.storage,
      this.logger,
      this.config.batchSize,
      this.config.batchFlushInterval,
      this.config.persistQueue,
      this.config.maxQueueSize,
      this.config.retryBackoffMs,
    );
    this.network = new NetworkClient(
      this.config.sdkKey,
      this.logger,
      {
        maxRetries: this.config.maxRetries,
        backoffMs: this.config.retryBackoffMs,
        timeoutMs: this.config.requestTimeout,
      },
    );

    // A logged-out user's token stays bound to their queued items across a
    // reload (D-a), so their withdrawals and last events still authenticate.
    // Every tab shares the stored map: read-modify-write, never a blind
    // overwrite of another tab's entries (rule 62).
    this.network.setRetiredTokenStore({
      load: () => this.storage.get<Record<string, unknown>>(RETIRED_SDK_AUTH_TOKENS_KEY),
      update: (mutate) => {
        const stored = this.storage.get<Record<string, unknown>>(RETIRED_SDK_AUTH_TOKENS_KEY);
        const next = mutate(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {});
        if (Object.keys(next).length) this.storage.set(RETIRED_SDK_AUTH_TOKENS_KEY, next);
        else this.storage.remove(RETIRED_SDK_AUTH_TOKENS_KEY);
      },
    });
    // The user kept for withdrawals while tracking was off (D-b). An explicit
    // `userId` in the init config names who this page is about and wins over
    // it (rule 63): a page rendered for A must not send A's unsubscribe as B.
    const storedWithdrawalUser = this.storage.get<string>(WITHDRAWAL_USER_KEY);
    const configUserId = typeof this.config.userId === 'string' && this.config.userId ? this.config.userId : null;
    this.withdrawalUserId =
      typeof storedWithdrawalUser === 'string' &&
      storedWithdrawalUser &&
      storedWithdrawalUser !== this.identity.getUserId() &&
      !configUserId
        ? storedWithdrawalUser
        : null;
    if (!this.withdrawalUserId && storedWithdrawalUser) this.storage.remove(WITHDRAWAL_USER_KEY);
    this.network.setCurrentUserId(this.withdrawalUserId || this.identity.getUserId());

    // SDK authentication (opt-in). When enabled the network client attaches the
    // customer-minted JWT as `X-Joryio-Auth` and refreshes it on a 401
    // `sdk_authentication_error`. No-op when disabled. Set after the current
    // user, so the token is known to be that user's.
    if (this.config.enableSdkAuthentication) {
      this.network.setSdkAuthenticationEnabled(true);
      if (this.config.sdkAuthenticationToken) {
        this.network.setSdkAuthenticationToken(this.config.sdkAuthenticationToken);
      }
    }

    this.outbox = this.createOutbox();

    // Initialize in-app messaging. The bridge lets in-app message HTML call SDK
    // methods via `window.joryioBridge` (the push primer uses requestPushPermission).
    // Arrows capture `this` lazily — `_push` is constructed just below, but the
    // bridge methods are only invoked at message-interaction time, by which point
    // every dependency exists.
    this.inapp = new InAppMessagingManager(
      this.config.apiEndpoint,
      this.config.sdkKey,
      this.identity,
      this.session,
      this.logger,
      this.storage,
      {
        closeButton: true,
        backdropClose: true,
        // The RESOLVED displayOptions, which used to be dropped here: config.ts
        // resolves zIndex / backdropColor / closeButtonColor / defaultPosition /
        // defaultAnimation with defaults, and this literal replaced the lot. A
        // site that set inApp.displayOptions.zIndex to sit above its own header
        // got no effect and nothing to explain it.
        ...this.config.inApp.displayOptions,
        onDisplay: this.config.inApp.onMessageDisplay,
        onClick: this.config.inApp.onMessageClick,
        onDismiss: this.config.inApp.onMessageDismiss,
      },
      {
        logCustomEvent: (name, properties) => this.track(name, properties),
        setCustomUserAttribute: (key, value) => this.setAttribute(key, value),
        changeUser: (userId) => this.identify(userId),
        // Synchronous dispatch — keeps the click's user-gesture activation so the
        // OS push prompt fires (the iframe is same-origin; the call chain stays sync).
        // `.catch`, not bare `void`: `void` silences the linter, not the
        // rejection. An unhandled rejection fires the HOST page's
        // onunhandledrejection handler and lands in their error monitoring as if
        // their app had failed. Our push prompt being declined is our problem.
        requestPushPermission: () => {
          this._push.subscribe().catch((error) => {
            this.logger.warn('Push subscribe failed:', error);
          });
        },
        preparePushPermission: () => {
          this._push.prepare().catch((error) => {
            this.logger.warn('Push prepare failed:', error);
          });
        },
      },
      // Share the network client so in-app's own fetches carry the
      // X-Joryio-Auth header and can trigger a token refresh on a 401.
      this.network,
      {
        canSend: () => this.canSend(),
        requestTimeoutMs: this.config.requestTimeout,
        syncIntervalMs: this.config.inApp.syncInterval,
        evaluationMode: this.config.inApp.evaluationMode,
        noteStatus: (status, data) => {
          this.network.noteSuspended(status, data);
        },
      },
    );

    // Without this the setter is never called and the flag is permanently
    // false, so every HTML campaign is refused with no way to opt in.
    this.inapp.setAllowHtmlJsInAppMessages(this.config.inApp.allowHtmlJsInAppMessages);

    // Initialize user object for subscription management
    this._user = new User(
      this.logger,
      this.network,
      this.identity,
      this.config.apiEndpoint,
      (label, record) => this.runWrite(label, record),
    );

    // Web push manager. No prompt ever happens here; on init it only refreshes
    // a subscription the visitor already granted (see syncExistingSubscription).
    this._push = new PushManager(
      this.logger,
      this.network,
      this.identity,
      this.config.apiEndpoint,
      {
        canSend: () => this.canSend(),
        // A server-side unregister is a withdrawal (contract item 36), sent
        // even while ingestion is paused - the server accepts it.
        canWithdraw: () => this.isInitialized && !this.disabled,
        withdrawalUserId: () => this.effectiveUserId(),
        storage: this.storage,
        getDeviceId: () => this.deviceId,
        // The new permission is reported now, not on the next page load.
        onSubscribeSettled: () => this.reportPushPermissionIfChanged(),
      },
    );

    // A Session Start that was on the wire when an opt-out / denial cleared
    // the queue: its answer decides whether this session still owes one (rule 90).
    this.queue.setClearedInflightCallback((delivered) => {
      const sessionId = this.inflightSessionStartAtClear;
      if (!sessionId) return;
      this.inflightSessionStartAtClear = null;
      const stored = delivered.some((e) => e.type === 'Session Start' && e.sessionId === sessionId);
      if (!stored && this.storage.get<string>(SESSION_START_SENT_KEY) === sessionId) {
        this.storage.set(SESSION_START_SENT_KEY, '');
      }
    });

    // Set up queue flush callback
    this.queue.setFlushCallback(async (events, identify) => {
      try {
        return await this.flushEvents(events, identify);
      } finally {
        // A logged-out user's token lives as long as their leftovers (D-a).
        this.scheduleRetiredTokenPrune();
      }
    });

    // Decisions made before init (the snippet's queue) take effect NOW,
    // before anything below can send under the state they replace.
    PRE_INIT_BASELINE.set(this, { optedOut: this.userOptedOut, consent: this.trackingConsent });
    for (const decision of preInit || []) this.applyPreInitDecision(decision);

    this.recomputePrivacy();
    if (this.isOptedOut) {
      this.logger.warn('Tracking is off (opt-out, Do Not Track or consent denied)');
    }
    this.queue.setPaused(this.consentPending);
    if (this.isOptedOut) {
      // Events persisted by an earlier page view must not go out after a
      // refusal either.
      this.queue.clear();
    }

    // Attribute writes not acknowledged on an earlier page view.
    this.restoreAttributeWrites();

    // Page unload: hand what is queued to the browser (fetch keepalive).
    if (!this.disabled && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.boundHandlePageUnload = this.handlePageUnload.bind(this);
      window.addEventListener('pagehide', this.boundHandlePageUnload);
      window.addEventListener('beforeunload', this.boundHandlePageUnload);
      // Back online: retry now instead of waiting out the backoff.
      this.boundHandleOnline = () => {
        this.queue.resetBackoff();
        if (this.canSend()) {
          this.queue.flush().catch((error) => this.logger.error('Flush failed:', error));
        }
        // Profile writes and withdrawals that failed while offline.
        this.outbox.kick();
        this._push.retryPendingUnregister();
        // Attribute writes waiting out their own backoff, too.
        if (!this.identity.pending.isEmpty() && this.canSend()) {
          this.attributeFailures = 0;
          if (this.attributeFlushTimer !== null) {
            clearTimeout(this.attributeFlushTimer);
            this.attributeFlushTimer = null;
          }
          this.scheduleAttributeFlush(0);
        }
      };
      window.addEventListener('online', this.boundHandleOnline);
      // Another tab of the site opted out, changed consent, logged out or
      // identified: this tab follows at once instead of at its next reload.
      this.boundHandleStorage = (event: any) => this.handleStorageEvent(event);
      window.addEventListener('storage', this.boundHandleStorage);
    }

    // Load plugins
    if (!this.disabled) {
      this.loadPlugins().catch((error) => this.logger.error('Plugin load failed:', error));
    }

    this.isInitialized = true;
    // An inert instance is not THE instance: a later, correct `new JoryioSDK()`
    // must get a working SDK rather than this one.
    if (!this.disabled) JoryioSDK.instance = this;
    this.logger.info('SDK initialized successfully');

    // Report permission state now the SDK is live. Only sends on a change.
    this.reportPushPermissionIfChanged();

    // Enqueue Session Start BEFORE starting the queue auto-flush timer.
    // This ensures Session Start is the first event sent, even if there are
    // persisted events from a previous page load (queue.start() flushes those immediately).
    let sessionStartSent = false;
    // A pre-init wipeData() cleared the session: the fresh visitor's starts
    // here (announced below, with its Session Start).
    this.session.ensureSession();
    if (this.config.trackSessionStart && !this.isOptedOut) {
      const sessionInfo = this.session.getSessionInfo();
      // A new session, or one whose Session Start was never queued (tracking
      // was off when it began) - but never a second one for a session that
      // already has it (a cold start resuming an unexpired session).
      // (No marker at all = stored by an earlier SDK version: treated as sent.)
      const startedFor = this.storage.get<string>(SESSION_START_SENT_KEY);
      const startPending = startedFor !== null && startedFor !== sessionInfo.sessionId;
      if (sessionInfo.isNewSession || shouldResetSession || startPending) {
        // While consent is pending this only QUEUES it (the queue is paused):
        // it goes out first when consent is granted and is discarded if it is
        // denied.
        this.trackSessionStart();
        sessionStartSent = true;
      }
    }

    // Only track initial Page View if Session Start was NOT sent
    // (Session Start includes landing page, backend creates initial Page View from it)
    if (this.config.trackPageViews && !this.isOptedOut && !sessionStartSent) {
      this.trackPageView();
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            this.trackPageView();
          },
          { once: true },
        );
      }
    }

    // Register callback for when session expires and a new one is created (e.g., tab becomes visible after inactivity).
    // Must be registered BEFORE queue.start() to avoid missing a session change that occurs during startup.
    this.session.onNewSession(() => {
      if (this.isOptedOut) return;
      if (this.config.trackSessionStart) {
        this.logger.debug('New session created (mid-visit), tracking session start');
        this.trackSessionStart();
      }
      // A new session is a sync point in both evaluation modes.
      this.resyncInApp();
    });

    // Start sending AFTER Session Start is enqueued, so it's included in the
    // first flush along with any persisted events from previous page loads.
    if (this.canSend()) {
      this.queue.start();

      // Initialize in-app messaging if enabled
      if (this.config.inApp.enabled) {
        this.inapp.initialize().catch((error) => {
          this.logger.error('Failed to initialize in-app messaging:', error);
        });
      }

      // A subscription the browser rotated, or one bound to an old VAPID key,
      // is re-registered here - nothing else ever did. (After a pre-init
      // wipeData() this only tells the server about the unsubscribe: the
      // browser stays unsubscribed until push.subscribe().)
      this._push.syncExistingSubscription().catch(() => undefined);

      // Held on an earlier page view while consent was pending, granted now.
      this.releaseHeldWrites();
    }
    this.syncWorkerReporting();

    // An identify() made while tracking was off on an earlier page view, now
    // that it is allowed (D-b).
    if (!this.isOptedOut) this.releaseDeferredIdentify();

    // The opt-out marker, if the switch changed since the server last heard
    // (an `optOut: true` in the config or a pre-init optOut() included).
    this.syncOptOutMarker();
    this.scheduleRetiredTokenPrune();
    // Withdrawals go whatever the tracking state; the rest when allowed.
    this.outbox.kick();
    this._push.retryPendingUnregister();
  }

  /** The persisted outbox, wired to this SDK's privacy state and identity. */
  private createOutbox(): WriteOutbox {
    return new WriteOutbox({
      storage: this.storage,
      logger: this.logger,
      gate: (entry) => {
        if (!this.isInitialized || this.disabled) return 'hold';
        // A withdrawal goes even while ingestion is paused (402): the server
        // accepts it (owner decision 2026-10-06).
        if (entry.withdrawal) return 'send';
        if (this.network.isSuspended()) return 'hold';
        if (this.isOptedOut) return 'drop';
        if (this.consentPending) return 'hold';
        return 'send';
      },
      resolveOwner: (owner) => this.resolveOwner(owner),
      ownerIsCurrentUser: (owner) => (owner.userId || null) === this.effectiveUserId(),
      currentIdentity: () => ({ anonymousId: this.identity.getAnonymousId(), userId: this.effectiveUserId() }),
      send: (entry, owner) => this.sendWrite(entry.record, owner),
      beforeSend: () => this.flushQueueForWrite(),
      isSdkAuthError: (status, data) => this.network.isSdkAuthError(status, data),
      onSettled: (entry, outcome) => {
        this.onWriteSettled(entry, outcome);
        this.scheduleRetiredTokenPrune();
      },
      keepalive: (entry, owner) => {
        const request = this.writeRequest(entry.record, owner);
        const json = JSON.stringify(request.body);
        if (!this.network.postKeepalive(request.url, request.body)) return null;
        return utf8Length(json) + 256;
      },
    });
  }

  /** Who a write is about right now: the current ids. */
  private currentOwner(): WriteOwner {
    const userId = this.effectiveUserId();
    return { anonymousId: this.identity.getAnonymousId(), ...(userId ? { userId } : {}) };
  }

  /**
   * The user withdrawals are made for: the one identify() named while
   * tracking was off (D-b), else the identified user.
   */
  private effectiveUserId(): string | null {
    return this.withdrawalUserId || this.identity.getUserId();
  }

  /**
   * identify() while consent is denied or the visitor opted out (D-b): the
   * user id is kept on this device ONLY - nothing is sent, tracked or written
   * to a profile - so a later unsubscribe or opt-out reaches that person
   * rather than an orphan anonymous profile. The normal identify runs when
   * tracking is allowed again.
   */
  private deferIdentify(userId: string): void {
    if (userId === this.effectiveUserId()) return;
    // The previous user's SDK-auth token stays with the previous user (rule 53).
    this.network.switchUser(userId);
    this.withdrawalUserId = userId === this.identity.getUserId() ? null : userId;
    if (this.withdrawalUserId) this.storage.set(WITHDRAWAL_USER_KEY, this.withdrawalUserId);
    else this.storage.remove(WITHDRAWAL_USER_KEY);
    this.logger.debug('Tracking is off: identify kept on this device for withdrawals only, not sent');
  }

  /** Tracking is allowed again: run the identify that was kept (D-b). */
  private releaseDeferredIdentify(): void {
    const userId = this.withdrawalUserId;
    if (!userId) return;
    this.forgetDeferredIdentify();
    this.identify(userId);
  }

  private forgetDeferredIdentify(): void {
    this.withdrawalUserId = null;
    this.storage.remove(WITHDRAWAL_USER_KEY);
  }

  /**
   * Coalesced: forget the retired tokens of users with nothing left queued
   * (D-a). `delayMs`: a token kept only by its grace period is looked at again.
   */
  private scheduleRetiredTokenPrune(delayMs: number = 0): void {
    if (this.pruneTimer !== null || this.disabled) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      this.pruneRetiredTokens();
    }, delayMs);
  }

  private pruneRetiredTokens(): void {
    try {
      if (!this.network.retiredSdkAuthUsers().length) return;
      const users = new Set<string>();
      // The signed-in and the held (D-b) user's kept token is never "nothing
      // left": they are the ones who may still need it (same on iOS and Android).
      const current = this.network.getCurrentUserId();
      if (current) users.add(current);
      if (this.withdrawalUserId) users.add(this.withdrawalUserId);
      for (const e of this.queue.getQueuedEvents()) if (e.userId) users.add(e.userId);
      for (const i of this.queue.getPendingIdentifies()) users.add(i.userId);
      for (const r of this.outbox.records()) {
        const userId = (r.payload as any).userId;
        if (typeof userId === 'string' && userId) users.add(userId);
      }
      for (const e of this.identity.pending.serialize()) if (e.owner?.userId) users.add(e.owner.userId);
      for (const u of this._push.pendingUnregisterUsers()) users.add(u);
      // ...and what EVERY tab persisted (rule 62): this tab's memory is not
      // the whole picture - another tab may hold the logged-out user's
      // unsubscribe, and once that tab reloads the stored token is all it has.
      for (const key of PERSISTED_ITEM_KEYS) collectUserIds(this.storage.get<unknown>(key), users);
      const wait = this.network.forgetRetiredSdkAuthTokensExcept(users);
      if (wait !== null) this.scheduleRetiredTokenPrune(wait + 50);
    } catch (error) {
      this.logger.warn('Could not prune stored SDK authentication tokens:', error);
    }
  }

  /**
   * A `storage` event: another tab of this site changed what this one holds
   * in memory (contract item 5 - "enforced on every write path" covers every
   * tab). Opt-out and consent are re-read; a changed identity (a reset() or
   * identify() over there) is adopted.
   */
  private handleStorageEvent(event: any): void {
    try {
      if (!this.isInitialized || this.disabled || !event) return;
      const key: string | null = event.key ?? null;
      const watched = (name: string) => key === null || key === this.storage.storageKeyFor(name);

      if (key === null) {
        // localStorage.clear() by another tab or script (common at logout).
        // Nothing stored any more is not a decision: an opt-out or a denial
        // held here is never lifted without an explicit grant (rule 62) -
        // and it is stored again, so the next page view keeps it too. With
        // the time it was DECIDED: an explicit grant or opt-in the clearing
        // tab makes after the clear is newer, and wins (rule 77).
        this.repersistPrivacyDecisions();
        // This tab's waiting writes (withdrawals among them) are stored
        // again too, so they survive this tab closing.
        this.outbox.persistNow();
      } else if (
        watched(OPT_OUT_KEY) ||
        watched(OPT_OUT_AT_KEY) ||
        watched(OPT_IN_SIGNAL_KEY) ||
        watched(CONSENT_KEY) ||
        watched(CONSENT_DENIED_AT_KEY) ||
        watched(CONSENT_GRANT_SIGNAL_KEY)
      ) {
        const optedOut = this.storedOptOut();
        const denied = this.storedDenial();
        if (optedOut) this.optedOutAt = this.storedStamp(OPT_OUT_AT_KEY);
        if (denied) this.consentDeniedAt = this.storedStamp(CONSENT_DENIED_AT_KEY);
        this.noteDecisionStamps();
        let changed = false;
        if (optedOut !== this.userOptedOut) {
          this.userOptedOut = optedOut;
          changed = true;
        }
        if (denied && this.trackingConsent !== 'denied') {
          this.trackingConsent = 'denied';
          changed = true;
        } else if (!denied && this.trackingConsent === 'denied') {
          // The other tab lifted the denial (only 'granted' does).
          this.trackingConsent = 'granted';
          changed = true;
        } else if (
          !denied &&
          this.trackingConsent === 'pending' &&
          watched(CONSENT_GRANT_SIGNAL_KEY) &&
          this.storage.get<number>(CONSENT_GRANT_SIGNAL_KEY) !== null
        ) {
          // The visitor answered the banner in another tab: 'pending' is not
          // stored, so this tab hears the grant through its signal.
          this.trackingConsent = 'granted';
          changed = true;
        }
        // The marker was queued by the tab that made the change.
        if (changed) this.applyPrivacyState();
      }

      if (key !== null && watched(WITHDRAWAL_USER_KEY)) {
        // Another tab kept (or forgot) a user for withdrawals (D-b, rule 77):
        // the next unsubscribe made HERE goes to that person too, with that
        // person's token - not to the user this tab still had in memory.
        const stored = this.storage.get<string>(WITHDRAWAL_USER_KEY);
        const held = typeof stored === 'string' && stored && stored !== this.identity.getUserId() ? stored : null;
        if (held !== this.withdrawalUserId) {
          this.network.switchUser(held || this.identity.getUserId());
          this.withdrawalUserId = held;
        }
      }

      if (key !== null && watched(SESSION_ID_KEY) && this.awaitingSessionOf) {
        // The session the other tab started at its logout, stored after its
        // new anonymous id (scan 7 N4).
        if (this.awaitingSessionOf === this.identity.getAnonymousId() && this.storage.get<string>(SESSION_ID_KEY)) {
          this.session.followStoredSession();
        }
        this.awaitingSessionOf = null;
      }

      if (watched(ANONYMOUS_ID_STORAGE_KEY) || watched(USER_ID_STORAGE_KEY)) {
        const anonymousId = this.storage.get<string>(ANONYMOUS_ID_STORAGE_KEY);
        const userId = this.storage.get<string>(USER_ID_STORAGE_KEY) || null;
        if (!anonymousId) return;
        if (anonymousId === this.identity.getAnonymousId() && userId === this.identity.getUserId()) return;
        this.logger.info('Another tab changed the visitor identity; following it');
        const loggedOut = anonymousId !== this.identity.getAnonymousId();
        // The same bookkeeping reset() / identify() does here (rule 62):
        // in-app first (dismissed as the outgoing user, with their token)...
        if (this.config.inApp.enabled) this.inapp.clearAll();
        else this.inapp.invalidate();
        // ...writes made while this anonymous id was anonymous stay with the
        // user it became, not the next visitor...
        this.pinAnonymousWrites();
        this.network.switchUser(userId);
        this.identity.adopt(anonymousId, userId);
        // Whoever was kept for withdrawals here belongs to the old identity.
        this.withdrawalUserId = null;
        if (loggedOut) {
          // ...and the next visitor's events belong to the session the other
          // tab started for them, not the outgoing visitor's. reset() over
          // there stores the new session AFTER the new anonymous id, so it
          // is followed again when it arrives.
          this.utm.reset();
          this.session.followStoredSession();
          this.awaitingSessionOf = anonymousId;
        }
        this.resyncInApp(true);
      }
    } catch (error) {
      this.logger.error('Could not follow a change made in another tab:', error);
    }
  }

  /**
   * Store this tab's opt-out and denial again (after another tab cleared
   * storage), each with the time it was decided - not now.
   */
  private repersistPrivacyDecisions(): void {
    if (this.userOptedOut && this.storage.get<boolean>(OPT_OUT_KEY) !== true) this.writeOptOut(this.optedOutAt);
    if (this.trackingConsent === 'denied' && this.storage.get<string>(CONSENT_KEY) !== 'denied') {
      this.writeDenial(this.consentDeniedAt);
    }
    if (this.withdrawalUserId && this.storage.get<string>(WITHDRAWAL_USER_KEY) !== this.withdrawalUserId) {
      this.storage.set(WITHDRAWAL_USER_KEY, this.withdrawalUserId);
    }
  }

  /** A stored decision time (0 when absent or unreadable). */
  private storedStamp(key: string): number {
    const value = this.storage.get<number>(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /** Remember the decision times stored by any tab, so the next one is later. */
  private noteDecisionStamps(): void {
    for (const key of [OPT_OUT_AT_KEY, OPT_IN_SIGNAL_KEY, CONSENT_DENIED_AT_KEY, CONSENT_GRANT_SIGNAL_KEY]) {
      this.lastDecisionStamp = Math.max(this.lastDecisionStamp, this.storedStamp(key));
    }
  }

  /** A time for an explicit decision made now: later than any decision seen. */
  private nextDecisionStamp(): number {
    this.noteDecisionStamps();
    this.lastDecisionStamp = Math.max(
      Date.now(),
      this.lastDecisionStamp + 1,
      this.optedOutAt + 1,
      this.consentDeniedAt + 1,
    );
    return this.lastDecisionStamp;
  }

  /** The stored opt-out, unless a newer explicit opt-in is stored (rule 77). */
  private storedOptOut(): boolean {
    if (this.storage.get<boolean>(OPT_OUT_KEY) !== true) return false;
    return !(this.storedStamp(OPT_IN_SIGNAL_KEY) > this.storedStamp(OPT_OUT_AT_KEY));
  }

  /** The stored denial, unless a newer explicit grant is stored (rule 77). */
  private storedDenial(): boolean {
    if (this.storage.get<string>(CONSENT_KEY) !== 'denied') return false;
    return !(this.storedStamp(CONSENT_GRANT_SIGNAL_KEY) > this.storedStamp(CONSENT_DENIED_AT_KEY));
  }

  /** Store an opt-out decided at `at` (now when omitted). */
  private writeOptOut(at?: number): void {
    const stamp = at === undefined ? this.nextDecisionStamp() : at;
    this.optedOutAt = stamp;
    this.storage.set(OPT_OUT_KEY, true);
    this.storage.set(OPT_OUT_AT_KEY, stamp);
  }

  /** An explicit opt-in: the opt-out goes, and other tabs hear it (even after a clear). */
  private writeOptIn(): void {
    // Stamped BEFORE the opt-out's own time is forgotten: later than it.
    const stamp = this.nextDecisionStamp();
    this.optedOutAt = 0;
    this.storage.remove(OPT_OUT_KEY);
    this.storage.remove(OPT_OUT_AT_KEY);
    this.storage.set(OPT_IN_SIGNAL_KEY, stamp);
  }

  /** Store a denial decided at `at` (now when omitted). */
  private writeDenial(at?: number): void {
    const stamp = at === undefined ? this.nextDecisionStamp() : at;
    this.consentDeniedAt = stamp;
    this.storage.set(CONSENT_KEY, 'denied');
    this.storage.set(CONSENT_DENIED_AT_KEY, stamp);
  }

  /**
   * An explicit grant: the denial goes, and other tabs hear it (the signal:
   * a 'pending' tab stores nothing to hear a change of).
   */
  private writeGrant(): void {
    // Stamped BEFORE the denial's own time is forgotten: later than it.
    const stamp = this.nextDecisionStamp();
    this.consentDeniedAt = 0;
    this.storage.remove(CONSENT_KEY);
    this.storage.remove(CONSENT_DENIED_AT_KEY);
    this.storage.set(CONSENT_GRANT_SIGNAL_KEY, stamp);
  }

  /**
   * The ids a write is SENT with (contract item 38). Its own user id when it
   * had one; otherwise the current user id - once the server has merged the
   * captured anonymous id into that user (no identify of it is still
   * waiting). Under SDK authentication an anonymous write for an anonymous id
   * that was already identified is refused (403 SDK_ANONYMOUS_ID_IDENTIFIED),
   * so a newsletter opt-in made just before sign-up was lost.
   */
  private resolveOwner(owner: WriteOwner): WriteOwner {
    if (owner.userId) return owner;
    // The user kept for withdrawals (D-b) counts (rule 63): an unsubscribe
    // queued as anonymous just before identify('B') while denied reaches B.
    const userId = this.effectiveUserId();
    if (!userId || owner.anonymousId !== this.identity.getAnonymousId()) return owner;
    const identifyWaiting = this.queue.getPendingIdentifies().some((i) => i.anonymousId === owner.anonymousId);
    return identifyWaiting ? owner : { anonymousId: owner.anonymousId, userId };
  }

  /**
   * Before the identity changes (reset, wipe, identify of another user):
   * writes made while the current anonymous id was anonymous belong to the
   * user it became, and must keep going to that user - not to the next one,
   * and not as an anonymous write of an id that was identified.
   */
  private pinAnonymousWrites(): void {
    const userId = this.identity.getUserId();
    if (!userId) return;
    const anonymousId = this.identity.getAnonymousId();
    this.identity.pending.pinOwner(anonymousId, userId);
    this.persistAttributeWrites();
    this.outbox.pinOwner(anonymousId, userId);
  }

  /** The request one write is sent as. */
  private writeRequest(record: WriteRecord, owner: WriteOwner): { url: string; body: any } {
    const endpoint = this.config.apiEndpoint;
    const ids = { ...(owner.userId ? { userId: owner.userId } : {}), anonymousId: owner.anonymousId };
    switch (record.kind) {
      case 'alias':
        return { url: `${endpoint}/v1/alias/add`, body: { ...record.payload, ...ids } };
      case 'subscription':
        return { url: `${endpoint}/v1/subscriptions/channel`, body: { ...record.payload, ...ids } };
      case 'group':
        return { url: `${endpoint}/v1/subscriptions/group`, body: { ...record.payload, ...ids } };
      case 'marker':
      default:
        return {
          url: `${endpoint}/v1/attributes`,
          body: {
            ...(owner.userId ? { userId: owner.userId } : { anonymousId: owner.anonymousId }),
            ...this.markerOps(record as Extract<WriteRecord, { kind: 'marker' }>),
          },
        };
    }
  }

  /** The opt-out marker's attribute write: the switch's value, `true` or `false`. */
  private markerOps(record: Extract<WriteRecord, { kind: 'marker' }>): AttributeOps {
    const desired = record.payload.value;
    return { attributes: { [TRACKING_OPTED_OUT_ATTRIBUTE]: desired } };
  }

  private sendWrite(record: WriteRecord, owner: WriteOwner): Promise<NetworkResponse> {
    const endpoint = this.config.apiEndpoint;
    const ids = { ...(owner.userId ? { userId: owner.userId } : {}), anonymousId: owner.anonymousId };
    switch (record.kind) {
      case 'alias':
        return this.network.sendAddAlias(endpoint, { ...record.payload, ...ids });
      case 'subscription':
        return this.network.sendSubscriptionUpdate(endpoint, { ...record.payload, ...ids });
      case 'group':
        return this.network.sendSubscriptionGroupUpdate(endpoint, { ...record.payload, ...ids });
      case 'marker':
      default:
        return this.network.sendSetAttributes(
          endpoint,
          this.markerOps(record as Extract<WriteRecord, { kind: 'marker' }>),
          owner.userId,
          owner.anonymousId,
        );
    }
  }

  /** Bookkeeping when a write leaves the outbox. */
  private onWriteSettled(entry: OutboxEntry, outcome: 'done' | 'drop'): void {
    if (entry.record.kind !== 'marker') return;
    const value = entry.record.payload.value;
    if (outcome === 'done') {
      if (value) this.storage.set(REPORTED_OPT_OUT_KEY, true);
      else this.storage.remove(REPORTED_OPT_OUT_KEY);
      this.storage.remove(OPT_OUT_MARKER_GIVEN_UP_KEY);
    } else {
      this.storage.set(OPT_OUT_MARKER_GIVEN_UP_KEY, value);
    }
    // The switch may have flipped again while this was on the wire.
    this.syncOptOutMarker();
  }

  /**
   * Tell the push service worker whether it may report deliveries and clicks.
   * It may not whenever the page may not send: an opt-out, but equally
   * consent denied or pending and Do Not Track. Only the explicit opt-out
   * used to be written, so a visitor who denied consent - or whose browser
   * sends Do Not Track - still had every push delivery and click reported.
   */
  private syncWorkerReporting(): void {
    // An inert instance must not touch the worker's flag: a valid instance on
    // the same origin owns it.
    if (this.disabled) return;
    this._push.setTrackingOptedOut(this.isOptedOut || this.consentPending).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Privacy state
  // ---------------------------------------------------------------------------

  /**
   * The consent in force at init (contract item 24):
   *  - explicit `granted` lifts a stored denial;
   *  - explicit `denied` is stored;
   *  - explicit `pending` holds for this page view, never over a stored denial;
   *  - unset: a stored denial, else granted (a site without a banner).
   */
  private initialConsent(configured: TrackingConsent | undefined): TrackingConsent {
    const storedDenied = this.storedDenial();
    if (configured === 'granted') {
      this.storage.remove(CONSENT_KEY);
      this.storage.remove(CONSENT_DENIED_AT_KEY);
      return 'granted';
    }
    if (configured === 'denied') {
      this.writeDenial();
      return 'denied';
    }
    if (storedDenied) {
      this.consentDeniedAt = this.storedStamp(CONSENT_DENIED_AT_KEY);
      return 'denied';
    }
    return configured === 'pending' ? 'pending' : 'granted';
  }

  /** Record a consent answer: the same rules for init, pre-init calls and updateConsent(). */
  private storeConsent(consent: TrackingConsent): TrackingConsent {
    if (consent === 'granted') {
      this.writeGrant();
      return 'granted';
    }
    if (consent === 'denied') {
      this.writeDenial();
      return 'denied';
    }
    // `pending` is for this page view only and never lifts a stored denial.
    if (this.storedDenial()) {
      this.logger.info("updateConsent('pending') ignored: consent was denied, and only 'granted' lifts that");
      return 'denied';
    }
    return 'pending';
  }

  /** One decision from before init, applied before any side effect. */
  private applyPreInitDecision(decision: PreInitDecision): void {
    try {
      switch (decision.method) {
        case 'optOut':
          this.userOptedOut = true;
          this.writeOptOut();
          break;
        case 'optIn':
          this.userOptedOut = false;
          this.writeOptIn();
          break;
        case 'updateConsent':
          if (decision.consent === 'granted' || decision.consent === 'denied' || decision.consent === 'pending') {
            this.trackingConsent = this.storeConsent(decision.consent);
          }
          break;
        case 'wipeData':
          // Push first, while the outgoing ids are still current (it
          // captures them); it is told to the server once sending starts.
          this._push.forget().catch(() => undefined);
          this.wipeLocalState();
          // The wipe came first; the init config's user id - and its SDK
          // authentication token, which the wipe retired with the erased
          // identity - apply after it. Without the token that user's
          // requests went out unauthenticated until the host's auth
          // handler minted a new one.
          if (this.config.userId) {
            this.identity.identify(this.config.userId);
            this.network.setCurrentUserId(this.config.userId);
          }
          if (this.config.enableSdkAuthentication && this.config.sdkAuthenticationToken) {
            this.network.setSdkAuthenticationToken(this.config.sdkAuthenticationToken);
          }
          break;
      }
    } catch (error) {
      this.logger.error(`Applying ${decision.method} from before init failed:`, error);
    }
  }

  /**
   * The current consent: `granted`, `denied` or `pending`. Independent of the
   * visitor's own opt-out (see isUserOptedOut()).
   */
  getTrackingConsent(): TrackingConsent {
    return this.trackingConsent;
  }

  /**
   * Whether the visitor opted out (optOut(), or `optOut: true` at init).
   * Reflects ONLY that switch - not consent, not Do Not Track.
   */
  isUserOptedOut(): boolean {
    return this.userOptedOut;
  }

  /**
   * Keep the profile's `tracking_opted_out` in step with the opt-out switch
   * (contract items 33 and 36): queued when it CHANGES - including a decision
   * made in the init config or before init - and not at all while unchanged.
   *
   * `true` is a WITHDRAWAL: queued in the persisted outbox and delivered even
   * while opted out (that is the point), with consent denied or pending, and
   * after wipeData() - with the ids of the person who opted out. `false`
   * (opting back in) is an ordinary write and waits for tracking to be
   * allowed. Retried by the one rule (contract item 40); a value refused for
   * good is not re-sent on every page view (a fresh optOut() or optIn() call
   * clears that and tries again).
   */
  private syncOptOutMarker(): void {
    if (this.disabled || !this.isInitialized) return;
    const desired = this.userOptedOut;
    const reported = this.storage.get<boolean>(REPORTED_OPT_OUT_KEY) === true;
    const anonymousId = this.identity.getAnonymousId();
    const queuedLast = this.outbox.findLast(
      (e) => e.record.kind === 'marker' && e.record.payload.anonymousId === anonymousId,
    );
    if (queuedLast) {
      if (queuedLast.record.kind === 'marker' && queuedLast.record.payload.value === desired) return;
      if (desired === reported && !this.outbox.isInFlight(queuedLast)) {
        // Flipped back before it was sent: nothing to tell the server.
        this.outbox.cancel((e) => e.record.kind === 'marker' && e.record.payload.anonymousId === anonymousId);
        return;
      }
    } else {
      if (desired === reported) return;
      if (this.storage.get<boolean>(OPT_OUT_MARKER_GIVEN_UP_KEY) === desired) return;
    }
    this.outbox.enqueue({ kind: 'marker', payload: { value: desired, ...this.currentOwner() } });
  }

  private recomputePrivacy(): void {
    this.isOptedOut = this.disabled || this.userOptedOut || this.dntEnabled || this.trackingConsent === 'denied';
    this.consentPending = !this.isOptedOut && this.trackingConsent === 'pending';
  }

  /** May anything leave the device right now? */
  private canSend(): boolean {
    return (
      this.isInitialized &&
      !this.isOptedOut &&
      !this.consentPending &&
      !this.network.isSuspended()
    );
  }

  /**
   * Bring every component in line with the current opt-out / consent state.
   * The one place that starts and stops collection, so opt-out, consent and
   * opt-in cannot each stop a different subset of it.
   */
  private applyPrivacyState(): void {
    const wasOptedOut = this.isOptedOut;
    const wasPending = this.consentPending;
    this.recomputePrivacy();
    this.syncWorkerReporting();
    if (wasOptedOut !== this.isOptedOut || wasPending !== this.consentPending) {
      // In-app answers requested under the previous state are stale.
      this.inapp.invalidate();
    }

    if (this.isOptedOut) {
      // Collect nothing - and keep nothing that was waiting to be sent. A
      // Session Start that never left goes too, so a later grant sends one -
      // also a grant passed at init on a later page view: the marker says
      // "none queued for any session yet" (''), never absent, which init
      // reads as "sent" (rule 85, the sibling of the wipe fix, rule 75).
      //
      // Only one still WAITING in the queue (rule 90). One already on the
      // wire is settled by the server's answer: stored = sent (the marker
      // keeps this session), anything else = owed ('').
      const sessionId = this.session.getSessionId();
      const isStart = (e: QueuedEvent) => e.type === 'Session Start' && e.sessionId === sessionId;
      if (this.queue.getWaitingEvents().some(isStart)) {
        this.storage.set(SESSION_START_SENT_KEY, '');
      } else if (sessionId && this.queue.getInflightEvents().some(isStart)) {
        this.inflightSessionStartAtClear = sessionId;
      }
      this.queue.stop();
      this.queue.clear();
      this.queue.setPaused(false);
      this.clearPendingAttributeWrites();
      // Every profile write stops - except withdrawals (an unsubscribe, the
      // opt-out marker), which are always delivered (contract item 36).
      this.outbox.discardNonWithdrawals();
      this.outbox.kick();
      if (this.config.inApp.enabled) this.inapp.stop();
      return;
    }

    // Collection is allowed again (granted or pending). An identify() made
    // while it was off now runs normally (D-b) - FIRST, so what follows is
    // about that user, not the one signed in before (rule 63)...
    if (wasOptedOut) this.releaseDeferredIdentify();
    // ...then a session that began while it was off gets its Session Start
    // (scan 3, web #10).
    if (wasOptedOut) this.trackSessionStartIfMissing();

    if (this.consentPending) {
      // Collect, hold, send nothing.
      this.queue.stop();
      this.queue.setPaused(true);
      if (this.config.inApp.enabled) this.inapp.stop();
      return;
    }

    // Granted: release what was held, in order - the queue (Session Start
    // first, then events, with any identify), then attributes and other writes.
    this.queue.setPaused(false);
    if (!this.queue.isStarted()) this.queue.start();
    this.queue.flush().catch((error) => this.logger.error('Flush failed:', error));

    this.releaseHeldWrites();

    if (this.config.inApp.enabled) {
      this.inapp.initialize().catch((error) => {
        this.logger.error('Failed to initialize in-app messaging:', error);
      });
    }
    this._push.syncExistingSubscription().catch(() => undefined);
  }

  /** Send the attribute and profile writes held while consent was pending. */
  private releaseHeldWrites(): void {
    if (!this.identity.pending.isEmpty()) {
      this.scheduleAttributeFlush(0);
    }
    this.outbox.kick();
  }

  /**
   * Queue a profile write (alias, subscription, group) in the outbox. A
   * withdrawal (unsubscribe) is always accepted; anything else is refused
   * while opted out or consent is denied, and held while it is pending.
   */
  private runWrite(label: string, record: WriteRecord): void {
    if (!this.isInitialized || this.disabled) {
      this.logger.error(`${label}: SDK not initialized`);
      return;
    }
    if ((this.isOptedOut || this.dataGate.size > 0) && !isWithdrawal(record)) {
      this.logger.debug(`${label} not sent: tracking is off`);
      return;
    }
    // A withdrawal made after identify() while tracking was off goes to the
    // user that identify() named (D-b), not to the anonymous profile.
    if (this.withdrawalUserId && isWithdrawal(record) && record.payload.anonymousId === this.identity.getAnonymousId()) {
      record = { ...record, payload: { ...record.payload, userId: this.withdrawalUserId } } as WriteRecord;
    }
    this.outbox.enqueue(record);
  }

  /**
   * Bring back the attribute writes an earlier page view did not get
   * acknowledged. Discarded if the visitor opted out or consent was denied.
   */
  private restoreAttributeWrites(): void {
    const attrs = this.storage.get<{ entries?: unknown; ops?: AttributeOps | null; increment?: Record<string, number> }>(ATTRIBUTE_WRITES_KEY);
    if (this.isOptedOut) {
      this.storage.remove(ATTRIBUTE_WRITES_KEY);
      this.outbox.discardNonWithdrawals();
      return;
    }
    if (attrs && typeof attrs === 'object') {
      if (Array.isArray(attrs.entries)) {
        this.identity.pending.restore(attrs.entries);
      } else {
        // Stored by an earlier version: { ops, increment }.
        if (attrs.ops && typeof attrs.ops === 'object') this.identity.pending.mark(attrs.ops);
        if (attrs.increment && typeof attrs.increment === 'object') this.identity.pending.mark({ increment: attrs.increment });
      }
    }
  }

  /**
   * The attribute writes not acknowledged yet survive a navigation (contract
   * item 37). Kept only until the server acknowledges them.
   */
  private persistAttributeWrites(): void {
    if (this.identity.pending.isEmpty()) {
      this.storage.remove(ATTRIBUTE_WRITES_KEY);
      return;
    }
    this.storage.set(ATTRIBUTE_WRITES_KEY, { entries: this.identity.pending.serialize() });
  }

  /**
   * Before a profile write: get the queued events and any identify to the
   * server first, so the contact the write addresses exists and is merged.
   */
  private async flushQueueForWrite(): Promise<void> {
    if (!this.canSend()) return;
    if (this.queue.getPendingIdentify() || this.queue.getQueueSize() > 0) {
      await this.queue.flush().catch(() => undefined);
    }
  }

  /**
   * Track session start event (internal)
   * Includes landing page data so backend can create initial Page View
   */
  private trackSessionStart(): void {
    this.logger.debug('Tracking session start');

    // Track Session Start event
    // Note: sessionCount is managed server-side by counting Session Start events
    // This ensures accurate cross-device session counting
    const properties: Record<string, any> = {};

    if (this.config.trackDeviceProperties) {
      Object.assign(properties, getDeviceProperties());
      properties.$device_id = this.deviceId;
    }

    // Include page data for backend to create initial Page View
    if (typeof window !== 'undefined' && window.location) {
      properties.landing_page = window.location.href;
      properties.landing_path = window.location.pathname;
      properties.landing_search = window.location.search;
      properties.landing_title = typeof document !== 'undefined' ? document.title : '';
      properties.landing_referrer = typeof document !== 'undefined' ? (document.referrer || null) : null;
    }

    this.track('Session Start', properties);
    this.storage.set(SESSION_START_SENT_KEY, this.session.getSessionId());
  }

  /** Queue this session's Session Start if it never was (tracking was off when it began). */
  private trackSessionStartIfMissing(): void {
    if (!this.config.trackSessionStart || this.isOptedOut) return;
    // No session (after wipeData()): starting one announces it, with its
    // Session Start, through onNewSession.
    this.session.ensureSession();
    if (this.storage.get<string>(SESSION_START_SENT_KEY) === this.session.getSessionId()) return;
    this.trackSessionStart();
  }

  private getOrCreateDeviceId(): string {
    const key = 'device_id';
    const existing = this.storage.get<string>(key);
    if (existing) {
      return existing;
    }

    const deviceId = generateUUID();
    this.storage.set(key, deviceId);
    return deviceId;
  }

  private trackPageView(): void {
    if (typeof window === 'undefined' || !window.location) {
      return;
    }

    const url = window.location.href;
    if (this.lastTrackedUrl === url) {
      return;
    }

    const properties: Record<string, any> = {
      url,
      path: window.location.pathname,
      search: window.location.search,
      title: typeof document !== 'undefined' ? document.title : '',
    };

    if (this.config.trackPageProperties && typeof document !== 'undefined') {
      properties.referrer = document.referrer || null;
      properties.landing_page = this.utm.getSessionLandingPage() || null;
    }

    this.lastTrackedUrl = url;
    this.track('Page Viewed', properties);
  }

  /**
   * Track an event
   */
  track(eventName: string, properties?: Record<string, any>): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('track')) return;

    if (this.isOptedOut) {
      this.logger.debug('Tracking disabled, event not tracked:', eventName);
      return;
    }

    // Refused here, not by the server: an empty or over-long name is a 400,
    // and a 400 used to re-queue the whole batch at the front forever.
    // Exactly the server's rule (isValidSdkEventName): 1-255 characters. A
    // whitespace-only name is accepted there, so it is not refused here.
    if (typeof eventName !== 'string' || eventName.length < 1 || eventName.length > MAX_NAME_LENGTH) {
      this.logger.error(`track() needs an event name of 1-${MAX_NAME_LENGTH} characters; event dropped`);
      return;
    }

    try {
      // An idle session ends HERE too, not only when the tab becomes visible
      // again: a tab left open and visible for an hour kept one session
      // forever (scan 3, web #5). The new session's Session Start (from the
      // session's onNewSession hook) is queued BEFORE this event.
      if (eventName !== 'Session Start') this.session.refreshIfExpired();
      // No session at all (after wipeData()): one starts here, with its
      // Session Start queued first (rule 54 - reads never start one).
      this.session.ensureSession();

      // Update session activity on every tracked event
      this.session.updateActivity();

      // Shallow-copy the caller's properties before injecting internal keys so we
      // never mutate the object the caller passed (they may reuse it).
      const eventProperties: Record<string, any> =
        properties && typeof properties === 'object' && !Array.isArray(properties) ? { ...properties } : {};

      // Merge event properties with UTM parameters if enabled
      if (this.config.captureUTM) {
        Object.assign(eventProperties, this.utm.getUTMProperties());
      }

      // Always include device_id in event properties for tracking
      if (this.deviceId && !eventProperties.$device_id) {
        eventProperties.$device_id = this.deviceId;
      }

      const event: QueuedEvent = {
        eventId: generateUUID(), // Client-generated ID for idempotency
        type: eventName,
        properties: eventProperties,
        // ISO 8601 UTC with milliseconds, the same on every SDK (rule 55).
        timestamp: new Date().toISOString(),
        userId: this.identity.getUserId(),
        anonymousId: this.identity.getAnonymousId(),
        sessionId: this.session.getSessionId(),
      };

      // Run beforeTrack hooks (web-only plugin API)
      let processedEvent: any = event;
      for (const plugin of this.config.plugins) {
        if (plugin.beforeTrack) {
          try {
            processedEvent = plugin.beforeTrack(processedEvent);
          } catch (error) {
            this.logger.error(`Plugin ${plugin.name} beforeTrack threw; event kept unchanged:`, error);
          }
          if (processedEvent === null) {
            this.logger.debug(`Event blocked by plugin: ${plugin.name}`);
            return;
          }
        }
      }

      // A property whose value JSON cannot carry (NaN, Infinity, a BigInt,
      // a function, a circular object) is dropped with a warning; the event
      // goes without it (rule 49).
      if (processedEvent && processedEvent.properties && typeof processedEvent.properties === 'object') {
        processedEvent = {
          ...processedEvent,
          properties: withoutUnsendableValues(processedEvent.properties, (key, why) =>
            this.logger.warn(`Event "${eventName}": property "${key}" dropped - ${why}`),
          ),
        };
      }

      // Refused here, not by the server: properties over the API's limits
      // are refused for good, so sending them only costs a request
      // (contract item 29).
      const problem =
        processedEvent && processedEvent.properties && typeof processedEvent.properties === 'object'
          ? eventPropertiesProblem(processedEvent.properties)
          : null;
      if (problem) {
        this.logger.error(`Event "${eventName}" dropped: ${problem}`);
        return;
      }

      // Add to queue
      this.queue.enqueue(processedEvent);

      // Show anything waiting on this event - locally, with no round trip.
      // AFTER enqueue, deliberately: the event is data and must be recorded
      // whether or not it triggers a message, and a throwing display path must
      // not lose the event. Triggering is a display decision, not a substitute
      // for analytics.
      if (this.canSend()) {
        try {
          this.inapp?.onEventTracked(eventName, eventProperties);
        } catch (error) {
          this.logger.error('In-app trigger evaluation failed:', error);
        }
      }

      // Run afterTrack hooks
      for (const plugin of this.config.plugins) {
        if (plugin.afterTrack) {
          try {
            plugin.afterTrack(processedEvent);
          } catch (error) {
            this.logger.error(`Plugin ${plugin.name} afterTrack threw:`, error);
          }
        }
      }

      // Send immediately if configured
      if (this.config.sendImmediately && this.canSend()) {
        this.flush().catch((error) => this.logger.error('Immediate flush failed:', error));
      }
    } catch (error) {
      // Never throw into the host page.
      this.logger.error('track() failed:', error);
    }
  }

  /**
   * Identify a user.
   *
   * Sends queued events AND identify data in a single atomic HTTP request.
   * The backend processes events first, then merges the anonymous user —
   * guaranteed ordering eliminates the Session Start race condition.
   */
  identify(userId: string): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    if (typeof userId !== 'string' || !userId.trim() || userId.length > MAX_NAME_LENGTH) {
      this.logger.error(`identify() needs a userId of 1-${MAX_NAME_LENGTH} characters`);
      return;
    }

    if (this.isOptedOut) {
      if (!this.disabled) this.deferIdentify(userId);
      return;
    }
    // An explicit identify replaces any user kept for withdrawals (rule 63).
    if (this.withdrawalUserId) this.forgetDeferredIdentify();

    const previousUserId = this.identity.getUserId();
    const anonymousId = this.identity.getAnonymousId();

    // Store identify intent — the next flush will include it in the batch request
    this.queue.setPendingIdentify({
      userId,
      anonymousId,
      attributes: {},
    });

    // Update local identity immediately so subsequent track() calls use the new userId
    const switching = !!previousUserId && previousUserId !== userId;
    if (switching) {
      this.pinAnonymousWrites();
      // A's message on screen is A's: dismissed (tracked as A, with A's
      // token) before anything else changes, like reset() does.
      if (this.config.inApp.enabled) this.inapp.clearAll();
    }
    this.identity.identify(userId);
    // identify('B') while A was signed in, without reset(), is a reset for
    // the token too (rule 53): A's token is retired to A's queued items, so
    // they go out with A's token instead of B's - unless the token already
    // set is B's own. Also keeps the user id for auth-failure reporting.
    this.network.switchUser(userId);
    // In-app answers requested for the previous identity are stale.
    if (previousUserId !== userId) this.inapp.invalidate();

    if (!this.canSend()) return; // consent pending: sent when granted

    // Force flush — sends { events: [...], identify: {...} } in one request,
    // then ask for this person's in-app campaigns (an SPA never reloads, so
    // nothing else would).
    void this.queue
      .flush(false, true)
      .catch((error) => {
        this.logger.error('Failed to flush with identify:', error);
      })
      .then(() => {
        // After a switch the in-app state was cleared: start it again.
        if (previousUserId !== userId) this.resyncInApp(switching);
      });
  }

  /**
   * Add a labelled alias (e.g. `addAlias('crm_id', 'C-123')`) to this visitor.
   *
   * Works for anonymous visitors as well as identified ones: the request
   * carries `anonymousId` always and `userId` once identified.
   */
  addAlias(aliasLabel: string, aliasName: string): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('addAlias')) return;

    if (typeof aliasLabel !== 'string' || !aliasLabel.trim() || typeof aliasName !== 'string' || !aliasName.trim()) {
      this.logger.error('addAlias(aliasLabel, aliasName) needs two non-empty strings');
      return;
    }

    // Captured now, so a reset() before the request goes out cannot move the
    // alias onto the next visitor.
    const userId = this.identity.getUserId();
    const payload = {
      anonymousId: this.identity.getAnonymousId(),
      ...(userId ? { userId } : {}),
      aliasLabel,
      aliasName,
    };

    this.runWrite('addAlias', { kind: 'alias', payload });
  }

  /**
   * Set user attributes
   */
  setAttributes(attributes: Record<string, any>): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('setAttributes')) return;

    // Validate that attributes is a plain object
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
      this.logger.error('setAttributes requires a plain object, e.g. setAttributes({ email: "user@example.com" })');
      return;
    }

    // A null (or undefined) value UNSETS the attribute - the same on every
    // platform (contract addendum 19). Sent as a `$set` of null it stored a
    // literal null on web while the native SDKs removed the key, so one call
    // produced two different profiles.
    const set: Record<string, any> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      if (!key) continue;
      if (value === null || value === undefined) {
        unset.push(key);
        continue;
      }
      // A value JSON cannot carry would block every later attribute write
      // (each request carries the oldest write of every key): that key is
      // dropped with a warning, the others go (rule 49).
      const problem = valueProblem(value);
      if (problem) {
        this.logger.warn(`Attribute "${key}" not set: its value is ${problem}`);
        continue;
      }
      set[key] = value;
    }

    this.identity.setAttributes(set);
    for (const key of unset) this.identity.unsetAttribute(key);

    // Send to backend for both identified and anonymous users.
    // setAttributes → absolute `$set` section; null values → `$unset`.
    if (!this.isOptedOut && (Object.keys(set).length || unset.length)) {
      this.sendAttributesAfterPendingIdentify({
        ...(Object.keys(set).length ? { attributes: set } : {}),
        ...(unset.length ? { unset } : {}),
      });
    }
  }

  /**
   * Queue an attribute-operations payload. It is sent after a short debounce,
   * and only once any pending identify has reached the server - otherwise the
   * write hits /attributes before the anon→identified merge and lands on the
   * wrong profile. Applies to every attribute op (set / increment / append /
   * remove / unset).
   */
  private sendAttributesAfterPendingIdentify(ops: AttributeOps): void {
    // Coalesce a burst into one request. Six setAttributes calls on page load
    // should be one round trip, not six.
    //
    // Every write lands in the ordered log (PendingAttributes) in call order:
    // two addToArray calls on one key both reach the server, and a later
    // write to a key never shares a request with - or overtakes - an earlier
    // one (contract item 31). Increments are summed while they wait.
    this.identity.pending.mark(ops, this.currentOwner());
    this.persistAttributeWrites();
    this.scheduleAttributeFlush(JoryioSDK.ATTRIBUTE_FLUSH_DEBOUNCE_MS);
  }

  private scheduleAttributeFlush(delayMs: number): void {
    if (this.attributeFlushTimer !== null) return;
    this.attributeFlushTimer = setTimeout(() => {
      this.attributeFlushTimer = null;
      // Consent pending (or sending suspended): keep everything for when it
      // may be sent.
      if (!this.canSend()) return;
      this.flushAttributeOps();
    }, delayMs);
  }

  /** Drop every attribute write not yet sent (opt-out, consent denied, reset). */
  private clearPendingAttributeWrites(): void {
    if (this.attributeFlushTimer !== null) {
      clearTimeout(this.attributeFlushTimer);
      this.attributeFlushTimer = null;
    }
    this.identity.pending.clear();
    // An answer still on its way belongs to the store just emptied.
    this.attributeGeneration++;
    this.attributeFlushInFlight = false;
    this.attributeFlushAgain = false;
    this.attributeFailures = 0;
    this.storage.remove(ATTRIBUTE_WRITES_KEY);
  }

  /**
   * Send the next request's worth of attribute writes: the oldest pending
   * write of every key. Serialized - one request at a time - and repeated
   * until the log is empty. scheduleAttributeFlush is the normal entry point.
   */
  private flushAttributeOps(): void {
    const pendingIdentify = this.queue.getPendingIdentify();
    const ready = pendingIdentify ? this.queue.flush(false, true).catch(() => undefined) : Promise.resolve();
    void ready.then(() => {
      // Opted out meanwhile: applyPrivacyState cleared the store. Pending
      // consent / suspended: everything stays for later.
      if (!this.canSend()) return;
      if (this.queue.getPendingIdentify()) {
        // The identify has not reached the server yet (offline, backing off).
        // Sending now would write onto the anonymous profile; wait instead.
        this.scheduleAttributeFlush(this.attributeRetryDelay());
        return;
      }

      // Serialize + coalesce. A call arriving mid-flight raises a flag, and
      // one follow-up flush covers everything it added.
      if (this.attributeFlushInFlight) {
        this.attributeFlushAgain = true;
        return;
      }
      const request = this.identity.pending.nextRequest((o) => this.resolveOwner(o ?? this.currentOwner()));
      if (!request) return;
      this.attributeFlushInFlight = true;
      const generation = this.attributeGeneration;
      const { ops, entries } = request;
      // The ids of the person who made these writes (contract items 31, 38).
      const owner = this.resolveOwner(request.owner ?? this.currentOwner());

      this.network.sendSetAttributes(
        this.config.apiEndpoint,
        ops,
        owner.userId,
        owner.anonymousId,
      ).then((res: NetworkResponse) => {
        if (generation !== this.attributeGeneration) return; // cleared meanwhile (opt-out, wipe)
        // Acknowledge ONLY on success. `request()` never throws - it resolves
        // `{ ok: false }` - so the old `.then(ack)` acknowledged every FAILED
        // write too, and the "durable" attribute queue silently dropped them.
        const verdict = classifyWriteResponse(res, {
          isSdkAuthError: this.network.isSdkAuthError(res.status, res.data),
          ownerIsCurrentUser: (owner.userId || null) === this.identity.getUserId(),
        });
        if (verdict.action === 'done') {
          this.attributeFailures = 0;
          this.identity.pending.acknowledge(entries);
          this.persistAttributeWrites();
          const permission = ops.attributes?.[PUSH_PERMISSION_ATTRIBUTE];
          if (typeof permission === 'string') this.storage.set(REPORTED_PUSH_PERMISSION_KEY, permission);
          if (this.identity.pending.hasUnsent()) this.attributeFlushAgain = true;
          this.scheduleRetiredTokenPrune();
          return;
        }
        if (verdict.action === 'drop') {
          // Refused for good (400/403/413/422), or an SDK-auth 401 of a user
          // who is no longer signed in: retrying would fail forever and hold
          // every later write to these keys behind it. Only THIS request's
          // writes are dropped (contract items 28, 39, 40).
          this.logger.error(`Attributes dropped: ${verdict.reason}`, res.error);
          this.identity.pending.drop(entries);
          this.persistAttributeWrites();
          if (this.identity.pending.hasUnsent()) this.attributeFlushAgain = true;
          this.scheduleRetiredTokenPrune();
          return;
        }
        // An increment is lost only when its request MAY have been applied
        // (no answer, a 5xx): a repeated $inc then double-counts. A clear
        // refusal (401/402/429, success: false) applied nothing.
        const ambiguous = !res.softFailure && (res.status === 0 || res.status >= 500);
        const lost = this.identity.pending.release(entries, ambiguous);
        if (lost > 0) {
          this.logger.error(
            `Failed to send attributes (HTTP ${res.status || 'no response'}); ${lost} increment(s) are LOST `
              + '(an $inc cannot be safely retried).',
          );
        }
        if (verdict.action === 'hold') {
          this.persistAttributeWrites();
          this.logger.error(`Attributes not sent: ${verdict.reason}; they are kept for the next page view.`);
          return;
        }
        // Retry. Offline, 429 and 5xx never count toward the cap; a
        // refusal that can heal (success: false, a 401 for the current
        // user) counts, at most WRITE_MAX_ATTEMPTS times (contract item 40).
        if (verdict.counts) {
          const exhausted = entries.filter((e) => {
            e.attempts = (e.attempts || 0) + 1;
            return e.attempts >= WRITE_MAX_ATTEMPTS;
          });
          if (exhausted.length) {
            this.logger.error(`Attributes failed (HTTP ${res.status}) too many times; dropping them`);
            this.identity.pending.drop(exhausted);
          }
        }
        this.persistAttributeWrites();
        this.logger.warn(`Failed to send attributes (HTTP ${res.status || 'no response'}); will retry`);
        this.attributeFailures++;
        this.scheduleAttributeFlush(Math.max(this.attributeRetryDelay(), Math.min(verdict.retryAfterMs ?? 0, 5 * 60 * 1000)));
      }).then(() => {
        if (generation !== this.attributeGeneration) return;
        this.attributeFlushInFlight = false;
        if (this.attributeFlushAgain) {
          this.attributeFlushAgain = false;
          this.flushAttributeOps();
        }
      // The tail of the chain needs its own handler: anything thrown by the
      // bookkeeping above - or by the recursive flushAttributeOps - would
      // otherwise be an unhandled rejection in the host page.
      }).catch((error) => {
        if (generation === this.attributeGeneration) this.attributeFlushInFlight = false;
        this.logger.error('Attribute flush bookkeeping failed:', error);
      });
    });
  }

  private attributeRetryDelay(): number {
    const n = Math.max(1, this.attributeFailures);
    return Math.min(5000 * Math.pow(2, n - 1), 5 * 60 * 1000);
  }

  /**
   * Report notification-permission state as a user attribute, but ONLY when it
   * changed since we last reported it.
   *
   * Same reserved key and the SAME VALUES as iOS and Android
   * (`granted | denied | not_determined | unavailable`), so one segment
   * definition covers every platform. The public API names the states
   * `notDetermined` / `unavailable` (PushPermissionState); the attribute keeps
   * the snake_case wire value.
   *
   * Change-detection matters: attributes are not deduplicated server-side, so
   * reporting unconditionally would spend a request on every page load.
   */
  private reportPushPermissionIfChanged(): void {
    if (!this.isInitialized || this.isOptedOut) return;
    try {
      const state = this._push.getPermissionState();
      const current = state === 'notDetermined' ? 'not_determined' : state;
      // The marker records what the SERVER acknowledged, and is written when
      // the attribute write is acknowledged (see flushAttributeOps). It used
      // to be written here, before anything was sent: a write held by pending
      // consent, refused, or lost with the page was never reported again.
      if (this.storage.get<string>(REPORTED_PUSH_PERMISSION_KEY) === current) return;
      this.logger.debug(`Push permission changed to ${current}; reporting`);
      this.setAttribute(PUSH_PERMISSION_ATTRIBUTE, current);
    } catch (error) {
      this.logger.warn('Could not report push permission:', error);
    }
  }

  /**
   * Set a single attribute
   */
  setAttribute(key: string, value: any): void {
    if (typeof key !== 'string' || !key) {
      this.logger.error('setAttribute(key, value) needs a non-empty key');
      return;
    }
    this.setAttributes({ [key]: value });
  }

  /**
   * Increment a numeric attribute
   */
  incrementAttribute(key: string, value: number = 1): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('incrementAttribute')) return;
    if (typeof key !== 'string' || !key || typeof value !== 'number' || !Number.isFinite(value)) {
      this.logger.error('incrementAttribute(key, value) needs a key and a finite number');
      return;
    }

    // In-memory optimistic echo only (for in-session getAttribute read-back).
    this.identity.incrementAttribute(key, value);

    // Send the DELTA as an atomic `$inc` op — never a locally-computed
    // absolute — so concurrent tabs/devices don't clobber the counter.
    if (!this.isOptedOut) {
      this.sendAttributesAfterPendingIdentify({ increment: { [key]: value } });
    }
  }

  /**
   * Unset an attribute
   */
  unsetAttribute(key: string): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('unsetAttribute')) return;
    if (typeof key !== 'string' || !key) {
      this.logger.error('unsetAttribute() needs a non-empty attribute key');
      return;
    }

    this.identity.unsetAttribute(key);

    // Send an atomic `$unset` op (waits for any pending identify first).
    if (!this.isOptedOut) {
      this.sendAttributesAfterPendingIdentify({ unset: [key] });
    }
  }

  /**
   * Add a value to an array attribute
   */
  addToArray(key: string, value: any): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('addToArray')) return;
    if (typeof key !== 'string' || !key) {
      this.logger.error('addToArray() needs a non-empty attribute key');
      return;
    }

    const problem = valueProblem(value);
    if (problem) {
      this.logger.warn(`addToArray("${key}") ignored: the value is ${problem}`);
      return;
    }

    // In-memory optimistic echo only (for in-session getAttribute read-back).
    this.identity.addToArray(key, value);

    // Send an atomic `$addToSet` op with just the added value — not the whole
    // recomputed array — so concurrent writers don't clobber the set.
    if (!this.isOptedOut) {
      this.sendAttributesAfterPendingIdentify({ append: { [key]: value } });
    }
  }

  /**
   * Remove a value from an array attribute
   */
  removeFromArray(key: string, value: any): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('removeFromArray')) return;
    if (typeof key !== 'string' || !key) {
      this.logger.error('removeFromArray() needs a non-empty attribute key');
      return;
    }

    const problem = valueProblem(value);
    if (problem) {
      this.logger.warn(`removeFromArray("${key}") ignored: the value is ${problem}`);
      return;
    }

    // In-memory optimistic echo only (for in-session getAttribute read-back).
    this.identity.removeFromArray(key, value);

    // Send an atomic `$pull` op with just the removed value — not the whole
    // recomputed array.
    if (!this.isOptedOut) {
      this.sendAttributesAfterPendingIdentify({ remove: { [key]: value } });
    }
  }

  /**
   * Log the current user out: a NEW anonymous id, no user id, nothing of the
   * previous user's left behind.
   *
   * The identity changes SYNCHRONOUSLY, before anything is awaited (contract
   * addendum 16). It used to await a flush first, so the common
   * `reset(); identify('B')` ran identify while the old ids were still in
   * place: identify('B') was queued with user A's anonymousId - which asks the
   * server to merge A's profile into B's, two real customers - and the reset
   * then landed afterwards and set the user id back to null. Nothing queued
   * needs the old ids to still be current: every queued event, and a pending
   * identify, carries its own.
   *
   * It also used to leave the attribute debounce timer and the pending
   * attribute store running (so user A's last writes went out under user B's
   * ids), the in-app retry/delay timers alive, and the browser's push
   * subscription bound to user A on the server - so A's pushes kept arriving
   * on a shared device.
   */
  async reset(): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    this.logger.info('Resetting user identity');

    // --- Synchronous: everything that decides WHO the next call is about ---

    // The outgoing user's attribute and profile writes not acknowledged yet
    // are NOT dropped: each carries its own ids and goes out in order after
    // this (contract items 28 and 37). They used to get one best-effort send
    // here - which skipped any key that already had a request on the wire,
    // and ignored a pending identify - and were then forgotten.

    // In-app FIRST: dismiss (tracked as the outgoing user, with that user's
    // token still the current one), cancel every timer, forget campaigns.
    // After the token was retired the dismissal went without a token, was
    // refused, and fired the host's auth handler for a logged-out user.
    if (this.config.inApp.enabled) {
      this.inapp.clearAll();
    }

    // The previous user's SDK-authentication token is theirs, not the next
    // visitor's (contract item 39): the session forgets it, but it stays bound
    // to the outgoing user so their own queued events and writes still go out
    // authenticated - persisted until the last of them settles (D-a).
    // Leftovers refused with a 401 anyway are dropped, never reported to the
    // host's handler.
    this.network.retireSdkAuthToken();
    // A user kept only for withdrawals (D-b) is logged out too.
    this.forgetDeferredIdentify();

    // New anonymous id, no user id.
    this.pinAnonymousWrites();
    this.identity.reset();
    this.network.setCurrentUserId(this.identity.getUserId());

    // UTM before the session: the new session's Session Start (tracked by the
    // session's onNewSession hook) must not carry the outgoing user's campaign.
    this.utm.reset();
    this.session.resetSession();

    // --- Asynchronous: delivery. Each queued event carries its own ids. ---
    await this.flush().catch(() => undefined);

    if (this.canSend()) {
      // The new anonymous visitor's campaigns, and the push subscription moved
      // to them (force: the identity changed even if the endpoint did not).
      this.resyncInApp(true);
      this._push.syncExistingSubscription(true).catch(() => undefined);
    }
    this.outbox.kick();

    this.logger.info('User identity reset');
  }

  /**
   * Erase everything this SDK keeps about the visitor on this browser - for
   * an erasure request (contract addendum 21): the identity (a new anonymous
   * id, no user id), queued events and a pending identify, pending attribute
   * and profile writes, in-app state and impression history, the session,
   * UTM data, the device id, and the push subscription (unsubscribed in the
   * browser and unregistered on the server; it stays unsubscribed until
   * `push.subscribe()` is called again).
   *
   * KEEPS the opt-out: "delete what you have" is not "start collecting
   * again", and a wipe that silently re-enabled tracking would undo the more
   * important of the two requests. Does not opt anyone out either - that is
   * optOut(). The same split Android and iOS make.
   */
  async wipeData(): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    this.logger.info('Wiping local SDK data');

    // Push first, while the outgoing ids are still current (it captures them).
    const pushWiped = this._push.forget().catch(() => undefined);

    this.wipeLocalState();

    // The fresh visitor starts a fresh session - with its one Session Start
    // when tracking is on (contract item 32).
    this.session.ensureSession();
    this.trackSessionStartIfMissing();

    await pushWiped;
    if (this.canSend()) this.resyncInApp(true);
    this.logger.info('Local SDK data wiped');
  }

  /**
   * The synchronous part of wipeData(), shared with a wipeData() queued
   * before init. Keeps the opt-out and a denied consent: both are decisions,
   * not data.
   */
  private wipeLocalState(): void {
    this.clearPendingAttributeWrites();
    // Withdrawals (unsubscribes, the opt-out marker) stay and are delivered
    // under the ids they were made with (contract item 36).
    this.outbox.discardNonWithdrawals();
    this.storage.remove(REPORTED_PUSH_PERMISSION_KEY);
    // "No Session Start queued for any session yet" - NOT the absence of the
    // marker, which reads as "sent" (rule 75): a wipe while tracking was off,
    // then a reload and a grant, resumed the post-wipe session with no
    // Session Start at all.
    this.storage.set(SESSION_START_SENT_KEY, '');
    this.queue.clear();
    if (this.config.inApp.enabled) {
      this.inapp.clearAll();
    } else {
      this.inapp.invalidate();
    }
    this.inapp.forgetImpressions();

    // The erased user's token, like at reset(): no longer the session's, still
    // bound to their withdrawals waiting in the outbox (the same on every SDK).
    // A token set for a NEXT user (standby) belongs to no one being kept:
    // deleted, not left in localStorage for 30 days (rule 82). Never the
    // erased (or held) user's own token, nor that of anyone with a withdrawal
    // still queued, here or in another tab's stored outbox (rule 89).
    const keepTokens = new Set<string>();
    for (const u of [this.effectiveUserId(), this.identity.getUserId(), this.network.getCurrentUserId()]) {
      if (u) keepTokens.add(u);
    }
    for (const r of this.outbox.records()) {
      const userId = (r.payload as any).userId;
      if (typeof userId === 'string' && userId) keepTokens.add(userId);
    }
    for (const u of this._push.pendingUnregisterUsers()) keepTokens.add(u);
    for (const key of [OUTBOX_KEY, PENDING_UNREGISTER_KEY]) collectUserIds(this.storage.get<unknown>(key), keepTokens);
    this.network.retireSdkAuthToken();
    this.network.dropStandbySdkAuthTokens(keepTokens);
    this.forgetDeferredIdentify();
    this.pinAnonymousWrites();
    this.identity.reset();
    this.network.setCurrentUserId(null);
    this.utm.reset();
    this.session.clear();
    this.lastTrackedUrl = null;
    this.storage.remove('device_id');
    this.deviceId = this.getOrCreateDeviceId();
  }

  /** Ask the server for this visitor's campaigns again (identify, reset, new session). */
  private resyncInApp(fullInit: boolean = false): void {
    if (!this.config.inApp.enabled || !this.canSend()) return;
    const run = fullInit ? this.inapp.initialize() : this.inapp.sync().then(() => undefined);
    run.catch((error) => this.logger.debug('In-app re-sync failed:', error));
  }

  /**
   * Send what is queued now. Skips the SDK's own retry backoff, but never a
   * server's Retry-After (contract item 35).
   */
  async flush(): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    await this.queue.flush(false, true);
  }

  /**
   * Classify one batch response for the queue (see FlushOutcome).
   */
  private async flushEvents(events: QueuedEvent[], identify?: PendingIdentify): Promise<FlushOutcome> {
    if (!this.canSend()) {
      return { status: 'retry' };
    }

    this.logger.debug(`Sending ${events.length} events${identify ? ' + identify' : ''} to backend`);

    const response = await this.network.sendEvents(this.config.apiEndpoint, events, identify);

    // 2xx: `ok`, or `softFailure` when the body says `success: false` - some
    // (or all) events were not stored; `failedIndices` names them, and
    // without it all of them are kept. `rejectedIndices` (either way) names
    // events refused for GOOD: those are dropped, never retried.
    if (response.ok || response.softFailure) {
      const rejectedIndices = Array.isArray(response.data?.rejectedIndices) ? response.data.rejectedIndices : undefined;
      let identifyFailed = false;
      let identifyDropped = false;
      // Offline, 429 and 5xx never count toward the identify's cap (contract item 40).
      let identifyAttemptCounts = true;
      // If identify was included but the backend did not confirm it, send it
      // on its own. Failing that, the queue keeps it: it used to be dropped
      // with a log line, leaving the visitor unmerged for good.
      if (identify && !response.data?.identified && response.softFailure) {
        // The batch itself failed (in part): keep the identify for the retry
        // so it still travels with - and after - the events it follows.
        identifyFailed = true;
      } else if (identify && !response.data?.identified) {
        this.logger.debug('Backend did not confirm atomic identify, falling back to standalone');
        const res = await this.network.sendIdentify(
          this.config.apiEndpoint,
          identify.userId,
          identify.attributes || {},
          identify.anonymousId,
        );
        if (!res.ok) {
          // Retried only when the failure can heal (no answer, 408, 429, 5xx,
          // success: false). A refusal (400, 403, 404, ...) is final - it was
          // retried forever (scan 3, web #8) - and so is an SDK-auth refusal
          // for a user who is no longer the current one.
          const outage = !res.softFailure && (res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500);
          const retryable =
            res.softFailure === true ||
            outage ||
            (res.status === 401 && this.network.isSdkAuthError(res.status, res.data) && identify.userId === this.identity.getUserId()) ||
            res.status === 402;
          if (retryable) {
            this.logger.error('Standalone identify fallback failed; it is kept and retried:', res.error);
            identifyFailed = true;
            identifyAttemptCounts = !outage && res.status !== 402;
          } else {
            this.logger.error(`Standalone identify fallback refused (HTTP ${res.status}); dropping it:`, res.error);
            identifyDropped = true;
          }
        }
      }
      if (response.softFailure) {
        const failedIndices = Array.isArray(response.data?.failedIndices)
          ? response.data.failedIndices
          : events.map((_e, i) => i);
        return { status: 'ok', failedIndices, rejectedIndices, identifyFailed, identifyAttemptCounts, identifyDropped };
      }
      this.logger.debug('Events sent successfully');
      return { status: 'ok', rejectedIndices, identifyFailed, identifyAttemptCounts, identifyDropped };
    }

    return this.classifyFailure(response, events, identify);
  }

  private classifyFailure(response: NetworkResponse, events: QueuedEvent[] = [], identify?: PendingIdentify): FlushOutcome {
    const status = response.status;
    if (status === 400 || status === 413 || status === 422) {
      return { status: 'rejected', httpStatus: status };
    }
    if (status === 401) {
      if (this.network.isSdkAuthError(status, response.data)) {
        // A batch belongs to one user (the queue never mixes them). If that
        // user is no longer the current one, no token for them will ever be
        // set again: a `sub_mismatch` / `missing` refusal is final, and
        // retrying it at the head of the queue blocked every later event of
        // the NEW user (contract item 30).
        // ANY reason (missing, sub_mismatch, expired, invalid): reset()
        // forgot that user's token and no new one will be minted for them
        // (contract item 39).
        const reason = response.data?.reason;
        const batchUser = identify?.userId || events.find((e) => e.userId)?.userId || null;
        if (batchUser && batchUser !== this.identity.getUserId()) {
          return { status: 'dropped', reason: `401 ${reason || 'sdk_authentication_error'}` };
        }
        // The current user's token: the refresh already ran in request();
        // keep the events and try again after a backoff. A refusal, so it
        // counts against an identify riding along (contract item 40).
        return { status: 'retry', counts: true };
      }
      return { status: 'suspended', reason: 'the SDK key was refused (401)' };
    }
    if (status === 402) {
      return { status: 'suspended', reason: 'event ingestion is paused for this workspace (402)' };
    }
    if (status === 403) {
      return { status: 'suspended', reason: 'the request was forbidden (403)' };
    }
    if (status === 0 || status === 408 || status === 429 || status >= 500) {
      return { status: 'retry', retryAfterMs: response.retryAfterMs };
    }
    // Any other 4xx (404, 405, ...): a configuration problem no retry fixes,
    // and dropping the events for it would lose data. Stop and keep them.
    return { status: 'suspended', reason: `the API answered HTTP ${status}` };
  }

  /**
   * Page is going away: hand what is queued to the browser with fetch
   * keepalive, and stop holding ONLY what was actually handed off.
   *
   * This used navigator.sendBeacon with a JSON blob: a credentialed CORS
   * request the API's wildcard CORS must refuse - and since sendBeacon returns
   * true for "queued", the queue, the in-flight batch and the pending identify
   * were all cleared and lost on every navigation.
   */
  private handlePageUnload(): void {
    if (!this.isInitialized) return;
    // Offline: nothing can leave. Everything stays stored for the next page
    // view - a hand-off would only take events out of storage for a request
    // that cannot arrive.
    if (isOffline()) {
      this.queue.persistNow();
      return;
    }
    // Profile writes first - withdrawals even while opted out. They stay
    // stored until acknowledged, so a page that survives sends them again.
    try {
      this.outbox.handOffAtUnload(UNLOAD_WRITES_BUDGET_BYTES);
    } catch (error) {
      this.logger.error('Page-unload write hand-off failed:', error);
    }
    if (!this.canSend() || this.queue.isSuspended() || this.queue.isBackingOff()) {
      // Opted out: nothing to keep. Pending / suspended: keep it all for
      // later. Backing off (the API failed, or asked to wait): a keepalive
      // would most likely fail too, and the events it took would be lost -
      // they stay queued for the next page view (contract item 3).
      this.queue.persistNow();
      return;
    }

    try {
      this.sendAttributesAtUnload();
      // What is left of the browser's 64 KiB keepalive budget - shared by
      // every hand-off of this page, so the second of `beforeunload` and
      // `pagehide` cannot hand off a batch the browser would refuse.
      // (Less the request overhead postKeepalive counts.)
      const budget = Math.max(0, this.network.keepaliveBudget() - 256);

      const events = this.queue.getQueuedEvents();
      const head = this.queue.getPendingIdentify();
      if (events.length === 0 && !head) return;

      if (!this.network.supportsKeepalive()) {
        // The request would die with the page; keep everything for the next one.
        this.queue.persistNow();
        return;
      }

      // One request, within the browser's 64 KiB keepalive budget, and of ONE
      // identity (contract item 30): the first queued event's. The identify
      // rides along only when it belongs with those events. What does not fit
      // stays queued (and persisted) for the next page view.
      const first = events[0];
      const identify =
        head && (!first || (first.anonymousId === head.anonymousId && (!first.userId || first.userId === head.userId)))
          ? head
          : null;
      let bytes = 64 + (identify ? utf8Length(JSON.stringify(identify)) : 0);
      const handed: QueuedEvent[] = [];
      let batchUser: string | null = null;
      for (const event of events) {
        if (first && event.anonymousId !== first.anonymousId) break;
        if (event.userId && batchUser && event.userId !== batchUser) break;
        if (identify && (event.anonymousId !== identify.anonymousId || (event.userId && event.userId !== identify.userId))) break;
        const size = utf8Length(JSON.stringify(event)) + 1;
        if (bytes + size > budget) break;
        handed.push(event);
        if (event.userId) batchUser = event.userId;
        bytes += size;
      }
      if (handed.length === 0 && !identify) {
        this.queue.persistNow();
        return;
      }

      this.logger.debug(`Page unload: handing ${handed.length} of ${events.length} events${identify ? ' + identify' : ''} to keepalive`);
      const pending = this.network.sendEventsKeepalive(this.config.apiEndpoint, handed, identify || undefined);
      if (!pending) {
        this.queue.persistNow();
        return;
      }
      this.queue.markHandedOff(handed, identify);
      // Only matters if the page survives (bfcache, a cancelled unload): a
      // failed hand-off comes back into the queue (event ids make a resend
      // harmless). A refusal (4xx) is left to the normal path's rules.
      pending.then((res) => {
        if (!res.ok && (res.softFailure || res.status === 0 || res.status === 429 || res.status >= 500)) {
          this.queue.takeBack(handed, identify);
        }
      }).catch(() => undefined);
    } catch (error) {
      this.logger.error('Page-unload send failed:', error);
      this.queue.persistNow();
    }
  }

  /**
   * Hand the next attribute request to the browser at unload. The writes stay
   * stored (and are acknowledged on a later page view); only increments are
   * forgotten, since a second $inc would count twice. Returns the bytes used.
   */
  private sendAttributesAtUnload(): number {
    if (this.queue.getPendingIdentify()) return 0; // would land on the anonymous profile
    const request = this.identity.pending.peekRequest((o) => this.resolveOwner(o ?? this.currentOwner()));
    if (!request || !this.network.supportsKeepalive()) return 0;
    try {
      const owner = this.resolveOwner(request.owner ?? this.currentOwner());
      const body = {
        userId: owner.userId || undefined,
        anonymousId: owner.userId ? undefined : owner.anonymousId,
        ...request.ops,
      };
      const pending = this.network.postKeepalive(`${this.config.apiEndpoint}/v1/attributes`, body);
      if (!pending) return 0;
      pending.catch(() => undefined);
      // Handed off: an increment must not go out a second time if the page
      // survives (the idempotent writes stay, harmlessly, until acknowledged).
      this.identity.pending.dropIncrements(request.entries);
      this.persistAttributeWrites();
      return utf8Length(JSON.stringify(body)) + 256;
    } catch {
      return 0; // best-effort
    }
  }

  /**
   * Opt out of tracking - remembered across page loads until optIn().
   *
   * TRACKING consent, not marketing subscription - this does not unsubscribe
   * anyone from email or SMS. Independent of updateConsent(): it never
   * changes the stored consent, and a later `updateConsent('granted')` does
   * not lift it - only optIn() does.
   */
  optOut(): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    this.logger.info('User opted out of tracking');
    this.userOptedOut = true;
    this.writeOptOut();
    /*
     * The marker is queued FIRST, under the current ids: it is a consent
     * RECORD, not tracking, and the only way the server learns this device
     * opted out (a segment excluding opted-out people must catch web users as
     * well as mobile ones). A withdrawal: persisted and delivered whatever
     * happens next (contract item 36).
     */
    this.storage.remove(OPT_OUT_MARKER_GIVEN_UP_KEY);
    this.syncOptOutMarker();
    this.applyPrivacyState();
  }

  /**
   * Opt in to tracking: lifts the visitor's own opt-out. Does not grant
   * consent - a denied consent stays denied until updateConsent('granted').
   */
  optIn(): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    this.logger.info('User opted in to tracking');
    this.userOptedOut = false;
    // A decision made inside a data-gated ready() callback is the visitor's
    // newer choice: the callback's later calls run under it (rule 83) - an
    // opt-out gate only; a denial or the purge stays (rule 92).
    this.liftDataGate('optedOut');
    this.writeOptIn();
    this.applyPrivacyState();
    // And clear it on the way back in, or a person who declined and later
    // accepted would stay excluded by `tracking_opted_out == true` forever.
    this.storage.remove(OPT_OUT_MARKER_GIVEN_UP_KEY);
    this.syncOptOutMarker();
  }

  /**
   * Update tracking consent at runtime (e.g., after user accepts cookie banner).
   *
   * - `granted`: release everything collected while consent was pending
   *   (Session Start, events, attributes, identify, subscriptions, push
   *   registration) and run normally. Lifts a stored denial.
   * - `denied`: collect nothing, and discard what was waiting. Remembered on
   *   later page views until `granted`.
   * - `pending`: collect locally, send nothing - for this page view only, and
   *   never over a stored denial.
   *
   * Independent of optOut(): a visitor who opted out stays opted out whatever
   * the consent banner says.
   */
  updateConsent(consent: TrackingConsent): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (consent !== 'granted' && consent !== 'denied' && consent !== 'pending') {
      this.logger.error(`updateConsent expects 'granted', 'denied' or 'pending', got ${String(consent)}`);
      return;
    }
    this.trackingConsent = this.storeConsent(consent);
    this.config.trackingConsent = this.trackingConsent;
    if (consent === 'granted') this.liftDataGate('denied'); // see optIn()
    this.applyPrivacyState();
    // A marker change that waited for consent goes out once it is granted.
    this.syncOptOutMarker();
  }

  /**
   * Check if Do Not Track is enabled
   */
  private isDoNotTrackEnabled(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return false;
    }

    // Check various DNT implementations
    const dnt = (navigator as any).doNotTrack || (window as any).doNotTrack || (navigator as any).msDoNotTrack;

    return dnt === '1' || dnt === 'yes';
  }

  /**
   * Load plugins
   */
  private async loadPlugins(): Promise<void> {
    for (const plugin of this.config.plugins) {
      try {
        this.logger.debug(`Loading plugin: ${plugin.name} v${plugin.version}`);
        await plugin.load(this);
        this.logger.info(`Plugin loaded: ${plugin.name}`);
      } catch (error) {
        this.logger.error(`Failed to load plugin ${plugin.name}:`, error);
      }
    }
  }

  /**
   * Unload plugins
   */
  private async unloadPlugins(): Promise<void> {
    for (const plugin of this.config.plugins) {
      try {
        this.logger.debug(`Unloading plugin: ${plugin.name}`);
        await plugin.unload();
      } catch (error) {
        this.logger.error(`Failed to unload plugin ${plugin.name}:`, error);
      }
    }
  }

  /**
   * User object for subscription management
   * Use this to update subscription preferences (write-only, no getters for security)
   *
   * @example
   * sdk.user.setSubscription('email', SubscriptionStatus.OPTED_IN);
   * sdk.user.setSubscription('sms', SubscriptionStatus.UNSUBSCRIBED);
   * sdk.user.addToSubscriptionGroup('list_abc123', 'email');
   */
  get user(): User {
    if (!this.isInitialized) {
      // Logged, not thrown: an SDK must never throw into the host page. The
      // object's writes are refused while the SDK is not initialized.
      this.logger?.error('SDK not initialized');
    }
    return this._user;
  }

  /**
   * Web push subscription manager
   *
   * @example
   *   if (sdk.push.isSupported() && sdk.push.getPermissionState() === 'notDetermined') {
   *     button.onclick = () => sdk.push.subscribe();
   *   }
   */
  get push(): PushManager {
    if (!this.isInitialized) {
      this.logger?.error('SDK not initialized');
    }
    return this._push;
  }

  /**
   * E-commerce tracking helper
   * Provides standardized e-commerce event tracking
   *
   * @example
   * // Initialize e-commerce tracking
   * const ecommerce = sdk.ecommerce({ currency: 'USD' });
   *
   * // Track product view
   * ecommerce.viewProduct({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99 });
   *
   * // Track add to cart
   * ecommerce.addToCart({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 });
   *
   * // Track purchase
   * ecommerce.purchase({
   *   orderId: 'ORD123',
   *   items: [{ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 }],
   *   value: 29.99
   * });
   */
  ecommerce(config?: EcommerceConfig): EcommerceTracker {
    if (!this.isInitialized) {
      this.logger?.error('SDK not initialized');
    }

    // Create or return cached instance
    if (!this._ecommerce || config) {
      this._ecommerce = createEcommerceTracker(this, config, this.logger);
    }

    return this._ecommerce;
  }

  /**
   * SDK Authentication — set / refresh the customer-minted JWT.
   *
   * When SDK authentication is enabled (`enableSdkAuthentication: true`), the
   * SDK attaches this token as `X-Joryio-Auth` to every ingest request. Call
   * this on init (or from the failure callback) whenever you mint a fresh JWT.
   */
  setSdkAuthenticationToken(token: string): void {
    if (!this.isInitialized) {
      this.logger?.error('SDK not initialized');
      return;
    }
    if (!this.config.enableSdkAuthentication) {
      this.logger.warn('setSdkAuthenticationToken called but enableSdkAuthentication is false - ignoring');
      return;
    }
    this.network.setSdkAuthenticationToken(token);
  }

  /**
   * SDK Authentication — register a callback fired when the backend rejects the
   * token with a 401 `sdk_authentication_error`. The callback receives the
   * failure reason and the endpoint/user; mint a fresh JWT and either return it
   * (string / Promise<string>) or call setSdkAuthenticationToken(). The failed
   * request is then retried once with the new token.
   */
  setSdkAuthenticationErrorCallback(cb: SdkAuthFailureCallback): void {
    if (!this.isInitialized) {
      this.logger?.error('SDK not initialized');
      return;
    }
    this.network.setSdkAuthenticationFailureCallback(cb);
  }

  /**
   * Get the current anonymous ID.
   *
   * Always present: generated on first init and persisted in localStorage under
   * `jry_<hash(sdkKey)>_anonymous_id`. Stable across calls for the life of the
   * anonymous visitor; `reset()` (logout) regenerates it. This is the exact
   * `anonymousId` attached to every event `track()` sends, so it's the right id
   * to stamp on a consent log or a server-side event for stitching.
   *
   * Async-snippet note: `window.joryio` is the command queue until the SDK
   * finishes loading, and a queued stub can't return a value. Read this after
   * load — call it on the resolved instance (`window.joryio.getAnonymousId()`),
   * or from inside `ready(cb)`.
   */
  getAnonymousId(): string {
    return this.identity ? this.identity.getAnonymousId() : '';
  }

  /**
   * Get the current identified user ID, or `null` if the visitor is still
   * anonymous. Same async-snippet caveat as {@link getAnonymousId}: read it
   * after load (on the instance or inside `ready(cb)`).
   */
  getUserId(): string | null {
    return this.identity ? this.identity.getUserId() : null;
  }

  /**
   * Run a callback once the SDK is loaded and initialized, passing the SDK
   * instance. On the async snippet this is the safe way to read a value that
   * queued stubs can't return before load, e.g.:
   *
   *   joryio.ready(function (sdk) {
   *     var anonId = sdk.getAnonymousId();
   *   });
   *
   * By the time this method exists on the resolved instance the SDK is already
   * initialized, so the callback runs synchronously.
   */
  /**
   * Data calls dropped while non-empty: the synchronous run of a ready() callback
   * the snippet queued while tracking was off (rule 83). It runs at its
   * queue position's privacy state, not the state the later queued
   * decisions produced - its track(), attribute writes, aliases, conversions
   * and non-withdrawal subscription writes are dropped like a queued
   * track() made there (rule 73). Withdrawals, identify() and reads work,
   * and an optIn() / updateConsent('granted') the callback itself makes
   * lifts the matching reason for the rest of it (rule 92).
   */
  private dataGate: Set<DataGateReason> = new Set();

  private liftDataGate(reason: DataGateReason): void {
    if (!this.dataGate.has(reason)) return;
    const next = new Set(this.dataGate);
    next.delete(reason);
    this.dataGate = next;
  }

  /** See setClearedInflightCallback (rule 90). */
  private inflightSessionStartAtClear: string | null = null;

  private isDroppingDataCalls(method: string): boolean {
    if (this.dataGate.size === 0) return false;
    this.logger.debug(`${method}() in a ready() callback queued while tracking was off: dropped`);
    return true;
  }

  ready(callback: (sdk: JoryioSDK) => void): void {
    if (typeof callback !== 'function') {
      this.logger.error('ready(callback) requires a function');
      return;
    }
    try {
      callback(this);
    } catch (error) {
      this.logger.error('Error in ready() callback:', error);
    }
  }

  /**
   * Get current user identity
   */
  getIdentity() {
    return this.identity.getIdentity();
  }

  /**
   * Get current session info
   */
  getSessionInfo() {
    return this.session.getSessionInfo();
  }

  /**
   * Get UTM data (current, first touch, last touch)
   */
  getUTMData() {
    return this.utm.getUTMData();
  }

  /**
   * Manually update UTM parameters (useful for SPAs that change URL without reload)
   */
  updateUTM(): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    this.utm.updateUTM();

    // Check if session should be reset due to new campaign
    if (this.config.resetSessionOnNewCampaign && this.utm.hasNewCampaign()) {
      this.logger.info('New campaign detected, resetting session');
      // resetSession() starts the new session through the session's
      // onNewSession hook, which tracks its Session Start. Tracking one here
      // as well sent every campaign change's Session Start twice.
      this.session.resetSession();
    }
  }

  /**
   * Sync in-app campaigns from backend
   * @param attributeChanges - Optional object with attribute changes for differential sync
   */
  async syncInAppCampaigns(attributeChanges?: Record<string, any>): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    if (!this.config.inApp.enabled) {
      this.logger.warn('In-app messaging is not enabled');
      return;
    }

    if (!this.canSend()) {
      this.logger.debug('Tracking disabled or consent pending, not syncing in-app campaigns');
      return;
    }

    try {
      await this.inapp.sync(attributeChanges);
    } catch (error) {
      this.logger.error('In-app sync failed:', error);
    }
  }

  /**
   * Get all eligible in-app campaigns
   */
  getInAppCampaigns(): InAppCampaign[] {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return [];
    }

    if (!this.config.inApp.enabled) {
      return [];
    }

    return this.inapp.getCampaigns();
  }

  /**
   * Manually display an in-app campaign
   * @param campaignId - Campaign ID to display
   */
  async displayInAppCampaign(campaignId: string): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    if (!this.config.inApp.enabled) {
      this.logger.warn('In-app messaging is not enabled');
      return;
    }

    if (!this.canSend()) {
      this.logger.debug('Tracking disabled or consent pending, not displaying in-app campaign');
      return;
    }

    const campaigns = this.inapp.getCampaigns();
    const campaign = campaigns.find((c) => c.id === campaignId);

    if (!campaign) {
      this.logger.error(`Campaign ${campaignId} not found`);
      return;
    }

    try {
      await this.inapp.displayCampaign(campaign);
    } catch (error) {
      this.logger.error('In-app display failed:', error);
    }
  }

  /**
   * Dismiss an active in-app message
   * @param campaignId - Campaign ID to dismiss
   */
  dismissInAppMessage(campaignId: string): void {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }

    if (!this.config.inApp.enabled) {
      return;
    }

    this.inapp.dismiss(campaignId).catch((error) =>
      this.logger.error('In-app dismiss failed:', error));
  }

  /**
   * Track a conversion event for an in-app campaign
   * @param campaignId - Campaign ID
   * @param eventName - Conversion event name
   */
  async trackInAppConversion(campaignId: string, eventName: string): Promise<void> {
    if (!this.isInitialized) {
      this.logger.error('SDK not initialized');
      return;
    }
    if (this.isDroppingDataCalls('trackInAppConversion')) return;

    if (!this.config.inApp.enabled) {
      this.logger.warn('In-app messaging is not enabled');
      return;
    }

    if (!this.canSend()) {
      this.logger.debug('Tracking disabled or consent pending, not tracking in-app conversion');
      return;
    }

    try {
      await this.inapp.trackConversion(campaignId, eventName);
    } catch (error) {
      this.logger.error('In-app conversion failed:', error);
    }
  }

  /**
   * Destroy the SDK instance
   */
  async destroy(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    this.logger.info('Destroying SDK instance');

    // Send any debounced attributes NOW, then stop the timer.
    //
    // destroy() left this timer running, so a pending 800ms debounce fired
    // after teardown and tried to send from a destroyed SDK - and dropped the
    // attributes if the page went first. Flushing before clearing means a
    // setAttribute immediately followed by destroy() is delivered rather than
    // silently discarded.
    if (this.attributeFlushTimer !== null) {
      clearTimeout(this.attributeFlushTimer);
      this.attributeFlushTimer = null;
      if (this.canSend()) this.flushAttributeOps();
    }
    // Stored writes stay stored (the next page view sends them); only the timers stop.
    this.outbox.destroy();
    this._push.destroy();

    // Remove page listeners
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      if (this.boundHandlePageUnload) {
        window.removeEventListener('pagehide', this.boundHandlePageUnload);
        window.removeEventListener('beforeunload', this.boundHandlePageUnload);
      }
      if (this.boundHandleOnline) {
        window.removeEventListener('online', this.boundHandleOnline);
      }
      if (this.boundHandleStorage) {
        window.removeEventListener('storage', this.boundHandleStorage);
      }
    }
    this.boundHandlePageUnload = null;
    this.boundHandleOnline = null;
    this.boundHandleStorage = null;
    if (this.pruneTimer !== null) {
      clearTimeout(this.pruneTimer);
      this.pruneTimer = null;
    }

    // Flush pending events
    await this.queue.flush().catch(() => undefined);

    // Stop queue
    this.queue.stop();

    // Unload plugins
    await this.unloadPlugins();

    // Cleanup managers
    this.session.destroy();

    // Clear in-app messaging (every timer included)
    this.inapp.clearAll();
    this.inapp.destroy();

    this.isInitialized = false;
    if (JoryioSDK.instance === this) JoryioSDK.instance = null;
    this.logger.info('SDK destroyed');
  }

  /**
   * Get the current SDK instance (if initialized)
   */
  static getInstance(): JoryioSDK | null {
    return JoryioSDK.instance;
  }
}
