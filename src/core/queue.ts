/**
 * Event Queue Manager for batching and persisting events
 */

import { StorageManager } from './storage';
import { Logger } from '../utils/logger';
import { utf8Length } from './network';

export const QUEUE_KEY = 'event_queue';
export const INFLIGHT_KEY = 'event_queue_inflight';
export const PENDING_IDENTIFY_KEY = 'pending_identify';
/**
 * Fallback cap when the SDK passes nothing. The REAL cap is `maxQueueSize` from
 * the init config: this constant used to be the only one consulted, so the
 * documented `maxQueueSize` option was stored and never read (audit
 * 2026-09-26, W4) - iOS and Android honour theirs.
 */
const DEFAULT_MAX_QUEUE_SIZE = 1000; // Prevent unbounded growth
/** Window over which a burst of enqueues collapses into one storage write. */
const PERSIST_COALESCE_MS = 150;

/** The backend's `@ArrayMaxSize(500)` on `/v1/track/batch`. */
export const MAX_EVENTS_PER_REQUEST = 500;
/** Stay well under the API's 1 MB body limit. */
export const MAX_REQUEST_BYTES = 900 * 1024;
/** Longest the queue waits between retries of a failing batch. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface QueuedEvent {
  eventId: string; // Client-generated ID for idempotency
  type: string;
  properties?: Record<string, any>;
  /**
   * When the event happened: ISO 8601 UTC with milliseconds (rule 55, the
   * same on every SDK). A number (epoch ms) in queues stored by an earlier
   * build; the API accepts both.
   */
  timestamp: string | number;
  userId?: string | null;
  anonymousId: string;
  sessionId?: string;
}

export interface PendingIdentify {
  userId: string;
  anonymousId: string;
  attributes?: Record<string, any>;
  /** Failed attempts so far (never sent on the wire). */
  attempts?: number;
}

/**
 * The most identifies waiting at once. They form an ordered list rather than
 * one slot: `identify('A')` while offline followed by `reset(); identify('B')`
 * used to overwrite A's identify with B's, so A's anonymous history was never
 * merged into A (scan 3, web #9).
 */
const MAX_PENDING_IDENTIFIES = 20;
/**
 * An identify that keeps being REFUSED is dropped after this many attempts
 * (contract items 28 and 40). Only server answers count (a 2xx with
 * `success: false`, an SDK-authentication 401 for the current user): offline,
 * timeouts, 429 and 5xx never do, so an outage cannot cost a visitor's merge.
 */
export const MAX_IDENTIFY_ATTEMPTS = 10;

/**
 * What became of one batch request. The SDK classifies the HTTP response;
 * the queue decides what to keep.
 *
 * - `ok`: 2xx. `failedIndices` (from a `success: false` body) names the events
 *   the server could not store; those are kept for retry, the rest deleted.
 *   `identifyFailed`: the events went through but the identify did not - it
 *   is kept and retried, never dropped.
 * - `rejected`: 400 / 413 / 422 - the request itself is unacceptable. Retrying
 *   it unchanged can never succeed, so the batch is split in half until the
 *   bad event is alone, and that one event is dropped.
 * - `retry`: 429 / 5xx / offline / timeout / an SDK-auth 401. Keep everything,
 *   back off.
 * - `suspended`: 402 / 403 / an invalid key. Stop sending for this page view;
 *   keep everything (bounded by maxQueueSize).
 */
export type FlushOutcome =
  | {
      status: 'ok';
      failedIndices?: number[];
      /** Refused for good (property limits, invalid): dropped, never retried (contract item 29). */
      rejectedIndices?: number[];
      identifyFailed?: boolean;
      /** The identify's failure counts toward MAX_IDENTIFY_ATTEMPTS (a server refusal, not an outage). */
      identifyAttemptCounts?: boolean;
      /** The identify was refused for good: dropped, never retried. */
      identifyDropped?: boolean;
    }
  | { status: 'rejected'; httpStatus?: number }
  /** `counts`: a server refusal (SDK-auth 401 for the current user), counted against an identify riding along. */
  | { status: 'retry'; retryAfterMs?: number; counts?: boolean }
  | { status: 'suspended'; reason?: string }
  /**
   * SDK authentication refused the batch because it belongs to a user who is
   * no longer the current one (401 `sub_mismatch` / `missing`): no token for
   * that user will ever be minted again, so the batch is dropped rather than
   * retried at the head of the queue forever (contract item 30).
   */
  | { status: 'dropped'; reason?: string };

