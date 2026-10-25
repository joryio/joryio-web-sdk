/**
 * SDK Configuration Types and Defaults
 */

export const SDK_VERSION = '1.3.2'; // keep in sync with package.json — the backend serves this in X-SDK-Version headers
export const DEFAULT_API_ENDPOINT = 'https://api-eu1.joryio.com/api';

/**
 * The API base every request is built on (`<base>/v1/track/batch`).
 *
 * Accepts what customers actually write: a bare host ("api-eu1.joryio.com"),
 * a host with scheme, or the full base with "/api". The backend mounts the
 * SDK routes under its global "api" prefix, so a base with NO path gets
 * "/api" appended - the bare-host form used to produce
 * `https://api-eu1.joryio.com/v1/track/batch`, a 404 on production, and the
 * built-in default was that very form (SDK audit, 2026-09-26). The same rule
 * lives in the iOS and Android SDKs; keep the three identical.
 */
export function normalizeApiEndpoint(raw: string | undefined | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return DEFAULT_API_ENDPOINT;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const noSlash = withScheme.replace(/\/+$/, '');
  try {
    const url = new URL(noSlash);
    if (url.pathname === '' || url.pathname === '/') return `${noSlash}/api`;
  } catch {
    // Not a parseable URL: hand it back untouched and let the request fail loudly.
  }
  return noSlash;
}
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL = 5000; // 5 seconds
/**
 * The shortest `batchFlushInterval` honoured. A smaller value (a typo such as
 * `batchFlushInterval: 5` meaning seconds) would poll the API every few
 * milliseconds; it is raised to this instead (contract item 35).
 */
export const MIN_FLUSH_INTERVAL = 1000;
export const DEFAULT_MAX_QUEUE_SIZE = 1000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 1000;
export const DEFAULT_REQUEST_TIMEOUT = 10000; // 10 seconds
/** In-app periodic re-sync is off unless `inApp.syncInterval` is set; when set, never faster than this. */
export const MIN_INAPP_SYNC_INTERVAL = 30000; // 30 seconds
export const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export interface InAppDisplayOptions {
  /** Where a `custom`-type message sits (other types have their own placement). Default `'center'`. */
  defaultPosition?: 'top' | 'center' | 'bottom';
  /** How messages enter. Default `'fade'`; skipped under `prefers-reduced-motion`. */
  defaultAnimation?: 'fade' | 'slide' | 'none';
  /** Colour of the dim layer behind modal and full-screen messages. Default `'rgba(0, 0, 0, 0.5)'`. */
  backdropColor?: string;
  /** Colour of the close button. Default: the message's own text colour. */
  closeButtonColor?: string;
  /** Stacking order of messages (the backdrop sits one below). Default `999999`. */
  zIndex?: number;
}

export interface InAppOptions {
  // Enable/disable in-app messaging
  enabled?: boolean;

  /**
   * When the SDK asks the server which campaigns this visitor may see.
   *
   * - `differential-sync` (default): on init, on identify()/reset(), on a new
   *   session, when a watched attribute changes, and every `syncInterval` ms
   *   if that is set.
   * - `session-start-only`: on init, on identify()/reset() and on a new
   *   session only - no attribute-change or periodic re-sync.
   */
  evaluationMode?: 'differential-sync' | 'session-start-only';

  /**
   * Periodic re-sync in `differential-sync` mode, in milliseconds. Off (0) by
   * default; any value below 30000 is raised to 30000. Paused while the tab is
   * hidden.
   */
  syncInterval?: number;

  // Display customization
  displayOptions?: InAppDisplayOptions;

