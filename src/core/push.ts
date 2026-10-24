/**
 * Web Push subscription manager.
 *
 * Handles the browser-side dance for opting a user into web push:
 *   1. Verify the browser supports the required APIs.
 *   2. Fetch the VAPID public key from the backend.
 *   3. Register the customer-hosted service worker.
 *   4. Call pushManager.subscribe() with the key.
 *   5. POST the resulting subscription to /v1/push/register so backend
 *      campaigns/canvases can target this browser.
 *
 * The customer must host a `joryio-sw.js` file at the configured path
 * (default: /joryio-sw.js) — browsers enforce same-origin on service
 * workers, so we can't serve the worker from our CDN directly. The file
 * itself is a one-liner that `importScripts()` our worker code from the CDN.
 */

import { NetworkClient } from './network';
import { IdentityManager } from './identity';
import { Logger } from '../utils/logger';
import type { StorageManager } from './storage';
import { classifyWriteResponse, writeAttemptsExhausted, writeRetryDelay } from './write-retry';

/** Last registration this browser sent, so a page load re-registers only on a change. */
const REGISTRATION_MARKER_KEY = 'push_registration';
/**
 * Set by unsubscribe(), cleared only by subscribe(): while it is set nothing
 * re-subscribes or re-registers this browser on a later page load (contract
 * addendum 22). Without it, the next load's syncExistingSubscription() found
 * permission still granted and silently subscribed the browser again.
 */
const UNREGISTERED_KEY = 'push_unregistered';
/**
 * Server-side unregisters not acknowledged yet. A WITHDRAWAL (contract item
 * 36): sent even while opted out, with consent denied or pending, and after
 * wipeData(); retried by the one rule of write-retry.ts. A list (an earlier
 * build stored one object).
 */
export const PENDING_UNREGISTER_KEY = 'push_pending_unregister';

interface PendingUnregister {
  endpoint: string;
  userId?: string;
  anonymousId: string;
  attempts?: number;
  notFoundAttempts?: number;
  failures?: number;
}
/** Re-register an unchanged subscription at most this often (catches server-side pruning). */
const REREGISTER_EVERY_MS = 24 * 60 * 60 * 1000;
/**
 * Where the page leaves the opt-out flag for the service worker. A worker
 * cannot read localStorage; Cache Storage is the one store both can reach.
 */
export const SW_STATE_CACHE = 'joryio-sdk-state';
export const SW_OPT_OUT_URL = '/__joryio/tracking-opted-out';

export interface PushManagerOptions {
  /** False while tracking is opted out / consent is pending: nothing is registered. */
  canSend?: () => boolean;
  /**
   * May a withdrawal (the server-side unregister) be sent? True even while
   * opted out or consent is denied or pending; false only for an inert
   * instance or a suspended workspace.
   */
  canWithdraw?: () => boolean;
  /**
   * The user a withdrawal is made for: the one identify() named while
   * tracking was off (D-b), else the identified user (rule 63).
   */
  withdrawalUserId?: () => string | null;
  storage?: StorageManager;
  /**
   * The SDK's stable per-browser device id, sent with every registration so
   * the subscription lands on this browser's existing device row rather than
   * creating a second one - the same field Android and iOS send.
   */
  getDeviceId?: () => string | undefined;
  /**
   * Called once a subscribe() attempt is over (granted, denied or failed), so
   * the SDK reports the new `push_permission` now rather than on the next
   * page load.
   */
  onSubscribeSettled?: () => void;
}

export interface PushSubscribeOptions {
  /**
   * Path (relative to origin) where the customer has hosted joryio-sw.js.
   * Defaults to '/joryio-sw.js'.
   */
  swPath?: string;
  /**
   * Scope of the service worker registration. Defaults to '/'.
   */
  scope?: string;
}

/**
 * The SAME names on every Joryio SDK (iOS, Android, React Native, Unity, web).
 * The browser says 'default' and has no word for "this browser cannot do
 * push"; those are `notDetermined` and `unavailable` here. The profile
 * attribute `push_permission` uses the snake_case wire value `not_determined`.
 */
export type PushPermissionState = 'granted' | 'denied' | 'notDetermined' | 'unavailable';

