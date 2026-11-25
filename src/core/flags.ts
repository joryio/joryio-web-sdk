/**
 * Feature flags + remote config (Joryio BACKLOG D446).
 *
 * - `getFlag(key, default)` and the typed getters read the answer held on the
 *   device; they never wait for the network. Before the first answer, for a
 *   flag the server did not send, or for a value of the wrong type, they return
 *   the in-code default.
 * - Nothing is fetched until the app uses flags (the first getter, getAllFlags,
 *   refreshFlags or onFlagsUpdated on this device), so a site that never reads
 *   a flag costs no request. From then on the answer (`POST /v1/flags/evaluate`,
 *   every active flag in one call) is
 *   kept in localStorage for the same visitor, and refreshed on start, when the
 *   page becomes visible again (at most once per FLAGS_MIN_REFRESH_SECONDS), on
 *   identify / reset, and on `refreshFlags()`. Browsers have no silent push
 *   (every web push must show a notification), so `jry_sync: "flags"` does not
 *   apply on the web.
 * - An exposure (`flag.exposure`) is logged the first time a value is read in
 *   a session: once per flag and variant per session, unless the answer said
 *   `logExposure: false` (server-side sampling). The server re-evaluates every
 *   exposure, so only real assignments count. The "already sent" marks of the
 *   current session are kept in localStorage (BACKLOG D479), so a page reload
 *   or another tab in the same session does not send them again; the server
 *   also counts an exposure once per person, flag, variant and session.
 * - Without tracking consent nothing is sent: no request names the visitor,
 *   no exposure is logged, and the getters return the in-code default.
 *
 * The same names and wire values on all five SDKs.
 */
import { JoryioSubscription, joryioSubscription } from './subscription';
import { Logger } from '../utils/logger';
import { bucketHash } from '../utils/bucket-hash';
import { generateUUID } from '../utils/uuid';
import { sdkIdentityHeaders } from './config';
import { IdentityManager } from './identity';
import { SessionManager } from './session';

/** A refresh asked for within this many seconds of the last one is skipped (start, identify and refreshFlags() always go). */
export const FLAGS_MIN_REFRESH_SECONDS = 60;
/** Exposures are sent in one request this long after the first read. */
export const FLAG_EXPOSURE_FLUSH_MS = 1000;
/** "Already sent" exposure marks kept for the current session, oldest dropped first. The same on all five SDKs. */
export const FLAG_EXPOSURE_MARKS_MAX = 500;
/** The silent-push value that refreshes flags on the native SDKs (not applicable on the web). */
export const FLAG_SYNC_PUSH_VALUE = 'flags';

export type FlagValueType = 'boolean' | 'string' | 'number' | 'json';
/**
 * Why the person got this value - the server's wire value, passed to the app
 * unchanged. `override`: a journey's Feature flag step set it for them.
 * `experiment`: an arm of a running feature flag experiment campaign (its
 * holdout is `holdout`). Same list as the backend FLAG_REASONS.
 */
export type FlagReason = 'off' | 'rule' | 'default' | 'holdout' | 'archived' | 'override' | 'experiment';

/** One flag as the server sent it. */
export interface FlagResult {
  value: unknown;
  variant: string;
  valueType: FlagValueType;
  reason: FlagReason;
  version: number;
  logExposure: boolean;
}

export type FlagsUpdatedCallback = (changedKeys: string[]) => void;

interface FlagsAuth {
  getSdkAuthHeaders(subjectUserId?: string | null, anonymousId?: string | null): Record<string, string>;
}

interface FlagsRuntime {
  /** true when the SDK may send (initialized, consent granted, not suspended). */
  canSend: () => boolean;
  requestTimeoutMs?: number;
  noteStatus?: (status: number, data: unknown) => void;
  /** Attributes the app set on this device, matched by attribute rules. */
  attributes?: () => Record<string, unknown>;
}

interface Stored {
  subject: string;
  etag: string;
  fetchedAt: number;
  flags: Record<string, FlagResult>;
}

