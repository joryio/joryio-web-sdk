/**
 * Network Layer with retry logic
 */

import type { SubscriptionChannel } from './user';
import { Logger } from '../utils/logger';

export interface NetworkRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  /**
   * The user this request is about (`null`: an anonymous visitor). Not sent.
   * An SDK-authentication 401 for a user who is no longer the current one
   * never reaches the host's auth error handler - it must not make the app
   * sign out the CURRENT user over a previous user's leftovers (contract
   * item 39). Omitted: the current user's.
   */
  subjectUserId?: string | null;
}

export interface NetworkResponse {
  ok: boolean;
  /** HTTP status of the last attempt; 0 when no response arrived (offline, timeout, circuit open). */
  status: number;
  data?: any;
  error?: string;
  /** Server-requested wait from a `Retry-After` header, in ms. */
  retryAfterMs?: number;
  /**
   * The server answered 2xx but its body said `success: false`: it did NOT do
   * what was asked (a database error, a refused registration). `ok` is false
   * for these, so no caller can acknowledge the write by accident; the batch
   * path reads `data.failedIndices` to keep only what was not stored.
   */
  softFailure?: boolean;
}

/** True when a parsed 2xx body reports that the request was NOT carried out. */
export function isSoftFailure(data: any): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && data.success === false;
}

/** Only the fields the API reads: bookkeeping (attempt counts) stays on the device. */
function wireIdentify(identify: { userId: string; anonymousId: string; attributes?: Record<string, any> }) {
  return { userId: identify.userId, anonymousId: identify.anonymousId, attributes: identify.attributes || {} };
}

/** `code` of the 402 every SDK route returns while the workspace's ingestion is paused. */
export const SDK_INGESTION_SUSPENDED_CODE = 'SDK_INGESTION_SUSPENDED';

/**
 * The most a keepalive request may carry. Browsers cap the SUM of in-flight
 * keepalive bodies at 64 KiB per page; staying under it leaves room for the
 * request line and for a concurrent keepalive the host page may have sent.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

/** UTF-8 byte length of a string, without allocating an encoder. */
export function utf8Length(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++; // the low surrogate is part of the same code point
    } else bytes += 3;
  }
  return bytes;
}

/** Parse a `Retry-After` header (delta-seconds or an HTTP date) to ms. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Atomic attribute-operation sections accepted by `POST /v1/attributes`.
 * Every field is optional; send only the ones a given method needs.
 */
export interface AttributeOps {
  attributes?: Record<string, any>; // $set (absolute)
  increment?: Record<string, number>; // $inc (delta)
  append?: Record<string, any>; // $addToSet
  remove?: Record<string, any>; // $pull
  unset?: string[]; // $unset
}

export interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  maxBackoffMs?: number;
  /** Per-attempt timeout (the `requestTimeout` init option). Default 10 s. */
  timeoutMs?: number;
}

/** Header the SDK attaches carrying the customer-minted SDK-auth JWT. */
export const SDK_AUTH_HEADER = 'X-Joryio-Auth';

/** Logged-out users whose token is kept for their queued leftovers. */
const MAX_RETIRED_SDK_AUTH_TOKENS = 4;
/**
 * A retired token whose user has nothing left queued is forgotten only once
 * it has been retired this long (rule 61): a write queued right after the
 * logout - or by another tab - still finds it.
 */
export const RETIRED_SDK_AUTH_TOKEN_GRACE_MS = 60_000;
/** ...and never kept longer than this, leftovers or not (the server's own withdrawal window). */
export const RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One retired token: the token and when it was retired (epoch ms). */
export interface RetiredSdkAuthToken {
  token: string;
  at: number;
  /**
   * Set for the NEXT user before a reset() (rule 72, same on iOS and Android):
   * nothing of theirs is queued yet, so the "nothing left" prune keeps it
   * until their identify() adopts it (still capped at 30 days).
   */
  standby?: boolean;
}

/**
 * Where the retired tokens are kept (owner decision D-a, 2026-10-07): in
 * localStorage next to the outbox, so a logged-out user's queued withdrawals
 * and events still authenticate after a reload. The SDK wires it.
 *
 * `update` is a read-modify-write of the STORED map (rule 62): every tab of
 * the site shares it, so a tab never writes its own map over another tab's
 * entries - it adds and removes only its own.
 */
export interface RetiredTokenStore {
  load(): Record<string, unknown> | null;
  update(mutate: (stored: Record<string, unknown>) => Record<string, unknown>): void;
}

/** A stored entry, or null when it is malformed (one bad entry never loses the others). */
export function parseRetiredToken(raw: unknown, now: number = Date.now()): RetiredSdkAuthToken | null {
  // Stored by an earlier 1.3.0 build: the token alone. Its age is unknown, so it starts now.
  if (typeof raw === 'string') return raw ? { token: raw, at: now } : null;
  if (!raw || typeof raw !== 'object') return null;
  const { token, at, standby } = raw as any;
  if (typeof token !== 'string' || !token || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return standby === true ? { token, at, standby: true } : { token, at };
}

/**
 * The `sub` claim of an SDK-authentication JWT, read WITHOUT verifying it
 * (the server verifies). Used only to avoid retiring a token that already
 * belongs to the user being identified (the host set B's token before
 * identify('B')). Null when it cannot be read.
 */
export function jwtSubject(token: string | undefined): string | null {
  const sub = jwtClaims(token)?.sub;
  return typeof sub === 'string' && sub ? sub : null;
}

/**
 * Which of two tokens of one user is the newer (rule 77, scan 7 N2): the one
 * that expires later, then the one issued later. Null when the claims do not
 * tell (the caller falls back to when each was retired).
 */
export function newerToken(a: string, b: string): string | null {
  const ca = jwtClaims(a);
  const cb = jwtClaims(b);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const claim of ['exp', 'iat']) {
    const x = num(ca?.[claim]);
    const y = num(cb?.[claim]);
    if (x !== null && y !== null && x !== y) return x > y ? a : b;
  }
  return null;
}