/** Returning nothing means `ok`; throwing means `retry`. */
export type FlushCallback = (
  events: QueuedEvent[],
  identify?: PendingIdentify,
) => Promise<FlushOutcome | void>;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as any).onLine === false;
}

/**
 * May this identify ride with this batch? Only with events of the anonymous
 * id it merges, and of no OTHER user: under SDK authentication a request is
 * verified against one user's token.
 */
function identifyMatches(identify: PendingIdentify, batch: QueuedEvent[]): boolean {
  return batch.every((e) => e.anonymousId === identify.anonymousId && (!e.userId || e.userId === identify.userId));
}

export class QueueManager {
  private storage: StorageManager;
  private logger: Logger;
  private queue: QueuedEvent[] = [];
  private batchSize: number;
  private flushInterval: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushCallback: FlushCallback | null = null;
  private persistQueue: boolean;
  private maxQueueSize: number;
  private retryBackoffMs: number;
  /** A coalesced storage write is outstanding — see schedulePersist(). */
  private pendingPersist = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing: boolean = false;
  private flushWaiters: (() => void)[] = [];
  /** Identifies not yet confirmed by the server, oldest first. */
  private pendingIdentifies: PendingIdentify[] = [];
  private inflightEvents: QueuedEvent[] = [];
  /** Consent is pending: collect, never send. */
  private paused = false;
  /** 402/403/invalid key: nothing more is sent this page view. */
  private suspended = false;
  /** Consecutive retryable failures, for exponential backoff. */
  private consecutiveFailures = 0;
  /** Earliest time the next send may be attempted (the SDK's own backoff). */
  private nextAttemptAt = 0;
  /**
   * Earliest time the SERVER allowed (Retry-After). Kept apart from the own
   * backoff because a forced flush skips the backoff but never this
   * (contract item 35).
   */
  private retryAfterUntil = 0;
  /**
   * Bumped by clear(). A flush that was awaiting the network when the queue
   * was cleared (opt-out, consent denied) must not put its batch back: the
   * visitor withdrew, and restoring it would send it on the next flush.
   */
  private generation = 0;
  /**
   * Told what a request that was in flight when clear() ran actually
   * delivered (rule 90): the server's answer still settles it, even though
   * nothing of it comes back to the queue.
   */
  private clearedInflightCallback: ((delivered: QueuedEvent[]) => void) | null = null;

  constructor(
    storage: StorageManager,
    logger: Logger,
    batchSize: number,
    flushInterval: number,
    persistQueue: boolean = true,
    maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE,
    retryBackoffMs: number = 1000,
  ) {
    this.storage = storage;
    this.logger = logger;
    this.batchSize = batchSize > 0 ? Math.floor(batchSize) : 50;
    this.flushInterval = flushInterval;
    this.persistQueue = persistQueue;
    // A cap below 1 would drop every event on enqueue; treat it as "default".
    this.maxQueueSize = maxQueueSize > 0 ? Math.floor(maxQueueSize) : DEFAULT_MAX_QUEUE_SIZE;
    this.retryBackoffMs = retryBackoffMs > 0 ? retryBackoffMs : 1000;

    // Load persisted queue and recover any in-flight events from a previous
    // page load that was interrupted (e.g., OAuth redirect canceled the XHR).
    if (this.persistQueue) {
      const inflight = this.storage.get<QueuedEvent[]>(INFLIGHT_KEY) || [];
      const queued = this.storage.get<QueuedEvent[]>(QUEUE_KEY) || [];
      // Put recovered in-flight events first (they were enqueued earlier)
      this.queue = [...inflight, ...queued];
      if (inflight.length > 0) {
        this.storage.remove(INFLIGHT_KEY);
        this.logger.debug(`Recovered ${inflight.length} in-flight events from previous page`);
      }
      if (this.queue.length > this.maxQueueSize) {
        this.queue = this.queue.slice(-this.maxQueueSize);
      }
      if (this.queue.length > 0) {
        this.logger.debug(`Loaded ${this.queue.length} events from storage`);
        this.persistQueueToStorage();
      }

      // Recover pending identify from a previous page load (e.g., identify flush
      // was interrupted by OAuth redirect or page navigation after signup)
      // An array since 1.3.0; a single object from an earlier version.
      const persisted = this.storage.get<PendingIdentify | PendingIdentify[]>(PENDING_IDENTIFY_KEY);
      const list = Array.isArray(persisted) ? persisted : persisted ? [persisted] : [];
      this.pendingIdentifies = list
        .filter((i) => i && typeof i.userId === 'string' && typeof i.anonymousId === 'string')
        .slice(-MAX_PENDING_IDENTIFIES);
      if (this.pendingIdentifies.length) {
        this.logger.debug(`Recovered ${this.pendingIdentifies.length} pending identify(s) from a previous page`);
      }
    }
  }