  /**
   * Allow HTML in-app messages. OFF by default.
   *
   * What actually happens, because the name alone cannot carry it:
   *
   * - The server keeps the authored HTML as written (only `<base>` and
   *   `<meta http-equiv="refresh">` are removed), so `<script>` and `on*`
   *   handlers reach the browser - and do NOT run: the frame carries a fresh
   *   nonce Content-Security-Policy per message, and only the SDK's bootstrap
   *   has the nonce. Buttons and forms work through that bootstrap
   *   (`data-joryio-action`, `data-jry-form`), not through author script.
   * - The message is rendered in an iframe with `allow-scripts
   *   allow-same-origin`, because the bootstrap runs there (height
   *   reporting, click logging, the host bridge). That frame therefore CAN
   *   execute script, at your page's origin.
   * - So the residual risk is a gap in the CSP (a browser that does not
   *   enforce it): author script would then run with your origin's
   *   privileges. That is why this is opt-in and why the name keeps `Js` -
   *   `allowHtmlInAppMessages` alone would read like a formatting preference.
   *
   * Leaving it off does not disable in-app messaging: NATIVE messages still
   * display, because they are data rendered into DOM text nodes with no
   * interpreter involved. Only HTML campaigns are skipped - and they are
   * skipped without consuming their frequency cap or reporting an impression.
   */
  allowHtmlJsInAppMessages?: boolean;

  // Callback hooks
  onMessageDisplay?: (message: any) => void;
  onMessageClick?: (message: any, action: string) => void;
  /** `action`: how it was dismissed (`close_button`, `backdrop`, `dismiss`, ...). */
  onMessageDismiss?: (message: any, action: string) => void;
}

export interface InitConfig {
  // Required
  sdkKey: string;

  // API Configuration
  apiEndpoint?: string;

  // User Identification
  userId?: string;
  anonymousId?: string;

  // Batching & Performance
  batchSize?: number;
  batchFlushInterval?: number;
  sendImmediately?: boolean;
  maxQueueSize?: number;

  // Session Management
  sessionTimeout?: number; // Session timeout in milliseconds (default: 30 minutes)
  trackSessionStart?: boolean; // Automatically track "Session Start" event on new sessions (default: true)
  trackPageViews?: boolean; // Automatically track "Page Viewed" on page load (default: false)

  // UTM Tracking
  captureUTM?: boolean; // Automatically capture UTM parameters from URL (default: true)
  resetSessionOnNewCampaign?: boolean; // Start new session when campaign changes (default: false)
  trackPageProperties?: boolean; // Include referrer and landing page in events (default: true)
  trackDeviceProperties?: boolean; // Include device info in events (default: true)

  // In-App Messaging
  inApp?: InAppOptions;

  // Storage
  persistQueue?: boolean;

  // Network & Retry
  maxRetries?: number;
  retryBackoffMs?: number;
  requestTimeout?: number;

  // Privacy & GDPR
  respectDoNotTrack?: boolean;
  /**
   * `true` opts this visitor out (persisted, exactly like `optOut()`).
   * `false` or absent leaves a stored opt-out in place - only `optIn()` lifts it.
   */
  optOut?: boolean;
  /**
   * The consent banner's answer. Leave it UNSET when your site has no banner:
   * with nothing stored the SDK then behaves as `granted`, and a `denied`
   * stored by an earlier `updateConsent('denied')` stays in force.
   *
   * - `granted`: an explicit grant - lifts a stored `denied`.
   * - `denied`: stored, and in force on later page views until a grant.
   * - `pending`: this page view only, and never overrides a stored `denied`.
   */
  trackingConsent?: 'granted' | 'denied' | 'pending';

  // SDK Authentication (optional, JWT-based).
  // When enabled the host app supplies a customer-minted JWT which the SDK
  // attaches as `X-Joryio-Auth` to every ingest request and refreshes on a
  // 401 `sdk_authentication_error`. Opt-in — when disabled behaviour is unchanged.
  enableSdkAuthentication?: boolean;
  sdkAuthenticationToken?: string;

  // Debugging
  /** Log everything (`logLevel: 'debug'`) - unless `logLevel` is set too, which then wins. */
  enableDebug?: boolean;
  /**
   * Console logging threshold. Nothing is logged unless this or `enableDebug`
   * is set.
   */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';