/** The claims of an SDK-authentication JWT, read WITHOUT verifying it; null when unreadable. */
function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decode =
      typeof atob === 'function'
        ? atob
        : (x: string) => (globalThis as any).Buffer.from(x, 'base64').toString('binary');
    const json = decodeURIComponent(
      Array.prototype.map
        .call(decode(padded), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * True when a request only WITHDRAWS: a channel unsubscribe, a group
 * unsubscribe, the opt-out marker alone, a push unregister. The server
 * accepts these even while the workspace's ingestion is paused (402), so a
 * suspension never holds them back. Mirrors the backend's isSdkWithdrawal.
 */
export function isWithdrawalRequest(url: string, body: any): boolean {
  const path = String(url || '').split('?')[0];
  const b = body && typeof body === 'object' ? body : {};
  if (path.endsWith('/v1/push/unregister')) return true;
  if (path.endsWith('/v1/subscriptions/channel')) return b.status === 'unsubscribed';
  if (path.endsWith('/v1/subscriptions/group')) return b.action === 'unsubscribe';
  if (path.endsWith('/v1/attributes')) {
    const ops = ['increment', 'append', 'remove', 'unset'];
    if (ops.some((k) => b[k] != null && Object.keys(b[k]).length > 0)) return false;
    const attrs = b.attributes;
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return false;
    const keys = Object.keys(attrs);
    return (
      keys.length > 0 &&
      keys.every((k) => k === 'tracking_opted_out' && attrs[k] === true)
    );
  }
  return false;
}

/** The identified user a request body is about (null: anonymous). */
function identifiedUserOf(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.userId === 'string' && body.userId) return body.userId;
  if (typeof body.externalId === 'string' && body.externalId) return body.externalId;
  if (body.identify && typeof body.identify.userId === 'string' && body.identify.userId) return body.identify.userId;
  for (const list of [body.events, body.impressions]) {
    if (Array.isArray(list)) {
      const hit = list.find((e: any) => e && typeof e.userId === 'string' && e.userId);
      if (hit) return hit.userId;
    }
  }
  return null;
}

/**
 * Why an SDK-authentication token was rejected by the backend. Mirrors the
 * `reason` field of a `401 { error: 'sdk_authentication_error', reason }` body.
 */
export type SdkAuthFailureReason = 'missing' | 'invalid' | 'expired' | 'sub_mismatch';

/**
 * Passed to the host-app SDK-authentication failure callback so it can mint a
 * fresh JWT (and hand it back, or call setSdkAuthenticationToken).
 */
export interface SdkAuthFailureInfo {
  reason: SdkAuthFailureReason;
  /** The ingest endpoint that was rejected (full URL). */
  endpoint: string;
  /** The current user id at the time of failure, if identified. */
  userId?: string | null;
}

/**
 * Host-app callback fired on a `sdk_authentication_error`.
 * The app may either:
 *   - synchronously call `setSdkAuthenticationToken(fresh)` inside it, or
 *   - return / resolve the fresh token string.
 * Returning nothing (or the same token) means "no new token" → no retry.
 */
export type SdkAuthFailureCallback = (
  info: SdkAuthFailureInfo,
) => void | string | Promise<void | string>;

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold: number;
  /** Cooldown period in milliseconds before allowing a probe request. Default: 30000 (30s) */
  cooldownMs: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export class NetworkClient {
  private logger: Logger;
  private sdkKey: string;
  private retryConfig: RetryConfig;

  // Circuit breaker state
  private circuitBreakerConfig: CircuitBreakerConfig;
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  // SDK-authentication state (opt-in). When disabled or token-less, no
  // X-Joryio-Auth header is attached and none of the refresh logic runs.
  private sdkAuthEnabled = false;
  private sdkAuthToken: string | undefined;
  private sdkAuthFailureCallback: SdkAuthFailureCallback | null = null;
  /**
   * Tokens of users who logged out (reset()) while some of their events or
   * writes were still queued, keyed by that user's id. Their leftovers go out
   * with THEIR token - the token is cleared from the current session, not
   * from the requests it was minted for (contract item 39). Persisted through
   * `retiredTokenStore` (D-a) and forgotten once that user's last queued item
   * settled (see forgetRetiredSdkAuthTokensExcept); the oldest goes past
   * MAX_RETIRED_SDK_AUTH_TOKENS.
   */
  private retiredSdkAuthTokens = new Map<string, RetiredSdkAuthToken>();
  private retiredTokenStore: RetiredTokenStore | null = null;
  /** The current user when the current token was set (whose token it is when its `sub` cannot be read). */
  private sdkAuthTokenUser: string | null = null;
  /**
   * Bytes of keepalive requests this page has handed to the browser and that
   * have not settled. The browser refuses a keepalive past 64 KiB in flight -
   * and an unload runs `beforeunload` AND `pagehide` - so the SDK shares one
   * budget across every hand-off instead of spending 60 KB per call.
   */
  private keepaliveBytesInFlight = 0;
  /** Current user id, kept in sync so failure info can carry it. */
  private currentUserId: string | null = null;

  /**
   * Set by a 402 `SDK_INGESTION_SUSPENDED`: the workspace's ingestion is
   * paused, so every further request this page makes would be refused the same
   * way. Stop asking for the rest of the session instead of hammering the API.
   */
  private suspended = false;

  constructor(sdkKey: string, logger: Logger, retryConfig: RetryConfig, circuitBreakerConfig?: Partial<CircuitBreakerConfig>) {
    this.sdkKey = sdkKey;
    this.logger = logger;
    this.retryConfig = retryConfig;
    this.circuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...circuitBreakerConfig,
    };
  }

  // --- SDK Authentication wiring ---------------------------------------

  /** Enable/disable SDK authentication (attach + refresh the auth JWT). */
  setSdkAuthenticationEnabled(enabled: boolean): void {
    this.sdkAuthEnabled = enabled;
  }

  /**
   * Set / update the current SDK-authentication JWT (undefined: forget it).
   *
   * Replacing a token that belongs to someone else retires it (rule 61): the
   * host may set the incoming user's token BEFORE identify() - the order the
   * docs allow - and the outgoing user's queued events and withdrawals must
   * keep THEIR token. Retired when the two tokens' `sub` differ, or (a `sub`
   * that cannot be read) when the token was set for a user who is no longer
   * the current one. A refresh for the same user retires nothing.
   */
  setSdkAuthenticationToken(token: string | undefined): void {
    const next = typeof token === 'string' && token ? token : undefined;
    const previous = this.sdkAuthToken;
    if (previous && next && previous !== next) {
      const previousSub = jwtSubject(previous);
      const nextSub = jwtSubject(next);
      const owner = previousSub || this.sdkAuthTokenUser;
      const someoneElse =
        previousSub && nextSub ? previousSub !== nextSub : !!owner && owner !== this.currentUserId;
      if (owner && someoneElse) this.retireToken(owner, previous);
    }
    this.sdkAuthToken = next;
    this.sdkAuthTokenUser = next ? this.currentUserId : null;
  }

  /**
   * Logout (reset()): the current token stops being the session's, but stays
   * bound to the outgoing user so their queued events and writes still
   * authenticate. Call BEFORE the current user id changes.
   */
  retireSdkAuthToken(): void {
    const sub = jwtSubject(this.sdkAuthToken);
    const user = sub || this.currentUserId;
    // A token naming someone other than the current user - also while no one
    // is identified - was set for the NEXT user (rule 82): kept on standby
    // for that `sub` until identify() adopts it, not pruned after the grace.
    const standby = !!sub && sub !== this.currentUserId;
    if (user && this.sdkAuthToken) this.retireToken(user, this.sdkAuthToken, standby);
    this.sdkAuthToken = undefined;
    this.sdkAuthTokenUser = null;
  }

  private retireToken(user: string, token: string, standby = false): void {
    const removed = new Map<string, string>();
    const replaced = this.retiredSdkAuthTokens.get(user);
    if (replaced && replaced.token !== token) removed.set(user, replaced.token);
    this.retiredSdkAuthTokens.delete(user);
    this.retiredSdkAuthTokens.set(user, standby ? { token, at: Date.now(), standby: true } : { token, at: Date.now() });
    while (this.retiredSdkAuthTokens.size > MAX_RETIRED_SDK_AUTH_TOKENS) {
      const oldest = this.retiredSdkAuthTokens.keys().next().value as string;
      removed.set(oldest, this.retiredSdkAuthTokens.get(oldest)!.token);
      this.retiredSdkAuthTokens.delete(oldest);
    }
    this.saveRetiredTokens(removed);
  }

  /**
   * The signed-in user changes WITHOUT a logout (identify('B') while A was
   * identified - rule 53): A's token is retired to A's queued items, exactly
   * as reset() does. Not when the token already set is the incoming user's
   * own (the host may set B's token before calling identify('B')).
   */
  switchUser(userId: string | null): void {
    const previous = this.currentUserId;
    if (previous && previous !== userId && this.sdkAuthToken) {
      const sub = jwtSubject(this.sdkAuthToken);
      if (!(userId && sub === userId)) this.retireSdkAuthToken();
    }
    this.currentUserId = userId;
    // The incoming user's own token, retired earlier on this device (the host
    // set B's token, then reset(), then identify('B') - rule 72): it is the
    // session's again, so B's requests keep carrying it after the retired
    // copy is pruned.
    if (!this.sdkAuthToken && userId) {
      const retired = this.retiredSdkAuthTokens.get(userId);
      if (retired && jwtSubject(retired.token) === userId) {
        this.sdkAuthToken = retired.token;
        this.sdkAuthTokenUser = userId;
      }
    }
    this.adoptStandbyToken(userId);
  }

  /**
   * The user `userId` is signed in (or held for withdrawals, D-b): a token
   * kept on standby for them is theirs now, not a next user's (rule 89). Its
   * standby flag is cleared - here and in the stored map - so wipeData()
   * keeps it for their withdrawals instead of deleting it as someone else's.
   */
  private adoptStandbyToken(userId: string | null): void {
    if (!userId) return;
    const entry = this.retiredSdkAuthTokens.get(userId);
    if (!entry || !entry.standby || jwtSubject(entry.token) !== userId) return;
    this.retiredSdkAuthTokens.set(userId, { token: entry.token, at: entry.at });
    this.saveRetiredTokens();
  }

  /**
   * wipeData(): forget every token kept on standby for a next user (rule
   * 82) - in this tab and in the stored map every tab shares. An erasure
   * keeps no credential of anyone; the erased user's own retired token (not
   * standby) stays for the withdrawals still waiting.
   *
   * `keep`: users whose token stays even if it is still flagged standby
   * (rule 89) - the erased user and anyone with a withdrawal still queued.
   * Their token is theirs, not a next user's.
   */
  dropStandbySdkAuthTokens(keep: Set<string> = new Set()): void {
    this.retiredSdkAuthTokens.forEach((entry, user) => {
      if (entry.standby && !keep.has(user)) this.retiredSdkAuthTokens.delete(user);
    });
    if (!this.retiredTokenStore) return;
    try {
      this.retiredTokenStore.update((stored) => {
        const out: Record<string, unknown> = {};
        const now = Date.now();
        for (const user of Object.keys(stored || {})) {
          const entry = parseRetiredToken(stored[user], now);
          if (!entry || (entry.standby && !keep.has(user)) || now - entry.at > RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS) continue;
          out[user] = entry;
        }
        return out;
      });
    } catch (error) {
      this.logger.warn('Could not store the SDK authentication tokens:', error);
    }
  }

  /** Persist retired tokens through this store (and load what it holds). */
  setRetiredTokenStore(store: RetiredTokenStore | null): void {
    this.retiredTokenStore = store;
    if (!store) return;
    let stored: Record<string, unknown> | null = null;
    try {
      stored = store.load();
    } catch (error) {
      this.logger.warn('Could not read the stored SDK authentication tokens:', error);
    }
    if (!stored || typeof stored !== 'object') return;
    const now = Date.now();
    for (const user of Object.keys(stored)) {
      // Entry by entry: one malformed or expired entry never loses the others.
      const entry = parseRetiredToken(stored[user], now);
      if (!entry || now - entry.at > RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS) continue;
      if (!this.retiredSdkAuthTokens.has(user)) this.retiredSdkAuthTokens.set(user, entry);
    }
  }

  /** Users that still hold a retired token (diagnostics and the SDK's pruning). */
  retiredSdkAuthUsers(): string[] {
    return Array.from(this.retiredSdkAuthTokens.keys());
  }

  /**
   * Forget the retired token of every user with nothing left queued (D-a): a
   * logged-out user's token lives as long as their leftovers - and at least
   * RETIRED_SDK_AUTH_TOKEN_GRACE_MS, at most RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS.
   * `stillQueued` must cover this tab's memory AND what every tab persisted.
   * Returns the ms until a token kept only by its grace period may go, or null.
   */
  forgetRetiredSdkAuthTokensExcept(stillQueued: Set<string>, now: number = Date.now()): number | null {
    const removed = new Map<string, string>();
    let wake: number | null = null;
    this.retiredSdkAuthTokens.forEach((entry, user) => {
      const age = now - entry.at;
      if (age > RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS) {
        removed.set(user, entry.token);
      } else if (!entry.standby && !stillQueued.has(user)) {
        if (age >= RETIRED_SDK_AUTH_TOKEN_GRACE_MS) removed.set(user, entry.token);
        else wake = Math.min(wake ?? Infinity, RETIRED_SDK_AUTH_TOKEN_GRACE_MS - age);
      }
    });
    removed.forEach((_, user) => this.retiredSdkAuthTokens.delete(user));
    if (removed.size) this.saveRetiredTokens(removed);
    return wake;
  }

  /**
   * Write this tab's changes into the STORED map (rule 62): add/refresh its
   * own entries, delete exactly the ones it forgot (only while the stored
   * token is still the one it forgot - another tab may have retired a newer
   * one), and leave every other tab's entries alone.
   */
  private saveRetiredTokens(removed: Map<string, string> = new Map()): void {
    if (!this.retiredTokenStore) return;
    try {
      this.retiredTokenStore.update((stored) => {
        const out: Record<string, unknown> = {};
        const now = Date.now();
        for (const user of Object.keys(stored || {})) {
          const entry = parseRetiredToken(stored[user], now);
          if (!entry || now - entry.at > RETIRED_SDK_AUTH_TOKEN_MAX_AGE_MS) continue;
          if (removed.get(user) === entry.token) continue;
          out[user] = entry;
        }
        this.retiredSdkAuthTokens.forEach((entry, user) => {
          const theirs = parseRetiredToken(out[user], now);
          if (!theirs || theirs.token === entry.token) {
            out[user] = { ...entry };
            return;
          }
          // Two tabs retired a token for one user: the NEWER token wins (by
          // its exp / iat), not the later retirement (rule 77) - a tab that
          // followed a logout retires the token it loaded with, which may be
          // older than the one the other tab refreshed since. Unreadable
          // claims: the later retirement.
          const newer = newerToken(theirs.token, entry.token);
          const ours = newer ? newer === entry.token : theirs.at <= entry.at;
          if (ours) out[user] = { ...entry };
          else this.retiredSdkAuthTokens.set(user, theirs);
        });
        return out;
      });
    } catch (error) {
      this.logger.warn('Could not store the SDK authentication tokens:', error);
    }
  }

  /**
   * The token a request about `subjectUserId` carries: the current token for
   * the current user (or an anonymous request), the outgoing user's own token
   * for their leftovers after a logout - also in the window between the host
   * setting the next user's token and calling identify() for them.
   */
  private sdkAuthTokenFor(subjectUserId: string | null | undefined): string | undefined {
    // Routed by the token's subject (rule 72): a request about user U carries
    // a token whose `sub` is U - the session token when it is U's, else U's
    // retired token - and never a token naming someone else. (The host may
    // set B's token before identify('B'): A's requests in between must not
    // carry it.) No token for U: none at all, and a 401 asks the host's
    // handler only for the current user.
    const user = subjectUserId === undefined ? this.currentUserId : subjectUserId;
    // Anonymous: the server checks no token, and none names this visitor.
    if (!user) return undefined;
    const session = this.sdkAuthEnabled ? this.sdkAuthToken : undefined;
    const sessionSub = jwtSubject(session);
    if (session && sessionSub === user) return session;
    // A token whose `sub` cannot be read: the current user's, if it was set for them.
    if (
      session &&
      !sessionSub &&
      user === this.currentUserId &&
      (this.sdkAuthTokenUser === null || this.sdkAuthTokenUser === user)
    ) {
      return session;
    }
    // Attached even when this page view did not enable SDK authentication
    // (rule 61): the token was minted for these leftovers, and the server
    // refuses them without it once the workspace requires it.
    return this.retiredSdkAuthTokens.get(user)?.token;
  }

  /** The user the network client treats as signed in. */
  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  /** Register the host-app failure callback. */
  setSdkAuthenticationFailureCallback(cb: SdkAuthFailureCallback | null): void {
    this.sdkAuthFailureCallback = cb;
  }

  /** Keep the current user id in sync so failure info can report it. */
  setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId;
    // At init (a restart) too: the signed-in user's kept token is theirs (rule 89).
    this.adoptStandbyToken(userId);
  }

  /** True once the API answered 402 SDK_INGESTION_SUSPENDED this session. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /** Record a 402 suspension (also called by the in-app manager's own fetches). */
  noteSuspended(status: number, data: any): boolean {
    if (status !== 402) return false;
    if (!this.suspended) {
      this.suspended = true;
      // console, not the logger: the logger is silent by default and this is
      // the one message a site owner must see - their data is not arriving.
      // eslint-disable-next-line no-console
      console.warn(
        `[Joryio SDK] The API refused this request with 402 ${data?.code || ''} - event ingestion is ` +
          'paused for this workspace. Nothing more will be sent this page view; queued events are kept.',
      );
    }
    return true;
  }

  /**
   * Auth headers to merge into a raw fetch made OUTSIDE this client (in-app
   * messaging issues its own fetch). Returns {} when auth is off or no token.
   * `subjectUserId`: the user the request is about - a logged-out user's
   * request carries THAT user's retired token, never the next user's.
   */
  getSdkAuthHeaders(subjectUserId?: string | null): Record<string, string> {
    const token = this.sdkAuthTokenFor(subjectUserId);
    return token ? { [SDK_AUTH_HEADER]: token } : {};
  }

  /** Room left in the browser's keepalive budget for this page, in bytes. */
  keepaliveBudget(): number {
    return Math.max(0, KEEPALIVE_MAX_BYTES - this.keepaliveBytesInFlight);
  }

  /** True if a parsed response body is a `sdk_authentication_error`. */
  isSdkAuthError(status: number, data: any): boolean {
    return (
      status === 401 &&
      !!data &&
      typeof data === 'object' &&
      data.error === 'sdk_authentication_error'
    );
  }

  /**
   * Fire the host-app failure callback and, if it yields a fresh token
   * (either by calling setSdkAuthenticationToken synchronously or by
   * returning/resolving a token string), install it. Returns the fresh
   * token when it differs from the one that just failed, else undefined.
   *
   * Used both by request() (for its one-shot retry) and by the in-app
   * fetch path (fire-and-forget, so the next sync carries a valid token).
   */
  async refreshSdkAuthToken(info: SdkAuthFailureInfo): Promise<string | undefined> {
    if (!this.sdkAuthEnabled || !this.sdkAuthFailureCallback) {
      return undefined;
    }
    const previous = this.sdkAuthToken;
    let returned: void | string;
    try {
      returned = await Promise.resolve(this.sdkAuthFailureCallback(info));
    } catch (err) {
      this.logger.error('SDK authentication failure callback threw:', err);
      return undefined;
    }
    if (typeof returned === 'string' && returned) {
      // Through the setter: a token for another user retires the old one (rule 61).
      this.setSdkAuthenticationToken(returned);
    }
    const fresh = this.sdkAuthToken;
    if (fresh && fresh !== previous) {
      return fresh;
    }
    return undefined;
  }

  /**
   * Make an HTTP request with retry logic and circuit breaker protection.
   *
   * Circuit breaker states:
   *   closed    - Normal operation. Failures are counted.
   *   open      - Fail fast without making network requests until cooldown expires.
   *   half-open - Allow one probe request. Success closes the circuit; failure re-opens it.
   */
  async request(request: NetworkRequest): Promise<NetworkResponse> {
    // A withdrawal still goes while ingestion is paused: the server accepts it.
    if (this.suspended && !isWithdrawalRequest(request.url, request.body)) {
      return { ok: false, status: 402, error: 'Ingestion suspended', data: { code: SDK_INGESTION_SUSPENDED_CODE } };
    }
    // --- Circuit breaker check ---
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.circuitBreakerConfig.cooldownMs) {
        // Still in cooldown – fail fast
        this.logger.warn(`Circuit breaker OPEN – failing fast (${Math.round((this.circuitBreakerConfig.cooldownMs - elapsed) / 1000)}s remaining)`);
        return {
          ok: false,
          status: 0,
          error: 'Circuit breaker is open – API requests are temporarily blocked',
        };
      }
      // Cooldown elapsed – transition to half-open and allow a probe
      this.circuitState = 'half-open';
      this.logger.info('Circuit breaker transitioning to HALF-OPEN – allowing probe request');
    }

    const { url, method = 'POST', headers = {} } = request;
    // Serialized ONCE, before any attempt: a body that cannot be serialized
    // (a circular object, a BigInt) used to throw inside the fetch attempt,
    // look like "offline" (status 0) and be retried forever. It is refused
    // for good instead (rule 49).
    let body: string | undefined;
    try {
      body = request.body ? JSON.stringify(request.body) : undefined;
    } catch (error) {
      this.logger.error(`Request to ${url} not sent: its body cannot be serialized`, error);
      return { ok: false, status: 400, error: 'The request body cannot be serialized' };
    }
    const forCurrentUser =
      request.subjectUserId === undefined || (request.subjectUserId || null) === this.currentUserId;

    let lastError: Error | null = null;
    let lastStatus = 0;
    let lastData: any;
    let retryAfterMs: number | undefined;
    let attempt = 0;
    // SDK-auth refresh is a distinct ONE-SHOT retry, kept out of the
    // backoff loop below so it can never loop or consume a backoff attempt.
    let sdkAuthRefreshAttempted = false;

    while (attempt <= this.retryConfig.maxRetries) {
      try {
        this.logger.debug(`Request attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}: ${method} ${url}`);

        let { response, responseData } = await this.performFetch(url, method, headers, body, request.subjectUserId);

        // --- SDK authentication: one-shot refresh + retry (out-of-band) ---
        // On a 401 sdk_authentication_error, fire the host callback to obtain a
        // fresh token and retry the SAME request exactly once with it. This does
        // NOT increment `attempt` and does NOT wait for backoff.
        if (
          !sdkAuthRefreshAttempted &&
          this.sdkAuthEnabled &&
          forCurrentUser &&
          this.isSdkAuthError(response.status, responseData)
        ) {
          sdkAuthRefreshAttempted = true;
          this.logger.warn(`SDK authentication rejected (${responseData?.reason || 'invalid'}) on ${url} – refreshing token`);
          const fresh = await this.refreshSdkAuthToken({
            reason: (responseData?.reason as SdkAuthFailureReason) || (this.sdkAuthToken ? 'invalid' : 'missing'),
            endpoint: url,
            userId: request.subjectUserId === undefined ? this.currentUserId : request.subjectUserId || null,
          });
          if (fresh) {
            this.logger.debug('SDK authentication token refreshed – retrying request once');
            ({ response, responseData } = await this.performFetch(url, method, headers, body, request.subjectUserId));
          }
        }

        if (response.ok) {
          this.onRequestSuccess();
          // 2xx with `success: false` is a FAILURE (SDK contract, addendum 15).
          // It used to be returned as ok, so attributes, aliases, subscription
          // changes and push registrations the server had refused - or lost to
          // a database error - were acknowledged and never retried.
          if (isSoftFailure(responseData)) {
            this.logger.warn(`Request to ${url} answered ${response.status} with success: false`);
            return {
              ok: false,
              status: response.status,
              data: responseData,
              error: responseData?.error || responseData?.message || 'The server reported success: false',
              softFailure: true,
            };
          }
          this.logger.debug(`Request successful: ${response.status}`);
          return {
            ok: true,
            status: response.status,
            data: responseData,
          };
        }

        // Check if we should retry based on status code
        if (!this.shouldRetry(response.status)) {
          this.logger.warn(`Request failed with non-retryable status: ${response.status}`);
          this.noteSuspended(response.status, responseData);
          // Non-retryable client errors (4xx except 429) don't count as circuit breaker failures
          return {
            ok: false,
            status: response.status,
            error: responseData?.message || response.statusText,
            data: responseData,
          };
        }

        // Retry on server errors (5xx) or rate limiting (429)
        lastStatus = response.status;
        lastData = responseData;
        retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        this.logger.warn(`Request failed (attempt ${attempt + 1}): ${lastError.message}`);

      } catch (error) {
        lastError = error as Error;
        lastStatus = 0;
        lastData = undefined;
        retryAfterMs = undefined;
        this.logger.error(`Request error (attempt ${attempt + 1}):`, error);
      }

      // Don't wait after the last attempt
      if (attempt < this.retryConfig.maxRetries) {
        // A server that said when to come back is believed (bounded, so a
        // hostile or broken header cannot park the page for an hour).
        const delay = Math.max(this.calculateBackoff(attempt), Math.min(retryAfterMs ?? 0, 30_000));
        this.logger.debug(`Retrying in ${delay}ms...`);
        await this.sleep(delay);
      }

      attempt++;
    }

    // All retries exhausted – record failure for circuit breaker
    this.onRequestFailure();

    this.logger.error(`Request failed after ${this.retryConfig.maxRetries + 1} attempts`);
    // The LAST status, not 0: a caller deciding whether to keep or drop data
    // must be able to tell a 503 from "offline".
    return {
      ok: false,
      status: lastStatus,
      data: lastData,
      error: lastError?.message || 'Network request failed',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  /**
   * Record a successful request – reset circuit breaker to closed state.
   */
  private onRequestSuccess(): void {
    if (this.consecutiveFailures > 0 || this.circuitState !== 'closed') {
      this.logger.info(`Circuit breaker CLOSED – request succeeded after ${this.consecutiveFailures} consecutive failure(s)`);
    }
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
    this.circuitOpenedAt = 0;
  }

  /**
   * Record a failed request – increment consecutive failure count
   * and open the circuit if the threshold is reached.
   */
  private onRequestFailure(): void {
    this.consecutiveFailures++;

    if (this.circuitState === 'half-open') {
      // Probe failed – reopen the circuit
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn(`Circuit breaker re-OPENED – probe request failed (${this.consecutiveFailures} consecutive failures)`);
      return;
    }

    if (this.consecutiveFailures >= this.circuitBreakerConfig.failureThreshold) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn(
        `Circuit breaker OPENED – ${this.consecutiveFailures} consecutive failures reached threshold of ${this.circuitBreakerConfig.failureThreshold}`,
      );
    }
  }

  /**
   * Get the current circuit breaker state (useful for diagnostics / testing).
   */
  getCircuitBreakerState(): { state: CircuitState; consecutiveFailures: number; openedAt: number } {
    return {
      state: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.circuitOpenedAt,
    };
  }

  /**
   * Perform a single fetch (with the configured per-attempt timeout) and parse the body.
   * Reads the CURRENT sdk-auth token each call, so a refresh-then-retry
   * automatically carries the fresh token.
   */
  private async performFetch(
    url: string,
    method: string,
    callerHeaders: Record<string, string>,
    body: string | undefined,
    subjectUserId?: string | null,
  ): Promise<{ response: Response; responseData: any }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.retryConfig.timeoutMs || 10_000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SDK-Key': this.sdkKey,
      ...callerHeaders,
    };
    // Attach the SDK-auth JWT last so the managed token is authoritative.
    const authToken = this.sdkAuthTokenFor(subjectUserId);
    if (authToken) {
      headers[SDK_AUTH_HEADER] = authToken;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        // The SDK authenticates with headers, never cookies, and the public SDK
        // routes answer `Access-Control-Allow-Origin: *`, which a credentialed
        // request may not use.
        credentials: 'omit',
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const responseData = await this.parseResponse(response);
    return { response, responseData };
  }

  /**
   * Parse response body
   */
  private async parseResponse(response: Response): Promise<any> {
    const contentType = response.headers?.get?.('content-type');

    if (contentType && contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch (e) {
        this.logger.warn('Failed to parse JSON response');
        return null;
      }
    }

    return await response.text();
  }

  /**
   * Determine if we should retry based on status code
   */
  private shouldRetry(status: number): boolean {
    // Retry on:
    // - 408 (Request Timeout)
    // - 429 (Too Many Requests)
    // - 5xx (Server Errors)
    return status === 408 || status === 429 || status >= 500;
  }

  /**
   * Calculate exponential backoff with jitter
   */
  private calculateBackoff(attempt: number): number {
    const { backoffMs, maxBackoffMs = 30000 } = this.retryConfig;

    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = backoffMs * Math.pow(2, attempt);

    // Cap at max backoff
    const cappedDelay = Math.min(exponentialDelay, maxBackoffMs);

    // Add jitter (±25%)
    const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
    const delayWithJitter = cappedDelay + jitter;

    return Math.max(0, Math.floor(delayWithJitter));
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send events batch, optionally with an atomic identify payload
   */
  async sendEvents(apiEndpoint: string, events: any[], identify?: { userId: string; anonymousId: string; attributes?: Record<string, any> }): Promise<NetworkResponse> {
    const body: any = { events };
    if (identify) {
      body.identify = wireIdentify(identify);
    }
    return this.request({
      url: `${apiEndpoint}/v1/track/batch`,
      method: 'POST',
      body,
      // A batch is of one person (the queue never mixes them).
      subjectUserId: identify?.userId || events.find((e) => e && e.userId)?.userId || null,
    });
  }

  /**
   * True when this browser honours `fetch(..., { keepalive: true })`, the only
   * way to send at unload a request that carries our headers. (Firefox before
   * 133 silently ignores the flag, so its request would be cancelled with the
   * page - and the caller must then keep the events rather than drop them.)
   */
  supportsKeepalive(): boolean {
    try {
      return (
        typeof fetch === 'function' &&
        typeof Request !== 'undefined' &&
        'keepalive' in Request.prototype
      );
    } catch {
      return false;
    }
  }

  /**
   * Hand a batch to the browser at page unload with `fetch` keepalive.
   *
   * Replaces navigator.sendBeacon, which could not work here: a beacon cannot
   * set headers (so the SDK key rode in the URL and X-Joryio-Auth was lost),
   * and an `application/json` beacon is a CREDENTIALED CORS request that needs
   * a preflight the API's `Access-Control-Allow-Origin: *` must refuse. The
   * beacon still returned `true` - "queued", not "delivered" - so the caller
   * cleared every event it had just failed to send.
   *
   * Returns null when the request could not be handed off at all; otherwise
   * the eventual response (useful only if the page survives, e.g. bfcache).
   */
  sendEventsKeepalive(
    apiEndpoint: string,
    events: any[],
    identify?: { userId: string; anonymousId: string; attributes?: Record<string, any> },
  ): Promise<NetworkResponse> | null {
    const body: any = { events };
    if (identify) body.identify = wireIdentify(identify);
    return this.postKeepalive(`${apiEndpoint}/v1/track/batch`, body);
  }

  /**
   * POST one JSON body with fetch keepalive (page unload): the SDK key and
   * the SDK-auth token as headers, no cookies. Null when it could not be
   * handed off at all.
   */
  postKeepalive(url: string, body: any): Promise<NetworkResponse> | null {
    if ((this.suspended && !isWithdrawalRequest(url, body)) || !this.supportsKeepalive()) return null;
    let json: string;
    try {
      json = JSON.stringify(body);
    } catch {
      return null;
    }
    // One budget for the whole page (beforeunload and pagehide both run the
    // hand-off): what the browser would refuse is not handed off at all, so
    // the caller keeps it rather than counting it as sent.
    const bytes = utf8Length(json) + 256;
    if (this.keepaliveBytesInFlight + bytes > KEEPALIVE_MAX_BYTES) return null;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SDK-Key': this.sdkKey,
    };
    const authToken = this.sdkAuthTokenFor(identifiedUserOf(body));
    if (authToken) {
      headers[SDK_AUTH_HEADER] = authToken;
    }
    try {
      this.keepaliveBytesInFlight += bytes;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.keepaliveBytesInFlight = Math.max(0, this.keepaliveBytesInFlight - bytes);
      };
      return fetch(url, {
        method: 'POST',
        headers,
        body: json,
        keepalive: true,
        credentials: 'omit',
      }).then(
        async (response) => {
          release();
          const data = await this.parseResponse(response).catch(() => null);
          const soft = response.ok && isSoftFailure(data);
          return { ok: response.ok && !soft, status: response.status, data, ...(soft ? { softFailure: true } : {}) };
        },
        (error) => {
          release();
          return { ok: false, status: 0, error: String(error?.message || error) };
        },
      );
    } catch (error) {
      this.keepaliveBytesInFlight = Math.max(0, this.keepaliveBytesInFlight - bytes);
      this.logger.warn('keepalive request could not be started:', error);
      return null;
    }
  }

  /**
   * Send identify request
   */
  async sendIdentify(
    apiEndpoint: string,
    userId: string,
    attributes: any,
    anonymousId?: string,
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/identify`,
      method: 'POST',
      body: {
        userId,
        attributes,
        anonymousId,
      },
      subjectUserId: userId,
    });
  }

  /**
   * Add a labelled alias (`aliasLabel` / `aliasName`) to this visitor.
   *
   * Works for anonymous visitors too: `anonymousId` is always sent, `userId`
   * when identified. The server attaches the alias to whichever contact those
   * resolve to.
   */
  async sendAddAlias(
    apiEndpoint: string,
    payload: { anonymousId: string; userId?: string; aliasLabel: string; aliasName: string },
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/alias/add`,
      method: 'POST',
      body: payload,
      subjectUserId: payload.userId || null,
    });
  }

  /**
   * Track device session
   */
  async sendDeviceSession(
    apiEndpoint: string,
    payload: {
      userId?: string;
      anonymousId?: string;
      deviceId: string;
      platform: 'ios' | 'android' | 'web';
      deviceInfo?: Record<string, any>;
    },
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/device/session`,
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Send an attribute-operations request (without triggering an identify event).
   *
   * `ops` carries the atomic operation sections the backend implements on
   * `POST /v1/attributes`:
   *   - attributes: absolute `$set`
   *   - increment:  `$inc`   (deltas, NOT computed absolutes)
   *   - append:     `$addToSet`
   *   - remove:     `$pull`
   *   - unset:      `$unset`
   * Only the sections that are present are sent, so multi-device / multi-tab
   * writes no longer clobber each other with locally-computed absolutes.
   */
  async sendSetAttributes(
    apiEndpoint: string,
    ops: AttributeOps,
    userId?: string | null,
    anonymousId?: string,
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/attributes`,
      method: 'POST',
      body: {
        userId: userId || undefined,
        anonymousId: userId ? undefined : anonymousId,
        ...ops,
      },
      subjectUserId: userId || null,
    });
  }

  /**
   * Send subscription status update
   */
  async sendSubscriptionUpdate(
    apiEndpoint: string,
    payload: {
      channel: SubscriptionChannel;
      // camelCase `optedIn` — backend rejects snake_case `opted_in`. See B7.
      status: 'optedIn' | 'subscribed' | 'unsubscribed';
      userId?: string;
      anonymousId?: string;
    },
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/subscriptions/channel`,
      method: 'POST',
      body: payload,
      subjectUserId: payload.userId || null,
    });
  }

  /**
   * Send subscription group (list) update
   */
  async sendSubscriptionGroupUpdate(
    apiEndpoint: string,
    payload: {
      groupId: string;
      channel: SubscriptionChannel;
      action: 'subscribe' | 'unsubscribe';
      userId?: string;
      anonymousId?: string;
    },
  ): Promise<NetworkResponse> {
    return this.request({
      url: `${apiEndpoint}/v1/subscriptions/group`,
      method: 'POST',
      body: payload,
      subjectUserId: payload.userId || null,
    });
  }
}