export class PushManager {
  private vapidKeyCache: string | null = null;
  // Pre-warmed (VAPID key + registered SW) so the gesture-bound subscribe() does
  // the minimum async work and the OS prompt fires inside the user-activation window.
  private prepared: { registration: ServiceWorkerRegistration; publicKey: string } | null = null;
  // Why the last prepare() failed, so subscribe() (the user-gesture path) can
  // print a specific reason. prepare() itself stays quiet — it also runs as a
  // fire-and-forget pre-warm where console noise would be wrong.
  private lastPrepareError: 'unsupported' | 'no-key' | 'sw-failed' | null = null;

  private readonly canSend: () => boolean;
  private readonly canWithdraw: () => boolean;
  private readonly withdrawalUserId: () => string | null;
  private readonly storage: StorageManager | null;
  private unregisterInFlight = false;
  private unregisterTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly getDeviceId: () => string | undefined;
  private readonly onSubscribeSettled: (() => void) | null;

  constructor(
    private readonly logger: Logger,
    private readonly network: NetworkClient,
    private readonly identity: IdentityManager,
    private readonly apiEndpoint: string,
    options: PushManagerOptions = {},
  ) {
    this.canSend = options.canSend || (() => true);
    this.canWithdraw = options.canWithdraw || (() => true);
    this.withdrawalUserId = options.withdrawalUserId || (() => this.identity.getUserId());
    this.storage = options.storage || null;
    this.getDeviceId = options.getDeviceId || (() => undefined);
    this.onSubscribeSettled = options.onSubscribeSettled || null;
  }

  /**
   * Returns true if this browser can do web push at all. Must be called before
   * any subscribe() attempt — Safari < 16.4, insecure origins, and private
   * browsing modes will all return false.
   */
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  getPermissionState(): PushPermissionState {
    if (!this.isSupported()) return 'unavailable';
    const p = Notification.permission;
    if (p === 'granted' || p === 'denied') return p;
    return 'notDetermined';
  }

  /**
   * Returns the current PushSubscription if the browser has one, else null.
   * Useful to check "is this browser already subscribed?" without triggering
   * a permission prompt.
   */
  async getExistingSubscription(options?: PushSubscribeOptions | null): Promise<PushSubscription | null> {
    if (!this.isSupported()) return null;
    try {
      const registration = await navigator.serviceWorker.getRegistration(options?.scope || '/');
      if (!registration) return null;
      return await registration.pushManager.getSubscription();
    } catch (error) {
      this.logger.warn('Could not read the push subscription:', error);
      return null;
    }
  }

