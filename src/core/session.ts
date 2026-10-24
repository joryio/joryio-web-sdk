/**
 * Session Manager for tracking user sessions
 */

import { StorageManager } from './storage';
import { Logger } from '../utils/logger';
import { generateShortId } from '../utils/uuid';

export const SESSION_ID_KEY = 'session_id';
const SESSION_START_KEY = 'session_start';
const LAST_ACTIVITY_KEY = 'last_activity';
/**
 * How often the last-activity stamp is actually written to storage. It only
 * feeds a 30-minute timeout decision, so a 30s resolution is far more precision
 * than the decision needs — see updateActivity().
 */
const ACTIVITY_PERSIST_INTERVAL_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours max session age

export interface SessionInfo {
  sessionId: string;
  sessionStart: number;
  lastActivity: number;
  isNewSession: boolean;
}

export class SessionManager {
  private storage: StorageManager;
  private logger: Logger;
  private sessionTimeoutMs: number;
  private currentSessionId: string | null = null;
  /** Exact in-memory activity time; the persisted copy is throttled. */
  private lastActivityAt = 0;
  private lastActivityPersistedAt = 0;
  private isNewSession: boolean = false;
  private onNewSessionCallback: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;

  constructor(storage: StorageManager, logger: Logger, sessionTimeoutMs?: number) {
    this.storage = storage;
    this.logger = logger;
    this.sessionTimeoutMs = sessionTimeoutMs || DEFAULT_SESSION_TIMEOUT_MS;

    // Initialize session on construction
    this.initializeSession();

    // Listen for visibility changes to check session when tab becomes visible
    if (typeof document !== 'undefined') {
      this.boundVisibilityHandler = () => {
        if (document.visibilityState === 'visible') {
          this.checkAndRefreshSession();
        }
      };
      document.addEventListener('visibilitychange', this.boundVisibilityHandler);
    }
  }

  /**
   * Set callback to be called when a new session is created (e.g., to track session start)
   */
  onNewSession(callback: () => void): void {
    this.onNewSessionCallback = callback;
  }

  /**
   * Initialize or resume session
   */
  private initializeSession(): void {
    const existingSessionId = this.storage.get<string>(SESSION_ID_KEY);
    const lastActivity = this.storage.get<number>(LAST_ACTIVITY_KEY);
    const sessionStart = this.storage.get<number>(SESSION_START_KEY);

    if (existingSessionId && lastActivity) {
      const now = Date.now();
      const timeSinceLastActivity = now - lastActivity;
      const sessionAge = sessionStart ? now - sessionStart : Infinity;

      // Check both inactivity timeout AND max session age
      // This prevents sessions from being kept alive indefinitely by background tabs
      if (timeSinceLastActivity < this.sessionTimeoutMs && sessionAge < MAX_SESSION_AGE_MS) {
        // Resume existing session
        this.currentSessionId = existingSessionId;
        this.isNewSession = false;
        this.updateActivity();
        this.logger.debug(`Resumed session: ${this.currentSessionId}`);
        return;
      } else if (sessionAge >= MAX_SESSION_AGE_MS) {
        this.logger.debug(`Session too old (${Math.round(sessionAge / 1000 / 60 / 60)}h), creating new session`);
      } else {
        this.logger.debug(`Session expired (${timeSinceLastActivity}ms since last activity)`);
      }
    }

    // Create new session
    this.startNewSession();
  }

  /**
   * Start a new session
   */
  private startNewSession(): void {
    const previousSessionId = this.currentSessionId;
    this.currentSessionId = generateShortId();
    this.isNewSession = true;
    const now = Date.now();

    this.storage.set(SESSION_ID_KEY, this.currentSessionId);
    this.storage.set(SESSION_START_KEY, now);
    this.storage.set(LAST_ACTIVITY_KEY, now);
    this.lastActivityAt = now;
    this.lastActivityPersistedAt = now;

    this.logger.debug(`Started new session: ${this.currentSessionId}`);

    // Call the callback if this is a session refresh (not initial creation)
    if (previousSessionId && this.onNewSessionCallback) {
      this.onNewSessionCallback();
    }
  }

  /**
   * Check session validity and refresh if needed (called when tab becomes visible)
   */
  private checkAndRefreshSession(): void {
    const lastActivity = this.storage.get<number>(LAST_ACTIVITY_KEY);
    const sessionStart = this.storage.get<number>(SESSION_START_KEY);

    if (lastActivity && sessionStart) {
      const now = Date.now();
      const timeSinceLastActivity = now - lastActivity;
      const sessionAge = now - sessionStart;

      // Check if session should expire
      if (timeSinceLastActivity >= this.sessionTimeoutMs) {
        this.logger.debug(`Session expired on tab focus (${Math.round(timeSinceLastActivity / 1000 / 60)} min inactive)`);
        this.startNewSession();
      } else if (sessionAge >= MAX_SESSION_AGE_MS) {
        this.logger.debug(`Session too old on tab focus (${Math.round(sessionAge / 1000 / 60 / 60)}h old)`);
        this.startNewSession();
      }
    }
  }