  // Plugins (web only)
  plugins?: Array<Plugin>;
}

export interface ResolvedConfig extends Required<Omit<InitConfig, 'userId' | 'plugins' | 'inApp' | 'sdkAuthenticationToken' | 'trackingConsent'>> {
  userId?: string;
  /** Undefined = not set by the app (see InitConfig.trackingConsent). */
  trackingConsent?: 'granted' | 'denied' | 'pending';
  plugins: Array<Plugin>;
  inApp: Required<InAppOptions>;
  // Optional — absent until the host app supplies a token.
  sdkAuthenticationToken?: string;
  /** Whether the logger prints at all: `enableDebug` or an explicit `logLevel`. */
  loggingEnabled: boolean;
}

export interface Plugin {
  name: string;
  version: string;
  load(sdk: any): void | Promise<void>;
  unload(): void | Promise<void>;
  beforeTrack?(event: any): any | null;
  afterTrack?(event: any): void;
}

export interface TrackOptions {
  timestamp?: Date | number;
  sessionId?: string;
  sendImmediately?: boolean;
}

export interface PageProperties {
  path?: string;
  title?: string;
  url?: string;
  referrer?: string;
  search?: string;
  [key: string]: any;
}

export interface EventProperties {
  [key: string]: string | number | boolean | Date | null | undefined;
}

export interface UserTraits {
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  [key: string]: any;
}

/**
 * Keys that belong inside a nested group, listed so a misplaced one can be
 * NAMED rather than ignored.
 *
 * A config key in the wrong place is the worst kind of SDK bug: everything
 * initialises, no error is thrown, and the feature simply never happens. This
 * cost a real integration - `allowHtmlJsInAppMessages: true` was set at the top
 * level on a live site, silently dropped, and every HTML in-app campaign there
 * displayed to nobody. It was only caught because the SDK started reporting its
 * capabilities and the report said `content.native` alone.
 *
 * Warn, never guess. Silently promoting the key into `inApp` would be worse: it
 * would make the working config and the broken one indistinguishable, so the
 * snippet stays wrong everywhere it was copied to.
 */
const NESTED_CONFIG_KEYS: Record<string, string> = {
  allowHtmlJsInAppMessages: 'inApp',
  evaluationMode: 'inApp',
  syncInterval: 'inApp',
  displayOptions: 'inApp',
};

function warnAboutMisplacedKeys(config: InitConfig): void {
  const raw = config as unknown as Record<string, unknown>;
  for (const [key, group] of Object.entries(NESTED_CONFIG_KEYS)) {
    if (raw[key] === undefined) continue;
    // eslint-disable-next-line no-console
    console.warn(
      `[Joryio] \`${key}\` must be nested under \`${group}\`, not passed at the ` +
        `top level - as written it is IGNORED. Use: ` +
        `{ ${group}: { ${key}: ${JSON.stringify(raw[key])} } }`,
    );
  }
  // Removed in 1.3.0 because it never did anything; said out loud rather than
  // left to look like it works.
  if (raw.disablePlugins !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      '[Joryio] `disablePlugins` was removed in 1.3.0 and is ignored - leave a plugin out of `plugins` instead.',
    );
  }
}