  /**
   * Keep the server's copy of this browser's subscription current, without
   * prompting. Runs on init, after reset() and when tracking consent is
   * granted.
   *
   * A browser rotates a subscription on its own (the worker's
   * `pushsubscriptionchange` cannot report it - it has no SDK key), and a
   * VAPID key change on the server makes the old subscription useless. Nothing
   * re-registered either, so the visitor silently stopped receiving push. Now:
   *  - permission granted + key changed -> re-subscribe with the current key
   *    (no prompt: permission is already granted) and register;
   *  - endpoint or identity changed since the last registration, or `force`
   *    (reset() moved the visitor to a new anonymous id) -> register;
   *  - otherwise at most once a day, which also heals server-side pruning.
   */
  async syncExistingSubscription(force: boolean = false, options?: PushSubscribeOptions | null): Promise<void> {
    try {
      // An unsubscribe the server has not heard about yet goes first - and
      // goes whatever the tracking state: it is a withdrawal.
      await this.sendPendingUnregister();
      if (!this.canSend()) return;
      // The visitor (or the site) unsubscribed this browser: it stays that way
      // until subscribe() is called again, whatever the permission says.
      if (this.storage?.get<boolean>(UNREGISTERED_KEY) === true) return;
      if (!this.isSupported() || Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker.getRegistration(options?.scope || '/');
      if (!registration) return;
      let subscription = await registration.pushManager.getSubscription();

      const marker = this.storage?.get<{ endpoint: string; userId: string | null; anonymousId: string; at: number }>(
        REGISTRATION_MARKER_KEY,
      );
      const userId = this.identity.getUserId();
      const anonymousId = this.identity.getAnonymousId();
      const due = !marker || Date.now() - (marker.at || 0) > REREGISTER_EVERY_MS;
      const changed =
        !subscription ||
        !marker ||
        marker.endpoint !== subscription.endpoint ||
        marker.userId !== userId ||
        marker.anonymousId !== anonymousId;
      if (!force && !due && !changed) return;

      const publicKey = await this.fetchVapidPublicKey();
      if (!publicKey) return;
      if (subscription && !this.subscriptionKeyMatches(subscription, publicKey)) {
        this.logger.info('VAPID key changed - re-subscribing this browser');
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
      }
      await this.registerWithBackend(subscription);
    } catch (error) {
      this.logger.warn('Could not refresh the push subscription:', error);
    }
  }

  /**
   * Tell the service worker whether tracking is opted out, so it stops
   * sending delivery and click receipts. Best-effort: Cache Storage is
   * unavailable on insecure origins, where web push does not exist anyway.
   */
  async setTrackingOptedOut(optedOut: boolean): Promise<void> {
    try {
      if (typeof caches === 'undefined') return;
      if (optedOut) {
        const cache = await caches.open(SW_STATE_CACHE);
        await cache.put(SW_OPT_OUT_URL, new Response('1'));
      } else {
        await caches.delete(SW_STATE_CACHE);
      }
    } catch (error) {
      this.logger.debug('Could not record the opt-out for the service worker:', error);
    }
  }

  /**
   * Pre-warm web push WITHOUT prompting: fetch the VAPID key and register the
   * service worker ahead of any user gesture. Call this when a push primer is
   * about to be shown, so the later, gesture-bound subscribe() does the minimum
   * async work and the OS permission prompt reliably fires inside the
   * user-activation window (transient activation lapses across slow awaits).
   * Idempotent; never prompts; returns false if web push isn't available/enabled.
   */
  async prepare(options?: PushSubscribeOptions | null): Promise<boolean> {
    options = options || {};
    if (!this.isSupported()) {
      this.lastPrepareError = 'unsupported';
      return false;
    }
    if (this.prepared) {
      this.lastPrepareError = null;
      return true;
    }

    const publicKey = await this.fetchVapidPublicKey();
    if (!publicKey) {
      this.lastPrepareError = 'no-key';
      this.logger.error('Web push is not enabled for this workspace');
      return false;
    }
    try {
      const registration = await navigator.serviceWorker.register(
        options.swPath || '/joryio-sw.js',
        { scope: options.scope || '/' },
      );
      await navigator.serviceWorker.ready;
      this.prepared = { registration, publicKey };
      this.lastPrepareError = null;
      return true;
    } catch (err) {
      this.lastPrepareError = 'sw-failed';
      this.logger.error(`Service worker registration failed:`, err);
      return false;
    }
  }

  /**
   * Subscribe this browser to web push. Call this from a click handler —
   * browsers require a user gesture to trigger the permission prompt. If
   * prepare() ran earlier, the slow work (VAPID fetch + SW register) is already
   * done, so the click-time path is just getSubscription() + subscribe().
   *
   * Returns the PushSubscription on success, null if the user denied the
   * prompt or the browser rejected the subscribe call.
   */
  async subscribe(options?: PushSubscribeOptions | null): Promise<PushSubscription | null> {
    try {
      return await this.subscribeOnce(options);
    } finally {
      try {
        this.onSubscribeSettled?.();
      } catch (error) {
        this.logger.warn('Push permission report failed:', error);
      }
    }
  }

  private async subscribeOnce(options?: PushSubscribeOptions | null): Promise<PushSubscription | null> {
    options = options || {};
    // subscribe() runs from an explicit user gesture (the push primer). A silent
    // no-op is the worst outcome for an integrator, and the SDK logger is off by
    // default — so the "couldn't enable push, here's why" reasons go to
    // console.warn directly, regardless of log level.
    if (!this.isSupported()) {
      console.warn(
        '[Joryio SDK] Push not enabled: this browser/context does not support web push ' +
          '(needs HTTPS, a service worker, and PushManager - Safari < 16.4 and insecure origins are excluded).',
      );
      return null;
    }

    // Reuse the pre-warmed registration/key if available; otherwise warm now.
    // (Warming now adds awaits before the prompt — fine on a fast connection,
    // but prepare() ahead of the gesture is the reliable path.)
    if (!this.prepared) {
      await this.prepare(options);
    }
    const prep = this.prepared;
    if (!prep) {
      this.logger.error('Web push is not enabled for this workspace');
      const swPath = options.swPath || '/joryio-sw.js';
      if (this.lastPrepareError === 'no-key') {
        console.warn(
          '[Joryio SDK] Push not enabled: the server returned no VAPID key - web push is not ' +
            'configured for this app. Enable web push for THIS app (the one your SDK key belongs to) ' +
            'in the dashboard.',
        );
      } else if (this.lastPrepareError === 'sw-failed') {
        console.warn(
          `[Joryio SDK] Push not enabled: the service worker failed to register. The VAPID key was ` +
            `fetched OK, so the problem is ${swPath}: make sure it is hosted on your origin AND its ` +
            `importScripts() points at https://sdk.joryio.com/web/1/joryio-sw.js (a dead URL makes ` +
            `the worker's install throw and registration fail).`,
        );
      } else {
        console.warn('[Joryio SDK] Push not enabled: could not prepare web push.');
      }
      return null;
    }

    // An explicit subscribe() is the one thing that lifts an unsubscribe().
    this.storage?.remove(UNREGISTERED_KEY);

    try {
      const existing = await prep.registration.pushManager.getSubscription();
      if (existing && this.subscriptionKeyMatches(existing, prep.publicKey)) {
        // Already subscribed with the CURRENT VAPID key — re-register with
        // backend in case this browser lost sync (new userId, app reinstall).
        await this.registerWithBackend(existing).catch((error) => this.logRegisterFailure(error));
        return existing;
      }
      if (existing) {
        // The server's VAPID key changed since this browser subscribed (e.g. a
        // regenerate, or the org→per-app web push cutover). The old subscription
        // is cryptographically bound to the OLD applicationServerKey, so every
        // send would 403/410 and get pruned — re-subscribe with the current key
        // so the user isn't silently stranded.
        this.logger.info('VAPID key changed - re-subscribing this browser');
        await existing.unsubscribe().catch(() => {});
      }

      const subscription = await prep.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(prep.publicKey) as BufferSource,
      });

      // An unregister of an OLDER endpoint goes first, so the server never
      // sees it after this registration.
      await this.sendPendingUnregister();
      // The browser IS subscribed now. A failed registration is retried on the
      // next page load (no marker is written), so it is not a failed subscribe.
      await this.registerWithBackend(subscription).catch((error) => this.logRegisterFailure(error));
      this.logger.info('Web push subscribed');
      return subscription;
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        this.logger.info('User denied push permission');
        console.warn(
          '[Joryio SDK] Push not enabled: notification permission is denied. The browser will not ' +
            're-prompt - the user must re-allow notifications for this site in browser settings.',
        );
      } else {
        this.logger.error('pushManager.subscribe failed:', err);
        console.warn('[Joryio SDK] Push not enabled: pushManager.subscribe failed:', err);
      }
      return null;
    }
  }

  /**
   * Unsubscribe this browser: the browser drops the subscription and the
   * server marks it inactive. Durable: nothing re-subscribes or re-registers
   * this browser on a later page load until subscribe() is called again.
   *
   * Never rejects (a failure resolves `false`). The server is told even when
   * the browser-side unsubscribe fails, and when it cannot be told now
   * (offline, consent pending) it is told on a later page view.
   */
  async unsubscribe(options?: PushSubscribeOptions | null): Promise<boolean> {
    // Captured now: by the time the browser answers, a reset() or wipeData()
    // may have moved this visitor to a new identity.
    const owner = {
      userId: this.withdrawalUserId() || undefined,
      anonymousId: this.identity.getAnonymousId(),
    };
    try {
      this.storage?.set(UNREGISTERED_KEY, true);
      this.storage?.remove(REGISTRATION_MARKER_KEY);
      if (!this.isSupported()) return false;
      const registration = await navigator.serviceWorker.getRegistration(options?.scope || '/');
      if (!registration) return false;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return true;

      const endpoint = subscription.endpoint;
      const ok = await subscription.unsubscribe().catch(() => false);

      const pending = this.pendingUnregisters().filter((u) => u.endpoint !== endpoint);
      pending.push({ endpoint, ...owner });
      this.storePendingUnregisters(pending);
      await this.sendPendingUnregister();
      return ok;
    } catch (error) {
      this.logger.warn('Push unsubscribe failed:', error);
      return false;
    }
  }

  /**
   * Erase this browser's push state (wipeData): unsubscribe it, tell the
   * server, and forget the registration. Like unsubscribe(), it stays
   * unsubscribed until subscribe() is called again.
   */
  async forget(): Promise<void> {
    await this.unsubscribe();
    this.prepared = null;
  }

  /** Users with an unregister still waiting (their retired SDK-auth token must be kept). */
  pendingUnregisterUsers(): string[] {
    return this.pendingUnregisters()
      .map((u) => u.userId)
      .filter((u): u is string => typeof u === 'string' && !!u);
  }

  private pendingUnregisters(): PendingUnregister[] {
    const stored = this.storage?.get<PendingUnregister | PendingUnregister[]>(PENDING_UNREGISTER_KEY);
    const list = Array.isArray(stored) ? stored : stored ? [stored] : [];
    return list.filter((u) => u && typeof u.endpoint === 'string' && u.endpoint && typeof u.anonymousId === 'string');
  }

  private storePendingUnregisters(list: PendingUnregister[]): void {
    if (list.length) this.storage?.set(PENDING_UNREGISTER_KEY, list.slice(-20));
    else this.storage?.remove(PENDING_UNREGISTER_KEY);
  }

  /** Re-check the stored unregisters (the SDK calls it when it comes online or may send again). */
  retryPendingUnregister(): void {
    this.sendPendingUnregister().catch(() => undefined);
  }

  /**
   * Send the stored server-side unregisters, oldest first. A withdrawal: not
   * held by an opt-out, by consent or by a suspended workspace (the server
   * accepts withdrawals while ingestion is paused), only by an inert instance. A failure that can heal is retried in this page view
   * (and on the next one); a refusal drops it (contract item 40).
   */
  private async sendPendingUnregister(): Promise<void> {
    if (this.unregisterInFlight || !this.canWithdraw()) return;
    if (typeof navigator !== 'undefined' && (navigator as any).onLine === false) return;
    if (this.unregisterTimer !== null) {
      clearTimeout(this.unregisterTimer);
      this.unregisterTimer = null;
    }
    this.unregisterInFlight = true;
    try {
      for (;;) {
        const [pending] = this.pendingUnregisters();
        if (!pending) return;
        const { attempts = 0, notFoundAttempts = 0, failures = 0, ...wire } = pending;
        const res = await this.network.request({
          url: `${this.apiEndpoint}/v1/push/unregister`,
          method: 'POST',
          body: { platform: 'web', ...wire },
          subjectUserId: wire.userId || null,
        });
        const verdict = classifyWriteResponse(res, {
          isSdkAuthError: this.network.isSdkAuthError(res.status, res.data),
          ownerIsCurrentUser: (wire.userId || null) === this.withdrawalUserId(),
        });
        // Re-read: another call may have changed the list meanwhile.
        const rest = this.pendingUnregisters().filter((u) => u.endpoint !== pending.endpoint);
        if (verdict.action === 'done' || verdict.action === 'drop') {
          if (verdict.action === 'drop') this.logger.error(`Push unregister dropped: ${verdict.reason}`);
          this.storePendingUnregisters(rest);
          continue;
        }
        if (verdict.action === 'hold') return; // kept for the next page view
        const next: PendingUnregister = {
          ...pending,
          failures: failures + 1,
          attempts: attempts + (verdict.counts && !verdict.notFound ? 1 : 0),
          notFoundAttempts: notFoundAttempts + (verdict.counts && verdict.notFound ? 1 : 0),
        };
        if (writeAttemptsExhausted(next.attempts!, next.notFoundAttempts!)) {
          this.logger.error('Push unregister failed too many times; dropping it');
          this.storePendingUnregisters(rest);
          continue;
        }
        this.storePendingUnregisters([next, ...rest]);
        this.unregisterTimer = setTimeout(() => {
          this.unregisterTimer = null;
          this.sendPendingUnregister().catch(() => undefined);
        }, writeRetryDelay(next.failures!, verdict.retryAfterMs));
        return;
      }
    } catch (err) {
      this.logger.warn('Failed to notify backend about unsubscribe:', err);
    } finally {
      this.unregisterInFlight = false;
    }
  }

  /** Stop the unregister retry timer (SDK destroy). */
  destroy(): void {
    if (this.unregisterTimer !== null) clearTimeout(this.unregisterTimer);
    this.unregisterTimer = null;
  }

  private logRegisterFailure(error: unknown): void {
    this.logger.warn(
      'This browser is subscribed, but registering it with Joryio failed; it is retried on the next page load:',
      error,
    );
  }

  /**
   * Does an existing browser subscription's applicationServerKey match the
   * current server VAPID public key? A PushSubscription is permanently bound to
   * the key it was created with, so a server-side key change requires
   * re-subscription. Returns true (no churn) when the key can't be read.
   */
  private subscriptionKeyMatches(sub: PushSubscription, publicKeyB64: string): boolean {
    try {
      const current = (sub.options as any)?.applicationServerKey as
        | ArrayBuffer
        | null
        | undefined;
      if (!current) return true; // can't compare → assume ok, avoid needless churn
      const a = new Uint8Array(current);
      const b = urlBase64ToUint8Array(publicKeyB64);
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private async fetchVapidPublicKey(): Promise<string | null> {
    if (this.vapidKeyCache) return this.vapidKeyCache;
    try {
      const response = await this.network.request({
        url: `${this.apiEndpoint}/v1/push/vapid-public-key`,
        method: 'GET',
      });
      if (!response.ok || !response.data?.enabled || !response.data?.publicKey) {
        return null;
      }
      this.vapidKeyCache = response.data.publicKey;
      return this.vapidKeyCache;
    } catch (err) {
      this.logger.error('Failed to fetch VAPID public key:', err);
      return null;
    }
  }

  private async registerWithBackend(subscription: PushSubscription): Promise<void> {
    // Opted out, or consent still pending: the browser keeps its subscription,
    // but nothing about it is sent. Granting consent re-runs
    // syncExistingSubscription(), which registers it then.
    if (!this.canSend()) {
      this.logger.debug('Push subscription not registered: tracking is off or consent is pending');
      return;
    }
    const json = subscription.toJSON();
    const deviceId = this.getDeviceId();
    const body = {
      platform: 'web',
      subscription: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: json.keys?.p256dh || '',
          auth: json.keys?.auth || '',
        },
      },
      userId: this.identity.getUserId() || undefined,
      anonymousId: this.identity.getAnonymousId(),
      ...(deviceId ? { deviceId } : {}),
    };
    // Registering this endpoint again cancels an unregister of it that has
    // not been sent yet: sent afterwards, it would turn push off for good.
    const pendingUnregisters = this.pendingUnregisters();
    if (pendingUnregisters.some((u) => u.endpoint === subscription.endpoint)) {
      this.storePendingUnregisters(pendingUnregisters.filter((u) => u.endpoint !== subscription.endpoint));
    }
    const response = await this.network.request({
      url: `${this.apiEndpoint}/v1/push/register`,
      method: 'POST',
      body,
      subjectUserId: body.userId || null,
    });
    // `ok` is false for a 2xx whose body says `success: false` too - the
    // server did not store the subscription, so no marker is written and the
    // next page load registers it again.
    if (!response.ok) {
      throw new Error(`Failed to register subscription: ${response.error || response.status}`);
    }
    this.storage?.set(REGISTRATION_MARKER_KEY, {
      endpoint: subscription.endpoint,
      userId: body.userId ?? null,
      anonymousId: body.anonymousId,
      at: Date.now(),
    });
  }
}

/**
 * Convert a URL-safe base64 string (VAPID public key) to a Uint8Array,
 * which is what pushManager.subscribe expects.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}