  /**
   * End the session if it timed out or outlived its maximum age, and start a
   * new one (its Session Start comes from the onNewSession hook). Called on
   * every track(): the visibility check alone never ended a session in a tab
   * that stayed visible (contract item 32). Returns true when a new session
   * began.
   */
  refreshIfExpired(): boolean {
    if (!this.currentSessionId) return false;
    const now = Date.now();
    // The later of this tab's exact stamp and the stored one (another tab
    // of the same site keeps the session alive too).
    const lastActivity = Math.max(this.lastActivityAt, this.storage.get<number>(LAST_ACTIVITY_KEY) || 0) || now;
    const sessionStart = this.storage.get<number>(SESSION_START_KEY) || now;
    if (now - lastActivity >= this.sessionTimeoutMs) {
      this.logger.debug(`Session expired (${Math.round((now - lastActivity) / 1000 / 60)} min inactive)`);
      this.startNewSession();
      return true;
    }
    if (now - sessionStart >= MAX_SESSION_AGE_MS) {
      this.logger.debug('Session reached its maximum age');
      this.startNewSession();
      return true;
    }
    return false;
  }

  /**
   * Update last activity timestamp (call this when tracking events)
   */
  updateActivity(): void {
    if (!this.currentSessionId) return;

    // Written on EVERY tracked event, and localStorage.setItem is synchronous
    // main-thread I/O. A page that tracks a burst (scroll, product impressions)
    // paid one write per event: measured in headless Chrome as 40 writes for a
    // 40-event burst.
    //
    // The stamp only has to be accurate enough to judge a 30-MINUTE session
    // timeout, so persisting at most once every 30 seconds is ~60x fewer writes
    // and cannot change a timeout decision. The in-memory value stays exact; only
    // the persisted copy is throttled, so the worst case after an abrupt tab
    // close is a stamp up to 30s stale against a 30min threshold.
    const now = Date.now();
    this.lastActivityAt = now;
    if (now - this.lastActivityPersistedAt < ACTIVITY_PERSIST_INTERVAL_MS) return;
    this.lastActivityPersistedAt = now;
    this.storage.set(LAST_ACTIVITY_KEY, now);
  }

  /**
   * Get current session information
   */
  getSessionInfo(): SessionInfo {
    // A READ (rule 54): never starts or extends a session. With none (after
    // wipeData(), before the next tracked event) the id is ''.
    const sessionId = this.currentSessionId || this.storage.get<string>(SESSION_ID_KEY) || '';

    const sessionStart = this.storage.get<number>(SESSION_START_KEY) || Date.now();
    // In-memory value first: it is exact, whereas the persisted copy is
    // throttled to one write per ACTIVITY_PERSIST_INTERVAL_MS.
    const lastActivity =
      this.lastActivityAt || this.storage.get<number>(LAST_ACTIVITY_KEY) || Date.now();

    return {
      sessionId,
      sessionStart,
      lastActivity,
      isNewSession: this.isNewSession,
    };
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    // A READ (rule 54): in-app sync, resolve and impressions read the id, and
    // a read used to start a session silently - one with no Session Start.
    return this.currentSessionId || this.storage.get<string>(SESSION_ID_KEY) || '';
  }

  /**
   * The lifecycle path: the current session, or a new one when there is none
   * (after wipeData()). A new one is announced through onNewSession - which
   * tracks its Session Start - so no session ever starts without one.
   * Returns the session id.
   */
  ensureSession(): string {
    if (this.currentSessionId) return this.currentSessionId;
    const stored = this.storage.get<string>(SESSION_ID_KEY);
    if (stored) {
      this.currentSessionId = stored;
      return stored;
    }
    this.currentSessionId = generateShortId();
    this.isNewSession = true;
    const now = Date.now();
    this.storage.set(SESSION_ID_KEY, this.currentSessionId);
    this.storage.set(SESSION_START_KEY, now);
    this.storage.set(LAST_ACTIVITY_KEY, now);
    this.lastActivityAt = now;
    this.lastActivityPersistedAt = now;
    this.logger.debug(`Started new session: ${this.currentSessionId}`);
    if (this.onNewSessionCallback) this.onNewSessionCallback();
    return this.currentSessionId;
  }

  /**
   * Another tab changed the visitor (its reset()): take over the session it
   * stored - it started that session and sent its Session Start - instead of
   * carrying the outgoing visitor's session id in memory here. No stored
   * session (a wipe there): this one is forgotten too, and the next call that
   * needs one starts it (with its Session Start). Returns true when the
   * session id here changed.
   */
  followStoredSession(): boolean {
    const stored = this.storage.get<string>(SESSION_ID_KEY);
    if (stored === this.currentSessionId) return false;
    this.currentSessionId = stored || null;
    this.isNewSession = false;
    this.lastActivityAt = stored ? this.storage.get<number>(LAST_ACTIVITY_KEY) || Date.now() : 0;
    this.lastActivityPersistedAt = this.lastActivityAt;
    this.logger.debug(`Following the session another tab started: ${stored || '(none)'}`);
    return true;
  }

  /**
   * Manually renew the session (reset timeout)
   */
  renewSession(): void {
    this.updateActivity();
    this.logger.debug(`Session renewed: ${this.currentSessionId}`);
  }

  /**
   * Force start a new session
   */
  resetSession(): void {
    this.logger.debug(`Resetting session (was: ${this.currentSessionId})`);
    this.startNewSession();
  }

  /**
   * Forget the session entirely (wipeData). The next call that needs a session
   * starts a fresh one; no Session Start is tracked for it, because nothing
   * about the wiped visitor may carry over.
   */
  clear(): void {
    this.currentSessionId = null;
    this.isNewSession = false;
    this.lastActivityAt = 0;
    this.lastActivityPersistedAt = 0;
    this.storage.remove(SESSION_ID_KEY);
    this.storage.remove(SESSION_START_KEY);
    this.storage.remove(LAST_ACTIVITY_KEY);
  }

  /**
   * Cleanup session manager
   */
  destroy(): void {
    if (this.boundVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
  }
}