/**
 * The cached answer is per workspace: the key carries a hash of the SDK key
 * (the same hash the StorageManager prefixes every other key with), so two
 * workspaces on one origin - which may know the same person by the same
 * external id - never read each other's flags. The unscoped key of builds
 * before 2026-11-21 is never read; it is removed on the first load.
 */
const LEGACY_STORAGE_KEY = 'jry_flags';
export const flagsStorageKey = (sdkKey: string): string => `jry_flags_${bucketHash(sdkKey).toString(36)}`;
/** The current session's exposure marks, per workspace like the answer: `{ sessionId, marks }`. */
export const flagExposuresStorageKey = (sdkKey: string): string => `jry_flag_exposures_${bucketHash(sdkKey).toString(36)}`;
const nowMs = () => Date.now();

export class FlagsManager {
  private flags: Record<string, FlagResult> = {};
  private etag = '';
  private fetchedAt = 0;
  private generation = 0;
  private inflight: Promise<void> | null = null;
  private inflightGeneration = 0;
  private listeners = new Set<FlagsUpdatedCallback>();
  /**
   * `<sessionId>|<person>|<flag>|<variant>` already reported this session, in
   * the order they were read. Stored in localStorage (flagExposuresStorageKey)
   * when a batch is sent, so a reload in the same session starts from what was
   * already sent.
   */
  private exposed = new Set<string>();
  /** The session `exposed` belongs to; another session starts empty. */
  private exposedSession: string | null = null;
  /**
   * Exposures waiting to be sent, each batch with the identity it was read
   * under (who, session, attributes, generation) - captured when the first
   * exposure of the batch was queued. A batch is always sent as the person who
   * read the values, never as whoever is identified when the timer fires.
   */
  private pending: {
    body: Record<string, unknown>;
    generation: number;
    exposures: Array<{ key: string; variant: string }>;
    /** One UUID per batch (1.4.0-beta.12): a copy of the request sent again is recorded once by the server. */
    idempotencyKey: string;
  } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The app reads flags on this device (a stored answer, or a call this page). */
  private used = false;
  private onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.refresh(false);
  };

  constructor(
    private readonly apiEndpoint: string,
    private readonly sdkKey: string,
    private readonly identity: IdentityManager,
    private readonly session: SessionManager,
    private readonly logger: Logger,
    private readonly runtime: FlagsRuntime,
    private readonly auth?: FlagsAuth | null,
  ) {
    this.load();
  }

  /** Start: read the stored answer, refresh it, and refresh again when the page is shown. */
  start(): void {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    if (this.used) void this.refresh(true);
  }

  /** The first use on a page that had no stored answer fetches one (the getter itself returns at once). */
  private use(): void {
    if (this.used) return;
    this.used = true;
    void this.refresh(true);
  }

  destroy(): void {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.listeners.clear();
  }

  /** The visitor or consent changed: the held answer belongs to someone else. */
  onIdentityChanged(): void {
    this.generation++;
    // The batch carries its own snapshot, so it still goes as the previous person.
    this.flush();
    const before = Object.keys(this.flags);
    this.flags = {};
    this.etag = '';
    this.fetchedAt = 0;
    this.save();
    if (before.length) this.emit(before);
    if (this.used) void this.refresh(true);
  }

  getFlag<T = unknown>(key: string, defaultValue: T): T {
    const f = this.read(key);
    return f ? (f.value as T) : defaultValue;
  }

  getBoolFlag(key: string, defaultValue: boolean): boolean {
    const f = this.read(key, 'boolean');
    return f && typeof f.value === 'boolean' ? f.value : defaultValue;
  }

  getStringFlag(key: string, defaultValue: string): string {
    const f = this.read(key, 'string');
    return f && typeof f.value === 'string' ? f.value : defaultValue;
  }

  getNumberFlag(key: string, defaultValue: number): number {
    const f = this.read(key, 'number');
    return f && typeof f.value === 'number' ? f.value : defaultValue;
  }

  getJsonFlag<T = unknown>(key: string, defaultValue: T): T {
    const f = this.read(key, 'json');
    return f ? (f.value as T) : defaultValue;
  }

  /** Every flag the device holds, as key -> value. Reading them all logs no exposure. */
  getAllFlags(): Record<string, unknown> {
    if (!this.runtime.canSend()) return {};
    this.use();
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(this.flags)) out[k] = f.value;
    return out;
  }

  /** Ask the server now (always goes, unlike the automatic refreshes). */
  async refreshFlags(): Promise<void> {
    this.used = true;
    await this.refresh(true);
  }

  /** Called with the keys whose value changed. Returns a JoryioSubscription. */
  onFlagsUpdated(callback: FlagsUpdatedCallback): JoryioSubscription {
    if (typeof callback !== 'function') return joryioSubscription(() => undefined);
    // One entry per subscription, so the same function subscribed twice is two subscriptions.
    const entry: FlagsUpdatedCallback = (keys) => callback(keys);
    this.listeners.add(entry);
    this.use();
    return joryioSubscription(() => {
      this.listeners.delete(entry);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private read(key: string, type?: FlagValueType): FlagResult | null {
    if (!this.runtime.canSend()) return null;
    this.use();
    const f = this.flags[key];
    if (!f || (type && f.valueType !== type)) return null;
    this.noteExposure(key, f);
    return f;
  }

  private noteExposure(key: string, f: FlagResult): void {
    if (!f.logExposure) return;
    // The person is part of the mark: after an account switch in the same
    // session the next person's first read is their own exposure.
    const sessionId = this.session.getSessionId();
    const mark = `${sessionId}|${this.subjectKey()}|${key}|${f.variant}`;
    if (this.exposedSession === sessionId && this.exposed.has(mark)) return;
    // A miss re-reads the stored marks (once per flag and variant per session,
    // not per read): a reload, or another tab of this session, may have sent it.
    this.loadExposures(sessionId);
    if (this.exposed.has(mark)) return;
    this.exposed.add(mark);
    while (this.exposed.size > FLAG_EXPOSURE_MARKS_MAX) this.exposed.delete(this.exposed.values().next().value as string);
    if (!this.pending || this.pending.generation !== this.generation) {
      // A batch from before an identity change is sent first, as its own person.
      if (this.pending) this.flush();
      this.pending = { body: this.requestBody(), generation: this.generation, exposures: [], idempotencyKey: generateUUID() };
    }
    this.pending.exposures.push({ key, variant: f.variant });
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLAG_EXPOSURE_FLUSH_MS);
  }

  /**
   * reset(), identify() of a different person and wipeData(): the marks of
   * the session go (memory and, unless another tab already did it, storage).
   */
  clearExposureMarks(storage = true): void {
    this.exposed = new Set();
    this.exposedSession = null;
    if (!storage) return;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(flagExposuresStorageKey(this.sdkKey));
    } catch {
      /* blocked storage: memory only */
    }
  }

  /** The stored marks of THIS session (another session's are ignored and replaced on the next save). */
  private loadExposures(sessionId: string): void {
    let marks: string[] = [];
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(flagExposuresStorageKey(this.sdkKey)) : null;
      const s = raw ? JSON.parse(raw) : null;
      if (s && s.sessionId === sessionId && Array.isArray(s.marks)) marks = s.marks.filter((m: unknown) => typeof m === 'string');
    } catch {
      /* unreadable storage: what this page has */
    }
    const kept = this.exposedSession === sessionId ? this.exposed : new Set<string>();
    this.exposed = new Set([...marks.slice(-FLAG_EXPOSURE_MARKS_MAX), ...kept]);
    this.exposedSession = sessionId;
  }

  private saveExposures(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(flagExposuresStorageKey(this.sdkKey), JSON.stringify({ sessionId: this.exposedSession, marks: Array.from(this.exposed) }));
    } catch {
      /* storage full or blocked: memory only */
    }
  }

  /** Send the queued exposures (one request, the same identity as the evaluation). */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const batch = this.pending;
    this.pending = null;
    // Consent withdrawn since the reads: nothing is sent.
    if (!batch || !batch.exposures.length || !this.runtime.canSend()) return;
    const body = { ...batch.body, exposures: batch.exposures.slice(0, 100), idempotencyKey: batch.idempotencyKey };
    // Stored when SENT, not when read: a page closed before the batch went
    // sends that exposure again after the reload instead of losing it.
    this.saveExposures();
    this.post('/v1/flags/exposures', body, true).catch((error) => this.logger.debug('Flag exposures failed', error));
  }

  private subjectKey(): string {
    return `${this.identity.getUserId() || ''}|${this.identity.getAnonymousId()}`;
  }

  private requestBody(): Record<string, unknown> {
    const userId = this.identity.getUserId();
    return {
      ...(userId ? { userId } : {}),
      anonymousId: this.identity.getAnonymousId(),
      sessionId: this.session.getSessionId(),
      attributes: this.runtime.attributes?.() ?? {},
      context: {
        platform: 'web',
        locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
        url: typeof location !== 'undefined' ? location.href.split('?')[0] : undefined,
      },
    };
  }

  private async refresh(force: boolean): Promise<void> {
    if (!this.runtime.canSend() || !this.used) return;
    if (this.inflight) {
      // A request in flight for a previous visitor: wait for it, then ask for this one.
      const stale = this.inflightGeneration !== this.generation;
      await this.inflight;
      if (stale) await this.refresh(true);
      return;
    }
    if (!force && nowMs() - this.fetchedAt < FLAGS_MIN_REFRESH_SECONDS * 1000) return;
    const generation = this.generation;
    this.inflightGeneration = generation;
    this.inflight = (async () => {
      try {
        const res = await this.post('/v1/flags/evaluate', { ...this.requestBody(), ...(this.etag ? { etag: this.etag } : {}) }, false);
        if (!res) return;
        if (generation !== this.generation) return; // answer for a previous visitor
        this.fetchedAt = nowMs();
        if (res.notModified) {
          this.save();
          return;
        }
        if (!res.flags || typeof res.flags !== 'object') return;
        const next = res.flags as Record<string, FlagResult>;
        const changed = Object.keys({ ...this.flags, ...next }).filter(
          (k) => JSON.stringify(this.flags[k]?.value) !== JSON.stringify(next[k]?.value) || this.flags[k]?.variant !== next[k]?.variant,
        );
        this.flags = next;
        this.etag = typeof res.etag === 'string' ? res.etag : '';
        this.save();
        if (changed.length) this.emit(changed);
      } catch (error) {
        this.logger.debug('Flags refresh failed; keeping the held flags', error);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async post(path: string, body: Record<string, unknown>, keepalive: boolean): Promise<any> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), this.runtime.requestTimeoutMs ?? 10000);
    const userId = typeof body.userId === 'string' ? body.userId : null;
    try {
      const response = await fetch(`${this.apiEndpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Key': this.sdkKey,
          ...sdkIdentityHeaders(),
          ...(this.auth?.getSdkAuthHeaders(userId, userId ? null : (body.anonymousId as string) ?? null) || {}),
        },
        body: JSON.stringify(body),
        ...(keepalive ? { keepalive: true } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        this.runtime.noteStatus?.(response.status, null);
        return null;
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private emit(keys: string[]): void {
    for (const cb of Array.from(this.listeners)) {
      try {
        cb(keys);
      } catch (error) {
        this.logger.error('onFlagsUpdated callback failed', error);
      }
    }
  }

  private load(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      // Not workspace-scoped: another workspace on this origin may have written it.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      const raw = localStorage.getItem(flagsStorageKey(this.sdkKey));
      if (!raw) return;
      const s: Stored = JSON.parse(raw);
      // Another visitor's answer is never used.
      if (!s || s.subject !== this.subjectKey() || typeof s.flags !== 'object') return;
      this.flags = s.flags;
      this.etag = s.etag || '';
      this.used = true;
      // The stored answer is used at once, but a start refresh always goes.
      this.fetchedAt = 0;
    } catch {
      /* unreadable storage: start empty */
    }
  }

  private save(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const s: Stored = { subject: this.subjectKey(), etag: this.etag, fetchedAt: this.fetchedAt, flags: this.flags };
      localStorage.setItem(flagsStorageKey(this.sdkKey), JSON.stringify(s));
    } catch {
      /* storage full or blocked: memory only */
    }
  }
}