export function resolveConfig(config: InitConfig): ResolvedConfig {
  warnAboutMisplacedKeys(config);

  // Resolve in-app options with defaults
  const inAppOptions: Required<InAppOptions> = {
    enabled: config.inApp?.enabled !== false,
    // Defaults to differential-sync, not the removed `client-side`.
    //
    // The old default meant any integration that did not set this explicitly
    // got the one mode that could not personalise - and, after the SDK Liquid
    // engines were dropped, rendered nothing at all.
    evaluationMode:
      config.inApp?.evaluationMode === 'session-start-only' ? 'session-start-only' : 'differential-sync',
    // 0 = no periodic re-sync. A positive value is clamped to the minimum so a
    // typo (`syncInterval: 60` meaning seconds) cannot poll the API every 60 ms.
    syncInterval:
      config.inApp?.syncInterval && config.inApp.syncInterval > 0
        ? Math.max(MIN_INAPP_SYNC_INTERVAL, config.inApp.syncInterval)
        : 0,
    displayOptions: {
      defaultPosition: config.inApp?.displayOptions?.defaultPosition || 'center',
      defaultAnimation: config.inApp?.displayOptions?.defaultAnimation || 'fade',
      backdropColor: config.inApp?.displayOptions?.backdropColor || 'rgba(0, 0, 0, 0.5)',
      // Unset = the close button takes the message's own text colour.
      closeButtonColor: config.inApp?.displayOptions?.closeButtonColor || undefined,
      zIndex: config.inApp?.displayOptions?.zIndex || 999999,
    },
    allowHtmlJsInAppMessages: config.inApp?.allowHtmlJsInAppMessages === true,
    onMessageDisplay: config.inApp?.onMessageDisplay || (() => {}),
    onMessageClick: config.inApp?.onMessageClick || (() => {}),
    onMessageDismiss: config.inApp?.onMessageDismiss || (() => {}),
  };

  return {
    sdkKey: config.sdkKey,
    apiEndpoint: normalizeApiEndpoint(config.apiEndpoint),
    userId: config.userId,
    anonymousId: config.anonymousId || '',
    batchSize: config.batchSize || DEFAULT_BATCH_SIZE,
    batchFlushInterval:
      typeof config.batchFlushInterval === 'number' && config.batchFlushInterval > 0
        ? Math.max(MIN_FLUSH_INTERVAL, config.batchFlushInterval)
        : DEFAULT_FLUSH_INTERVAL,
    sendImmediately: config.sendImmediately || false,
    maxQueueSize: config.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE,
    sessionTimeout: config.sessionTimeout || DEFAULT_SESSION_TIMEOUT,
    trackSessionStart: config.trackSessionStart !== false,
    trackPageViews: config.trackPageViews === true,
    captureUTM: config.captureUTM !== false,
    resetSessionOnNewCampaign: config.resetSessionOnNewCampaign || false,
    trackPageProperties: config.trackPageProperties !== false,
    trackDeviceProperties: config.trackDeviceProperties !== false,
    inApp: inAppOptions,
    persistQueue: config.persistQueue !== false,
    // 0 is a real value ("no immediate retries"), so not `||`.
    maxRetries:
      typeof config.maxRetries === 'number' && config.maxRetries >= 0 ? Math.floor(config.maxRetries) : DEFAULT_MAX_RETRIES,
    retryBackoffMs: config.retryBackoffMs || DEFAULT_RETRY_BACKOFF_MS,
    requestTimeout:
      config.requestTimeout && config.requestTimeout > 0 ? config.requestTimeout : DEFAULT_REQUEST_TIMEOUT,
    respectDoNotTrack: config.respectDoNotTrack !== false,
    optOut: config.optOut === true,
    // NOT defaulted to 'granted': "unset" must stay distinguishable from an
    // explicit grant, because only an explicit grant lifts a stored denial.
    trackingConsent:
      config.trackingConsent === 'granted' || config.trackingConsent === 'denied' || config.trackingConsent === 'pending'
        ? config.trackingConsent
        : undefined,
    enableSdkAuthentication: config.enableSdkAuthentication === true,
    sdkAuthenticationToken: config.sdkAuthenticationToken,
    enableDebug: config.enableDebug || false,
    // `enableDebug: true` alone means debug; an explicit `logLevel` wins (rule 58).
    logLevel: config.logLevel || (config.enableDebug ? 'debug' : 'error'),
    loggingEnabled: config.enableDebug === true || !!config.logLevel,
    plugins: config.plugins || [],
  };
}