  /**
   * Set the flush callback
   */
  setFlushCallback(callback: FlushCallback): void {
    this.flushCallback = callback;
  }

  /** Hold everything locally (consent pending) or release it. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** True after a 402/403/invalid key stopped sending for this page view. */
  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * The last send failed (offline, timeout, 429, 5xx) or the server asked to
   * wait: a keepalive at unload would most likely fail the same way, and the
   * events it carried would be gone - so the unload path keeps them instead.
   */
  isBackingOff(): boolean {
    return this.consecutiveFailures > 0 || Date.now() < this.retryAfterUntil;
  }

  /** The browser came back online: try again now rather than after the backoff. */
  resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    // NOT retryAfterUntil: the server's Retry-After is honoured even when the
    // browser comes back online.
  }

  /**
   * Record an identify, to be sent with the events that precede it.
   *
   * Identifies queue up in call order. The same user on the same anonymous id
   * replaces the last one (an identical merge); anything else is appended, so
   * `identify('A')` made offline survives a later `reset(); identify('B')`.
   */
  setPendingIdentify(identify: PendingIdentify): void {
    const last = this.pendingIdentifies[this.pendingIdentifies.length - 1];
    const entry: PendingIdentify = { userId: identify.userId, anonymousId: identify.anonymousId, attributes: identify.attributes || {} };
    if (last && last.userId === entry.userId && last.anonymousId === entry.anonymousId) {
      // Same merge again: nothing new to send (the one in the list may be on
      // the wire right now, and replacing it would orphan its answer).
      return;
    }
    this.pendingIdentifies.push(entry);
    if (this.pendingIdentifies.length > MAX_PENDING_IDENTIFIES) {
      const dropped = this.pendingIdentifies.shift()!;
      this.logger.warn(`Too many identify calls waiting to be sent; dropped the oldest (${dropped.userId})`);
    }
    this.persistIdentifies();
  }

  private persistIdentifies(): void {
    if (!this.persistQueue) return;
    try {
      if (this.pendingIdentifies.length) this.storage.set(PENDING_IDENTIFY_KEY, this.pendingIdentifies);
      else this.storage.remove(PENDING_IDENTIFY_KEY);
    } catch (error) {
      this.logger.error('Failed to persist pending identify:', error);
    }
  }

  /** The oldest identify not yet confirmed, or null. */
  getPendingIdentify(): PendingIdentify | null {
    return this.pendingIdentifies[0] || null;
  }

  /** Every identify not yet confirmed, oldest first. */
  getPendingIdentifies(): PendingIdentify[] {
    return [...this.pendingIdentifies];
  }

  /** The identify reached the server, or was refused for good: forget it. */
  private removeIdentify(identify: PendingIdentify): void {
    const i = this.pendingIdentifies.indexOf(identify);
    if (i >= 0) this.pendingIdentifies.splice(i, 1);
    this.persistIdentifies();
  }

  /** A failed attempt: counted when it was a refusal, and dropped once refused too often. */
  private identifyAttemptFailed(identify: PendingIdentify, counts: boolean): void {
    if (!counts) {
      this.persistIdentifies();
      return;
    }
    identify.attempts = (identify.attempts || 0) + 1;
    if (identify.attempts >= MAX_IDENTIFY_ATTEMPTS) {
      this.logger.error(`Identify for ${identify.userId} failed ${identify.attempts} times; dropping it`);
      this.removeIdentify(identify);
    } else {
      this.persistIdentifies();
    }
  }

  /**
   * Start the automatic flush timer
   */
  start(): void {
    if (this.flushTimer) {
      this.logger.debug('Queue manager already started');
      return;
    }

    this.flushTimer = setInterval(() => {
      // flush() handles its own errors, but say so explicitly: an unhandled
      // rejection from an SDK fires the HOST page's onunhandledrejection and
      // lands in their monitoring as if their app had failed.
      this.flush().catch((error) => this.logger.error('Scheduled flush failed:', error));
    }, this.flushInterval);

    this.logger.debug(`Queue manager started (batch: ${this.batchSize}, interval: ${this.flushInterval}ms)`);

    // Flush any persisted events immediately
    if (this.queue.length > 0 || this.pendingIdentifies.length) {
      this.flush().catch((error) => this.logger.error('Startup flush failed:', error));
    }
  }

  isStarted(): boolean {
    return this.flushTimer !== null;
  }

  /**
   * Stop the automatic flush timer
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      this.logger.debug('Queue manager stopped');
    }
    // Teardown must not strand a coalesced write, or events enqueued in the
    // last 150ms would be lost on reset()/destroy.
    this.persistNow();
  }

  /**
   * Add an event to the queue
   */
  enqueue(event: QueuedEvent): void {
    this.queue.push(event);
    this.logger.debug(`Event queued: ${event.type} (queue size: ${this.queue.length})`);

    // Coalesced, NOT immediate: a direct write here re-serialized the whole
    // queue on every event (O(N²) for a burst, on the main thread). Unload and
    // flush still persist synchronously, so nothing that could lose events
    // depends on this timer. See schedulePersist().
    this.schedulePersist();

    // Prevent unbounded growth. Drop the OLDEST events with an honest warning -
    // this is the ONLY place events are dropped for lack of delivery (a retry
    // count never deletes anything; a device offline for a day keeps its
    // newest `maxQueueSize` events).
    this.trimToMax();

    // Auto-flush if batch size reached (don't await - fire and forget but safely)
    if (this.queue.length >= this.batchSize && !this.isFlushing) {
      this.logger.debug('Batch size reached, flushing queue');
      void this.flush();
    }
  }

  private trimToMax(): void {
    if (this.queue.length > this.maxQueueSize) {
      const droppedCount = this.queue.length - this.maxQueueSize;
      this.queue = this.queue.slice(-this.maxQueueSize);
      this.logger.warn(`Queue exceeded max size (${this.maxQueueSize}), dropped ${droppedCount} oldest event(s)`);
      // Also coalesced. Once the queue sits AT the cap every further event
      // truncates, so an immediate write here would reinstate the per-event
      // full re-serialize in exactly the case it hurts most.
      this.schedulePersist();
    }
  }

  /**
   * Take the next request's worth of events off the front of the queue:
   * at most min(batchSize, 500) events and ~900 KB.
   *
   * The whole queue used to go in ONE request - up to maxQueueSize (1000)
   * events against a backend that accepts 500 and 1 MB. The oversized request
   * was refused, re-queued at the front, refused again: one bad batch blocked
   * every later event forever.
   */
  private takeBatch(): QueuedEvent[] {
    const limit = Math.min(this.batchSize, MAX_EVENTS_PER_REQUEST);
    const out: QueuedEvent[] = [];
    let bytes = 64; // envelope + identify headroom
    // One identity per request (contract item 30): under SDK authentication a
    // request is verified against ONE user's token, so user A's events still
    // queued after a logout must not share a request with user B's - the
    // whole request was refused and blocked the queue. Cut at a change of
    // anonymous id (a reset) or of user id; events with no user id (before an
    // identify) ride with the user who follows on the same anonymous id.
    let batchUser: string | null = null;
    while (this.queue.length > 0 && out.length < limit) {
      const event = this.queue[0];
      if (out.length > 0) {
        if (event.anonymousId !== out[0].anonymousId) break;
        if (event.userId && batchUser && event.userId !== batchUser) break;
      }
      let size: number;
      try {
        size = utf8Length(JSON.stringify(event)) + 1;
      } catch {
        size = Number.POSITIVE_INFINITY; // circular properties: unsendable
      }
      if (size > MAX_REQUEST_BYTES) {
        // Can never fit in any request. The API's body-size refusal arrives
        // without CORS headers, so the browser would report it as "offline"
        // and the event would be retried forever.
        this.queue.shift();
        this.logger.error(`Dropping event "${event.type}": it is too large to send (${size} bytes)`);
        continue;
      }
      if (out.length > 0 && bytes + size > MAX_REQUEST_BYTES) break;
      out.push(this.queue.shift()!);
      if (event.userId) batchUser = event.userId;
      bytes += size;
    }
    return out;
  }

  /** Put events back at the FRONT of the queue (they are older than anything queued since). */
  private restoreToFront(events: QueuedEvent[]): void {
    if (!events.length) return;
    const present = new Set(this.queue.map((e) => e.eventId));
    const missing = events.filter((e) => !present.has(e.eventId));
    this.queue.unshift(...missing);
    this.trimToMax();
  }

  private backOff(retryAfterMs?: number): void {
    this.consecutiveFailures++;
    const exp = Math.min(
      this.retryBackoffMs * Math.pow(2, Math.min(this.consecutiveFailures - 1, 20)),
      MAX_BACKOFF_MS,
    );
    const jitter = exp * 0.2 * Math.random();
    const delay = Math.max(exp + jitter, Math.min(retryAfterMs ?? 0, MAX_BACKOFF_MS));
    this.nextAttemptAt = Date.now() + delay;
    if (retryAfterMs && retryAfterMs > 0) {
      this.retryAfterUntil = Date.now() + Math.min(retryAfterMs, MAX_BACKOFF_MS);
    }
    this.logger.debug(`Event send failed; next attempt in ${Math.round(delay)}ms`);
  }

  private async sendBatch(
    batch: QueuedEvent[],
    identify: PendingIdentify | null,
    waiting: QueuedEvent[] = [],
  ): Promise<FlushOutcome> {
    // In flight: kept in storage under INFLIGHT_KEY so a navigation that kills
    // the request does not lose them (recovered on the next page load).
    //
    // `waiting` is the rest of a refused batch, split in halves that have not
    // been sent yet. They are off the queue too, so they ride in the in-flight
    // record: they used to live only in a local array, and a page closed in
    // the middle of a split lost every one of them.
    this.inflightEvents = waiting.length ? [...batch, ...waiting] : batch;
    if (this.persistQueue) {
      this.persistQueueToStorage();
      this.persistInflightToStorage();
    }
    let outcome: FlushOutcome;
    try {
      outcome = (await this.flushCallback!(batch, identify ?? undefined)) || { status: 'ok' };
    } catch (error) {
      this.logger.error('Failed to flush events:', error);
      outcome = { status: 'retry' };
    }
    this.inflightEvents = [];
    if (this.persistQueue) this.storage.remove(INFLIGHT_KEY);
    return outcome;
  }

  /**
   * Send what is queued, in requests of at most min(batchSize, 500) events,
   * one identity per request. If a flush is already in progress, waits for it,
   * then sends whatever is still queued - so identify() can rely on flush()
   * covering its events.
   *
   * Never blocks the queue on one bad request: see FlushOutcome.
   *
   * @param throwOnError - reject when events could not be delivered (retry /
   *   suspended), so a caller can distinguish success from failure.
   * @param force - an explicit flush (flush(), identify, reset): skips the
   *   SDK's own backoff, never the server's Retry-After (contract item 35).
   */
  async flush(throwOnError: boolean = false, force: boolean = false): Promise<void> {
    // A flush in progress is waited for even when nothing is queued: it may
    // be carrying the only pending identify, and `await flush()` must mean
    // "what was queued has been dealt with".
    if (this.queue.length === 0 && !this.pendingIdentifies.length && !this.isFlushing) {
      return;
    }
    if (this.paused || this.suspended) {
      if (throwOnError) throw new Error(this.paused ? 'Sending is paused' : 'Sending is suspended');
      return;
    }

    if (this.isFlushing) {
      // Wait for the in-progress flush to finish
      await new Promise<void>((resolve) => this.flushWaiters.push(resolve));
      // Flush any events that were enqueued during the previous flush
      if (this.queue.length > 0 || this.pendingIdentifies.length) {
        return this.flush(throwOnError, force);
      }
      return;
    }

    const now = Date.now();
    if (now < this.retryAfterUntil || (!force && now < this.nextAttemptAt) || isOffline()) {
      if (throwOnError) throw new Error('Waiting to retry');
      return;
    }

    if (!this.flushCallback) {
      this.logger.warn('No flush callback set, cannot flush queue');
      return;
    }

    this.isFlushing = true;
    let failure: string | null = null;
    const generation = this.generation;
    try {
      // An identify whose request was refused together with events is
      // retried ALONE after them, so a bad identify cannot make good events
      // look bad (and the reverse).
      let identifyAloneLater: PendingIdentify | null = null;
      // Halves of a refused batch, waiting their turn (ahead of the queue).
      const splits: QueuedEvent[][] = [];
      // Bound the work to what was queued when the flush began, so a page
      // that tracks continuously cannot keep one flush running forever.
      let budget = this.queue.length;
      // Identifies already sent alone in this flush (no second try now).
      const triedAlone = new Set<PendingIdentify>();

      for (;;) {
        let batch: QueuedEvent[];
        if (splits.length > 0) {
          batch = splits.shift()!;
        } else if (budget > 0) {
          batch = this.takeBatch();
          budget -= batch.length;
          if (batch.length === 0) budget = 0;
        } else if (
          this.pendingIdentifies[0] &&
          !triedAlone.has(this.pendingIdentifies[0]) &&
          this.pendingIdentifies[0] !== identifyAloneLater &&
          this.queue.length > 0 &&
          identifyMatches(this.pendingIdentifies[0], [this.queue[0]])
        ) {
          // An identify made while this flush was running: the events of its
          // anonymous id queued before it go WITH it, not after it alone.
          batch = this.takeBatch();
        } else {
          batch = [];
        }

        // The oldest identify rides with the batch it follows - the events
        // of the anonymous id it merges, or its own user's. A batch of
        // another identity goes without it, and an identify with no batch
        // left goes alone at the end.
        const head = this.pendingIdentifies[0] || null;
        let identify: PendingIdentify | null = null;
        if (head && !triedAlone.has(head)) {
          if (batch.length === 0) identify = head;
          else if (head !== identifyAloneLater && identifyMatches(head, batch)) identify = head;
        }

        if (batch.length === 0 && !identify) break;
        if (batch.length === 0 && identify) triedAlone.add(identify);

        this.logger.debug(`Flushing ${batch.length} events${identify ? ' + identify' : ''}`);
        const outcome = await this.sendBatch(batch, identify, splits.flat());

        if (this.generation !== generation) {
          // clear() ran while this request was in flight (opt-out, consent
          // denied): whatever the outcome, nothing of it may come back.
          this.logger.debug('Queue cleared during a flush; the in-flight batch is not restored');
          if (this.clearedInflightCallback) {
            let delivered: QueuedEvent[] = [];
            if (outcome.status === 'ok') {
              const notStored = new Set([...(outcome.failedIndices || []), ...(outcome.rejectedIndices || [])]);
              delivered = batch.filter((_, i) => !notStored.has(i));
            }
            try {
              this.clearedInflightCallback(delivered);
            } catch (error) {
              this.logger.warn('Cleared in-flight callback failed:', error);
            }
          }
          break;
        }

        if (outcome.status === 'dropped') {
          this.logger.error(
            `${batch.length} event(s)${identify ? ' and an identify' : ''} of a user who is no longer signed in were ` +
              `refused by SDK authentication (${outcome.reason || '401'}) and have been dropped`,
          );
          if (identify) this.removeIdentify(identify);
          continue;
        }

        if (outcome.status === 'ok') {
          const inBatch = (list?: number[]) =>
            new Set((list || []).filter((i) => Number.isInteger(i) && i >= 0 && i < batch.length));
          const rejected = inBatch(outcome.rejectedIndices);
          for (const i of rejected) {
            this.logger.error(`Event "${batch[i].type}" was refused by the server for good and has been dropped`);
          }
          const failed = [...inBatch(outcome.failedIndices)].filter((i) => !rejected.has(i)).map((i) => batch[i]);

          if (identify && outcome.identifyDropped) {
            this.logger.error(`Identify for ${identify.userId} was refused by the server; dropping it`);
            this.removeIdentify(identify);
            identify = null;
          }
          if (identify && outcome.identifyFailed) {
            // The events were stored (bar `failedIndices`); the identify was
            // not. Keep it and come back later rather than drop the merge.
            this.identifyAttemptFailed(identify, outcome.identifyAttemptCounts !== false);
            this.restoreToFront([...failed, ...splits.flat()]);
            this.backOff();
            failure = 'The identify was not confirmed';
            break;
          }
          if (identify) this.removeIdentify(identify);
          this.consecutiveFailures = 0;
          this.nextAttemptAt = 0;
          if (failed.length > 0) {
            // 2xx with `success: false`: the server stored the others. Keep
            // only what it says it could not store, and come back later.
            this.logger.warn(`${failed.length} of ${batch.length} events were not stored by the server; will retry them`);
            this.restoreToFront([...failed, ...splits.flat()]);
            this.backOff();
            failure = 'Some events were not stored';
            break;
          }
          continue;
        }

        if (outcome.status === 'rejected') {
          if (identify) {
            if (batch.length === 0) {
              this.logger.error(`Identify for ${identify.userId} was refused by the server (HTTP ${outcome.httpStatus ?? '4xx'}); dropping it`);
              this.removeIdentify(identify);
              continue;
            }
            // Was it the identify or the events? Send the events without
            // it; the identify goes alone at the end.
            identifyAloneLater = identify;
            splits.unshift(batch);
            continue;
          }
          if (batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            splits.unshift(batch.slice(0, mid), batch.slice(mid));
            continue;
          }
          if (batch.length === 1) {
            this.logger.error(
              `Event "${batch[0].type}" was refused by the server (HTTP ${outcome.httpStatus ?? '4xx'}) and has been dropped`,
            );
          }
          continue;
        }

        // retry / suspended: keep everything, in order.
        this.restoreToFront([...batch, ...splits.flat()]);
        if (identify && outcome.status === 'retry') this.identifyAttemptFailed(identify, outcome.counts === true);
        if (outcome.status === 'suspended') {
          if (!this.suspended) {
            this.suspended = true;
            // eslint-disable-next-line no-console -- the logger is silent by default and the site owner must see this
            console.warn(
              `[Joryio SDK] Event sending stopped for this page view (${outcome.reason || 'refused'}). ` +
                `${this.queue.length} queued event(s) are kept.`,
            );
          }
          if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
          }
          failure = 'Sending is suspended';
        } else {
          this.backOff(outcome.retryAfterMs);
          failure = 'Events could not be delivered; will retry';
        }
        break;
      }

      if (this.persistQueue) {
        this.persistQueueToStorage();
      }
    } finally {
      this.isFlushing = false;
      // Wake up any callers that were waiting for this flush to complete
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
    if (failure && throwOnError) {
      throw new Error(failure);
    }
  }

  /**
   * Persist queue to storage
   */
  private persistQueueToStorage(): void {
    this.pendingPersist = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      this.storage.set(QUEUE_KEY, this.queue);
    } catch (error) {
      this.logger.error('Failed to persist queue to storage:', error);
    }
  }

  /**
   * Persist soon, coalescing a burst of events into ONE write.
   *
   * `enqueue` used to call [persistQueueToStorage] directly, so every single
   * event re-serialized the WHOLE queue and wrote it to localStorage — both
   * synchronous, on the main thread. That is O(queue) per event, i.e. O(N²) to
   * fill the queue: measured at ~261ms of JSON.stringify alone to reach the
   * 1000-event cap (vs ~1.5ms if each event were serialized once), before the
   * localStorage write of a ~295KB string is even counted.
   *
   * It matters most in the worst place: the queue only grows when flushes are
   * failing, so the pathological cost lands on a device that is already on a bad
   * connection.
   *
   * Durability is unchanged in every case that can actually lose data — the
   * unload path and flush persist synchronously (see [persistNow]) — so the only
   * exposure is a hard crash inside the coalescing window.
   */
  private schedulePersist(): void {
    if (!this.persistQueue || this.pendingPersist) return;
    this.pendingPersist = true;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.pendingPersist) this.persistQueueToStorage();
    }, PERSIST_COALESCE_MS);
  }

  /**
   * Write immediately if a coalesced write is still outstanding. Call before
   * anything that must not lose events: page unload, flush, teardown.
   */
  persistNow(): void {
    if (this.persistQueue && this.pendingPersist) {
      this.persistQueueToStorage();
    }
  }

  /**
   * Persist in-flight events to storage so they survive page navigation
   */
  private persistInflightToStorage(): void {
    try {
      if (this.inflightEvents.length > 0) {
        this.storage.set(INFLIGHT_KEY, this.inflightEvents);
      } else {
        this.storage.remove(INFLIGHT_KEY);
      }
    } catch (error) {
      this.logger.error('Failed to persist in-flight events to storage:', error);
    }
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get a copy of all queued AND in-flight events (for the page-unload send).
   * In-flight events are included because the request may be canceled by navigation.
   */
  getQueuedEvents(): QueuedEvent[] {
    return [...this.inflightEvents, ...this.queue];
  }

  /** Queued events not yet handed to a request (no in-flight ones). */
  getWaitingEvents(): QueuedEvent[] {
    return [...this.queue];
  }

  /** In-flight events (a request is carrying them now). */
  getInflightEvents(): QueuedEvent[] {
    return [...this.inflightEvents];
  }

  /** See clearedInflightCallback. */
  setClearedInflightCallback(cb: ((delivered: QueuedEvent[]) => void) | null): void {
    this.clearedInflightCallback = cb;
  }

  /**
   * The page is going away and these events (and identify) were handed to the
   * browser in keepalive requests: stop holding them. ONLY these - events the
   * unload path could not fit stay queued and persisted for the next page.
   */
  markHandedOff(events: QueuedEvent[], identify: PendingIdentify | null): void {
    const ids = new Set(events.map((e) => e.eventId));
    this.queue = this.queue.filter((e) => !ids.has(e.eventId));
    this.inflightEvents = this.inflightEvents.filter((e) => !ids.has(e.eventId));
    if (identify) this.removeIdentify(identify);
    if (this.persistQueue) {
      this.persistQueueToStorage();
      this.persistInflightToStorage();
    }
  }

  /**
   * A keepalive hand-off failed and the page is still here (bfcache, a
   * cancelled unload): take the events back.
   */
  takeBack(events: QueuedEvent[], identify: PendingIdentify | null): void {
    this.restoreToFront(events);
    if (identify && !this.pendingIdentifies.includes(identify)) {
      this.pendingIdentifies.unshift(identify);
      this.persistIdentifies();
    }
    if (this.persistQueue) this.persistQueueToStorage();
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.generation++;
    this.queue = [];
    this.inflightEvents = [];
    if (this.persistQueue) {
      this.storage.remove(QUEUE_KEY);
      this.storage.remove(INFLIGHT_KEY);
      this.storage.remove(PENDING_IDENTIFY_KEY);
    }
    this.pendingIdentifies = [];
    this.logger.debug('Queue cleared');
  }

  /**
   * Destroy the queue manager
   */
  async destroy(): Promise<void> {
    this.stop();

    // Final flush attempt
    if (this.queue.length > 0) {
      this.logger.debug('Flushing remaining events before destroy');
      await this.flush();
    }
  }
}
