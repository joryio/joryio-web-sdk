/**
 * The web SDK's persisted, ordered outbox for profile writes (SDK 1.3.0
 * contract items 28, 36, 37, 38, 40): subscription and subscription-group
 * changes, aliases and the `tracking_opted_out` marker.
 *
 * Why it exists. These writes used to be fire-and-forget closures, each with
 * its own retry loop:
 *  - two changes to the same channel were not ordered, so a retried older
 *    `subscribed` could land after a newer `unsubscribed` and invert it;
 *  - a retry loop kept sending after optOut(), a denied consent or wipeData();
 *  - once consent was granted they lived only in memory, so a navigation lost
 *    them (a newsletter sign-up followed by a redirect never arrived).
 *
 * Now every write is a DATA record in one list, kept in localStorage, sent one
 * request at a time:
 *  - a newer write to the same subject (channel, group, the marker) of the same
 *    person supersedes an older one still waiting, and an older one already on
 *    the wire is never retried once a newer one is queued behind it - so no
 *    older write can land after a newer one;
 *  - a write is sent only while the SDK may send, re-checked before EVERY
 *    attempt; opt-out, denied consent and wipeData() discard every write that
 *    is not a WITHDRAWAL, and withdrawals (unsubscribes, the opt-out marker)
 *    are always delivered;
 *  - ids are resolved at SEND time: a write made while anonymous goes out with
 *    the user id once that anonymous id has been identified (otherwise SDK
 *    authentication refuses it with 403 SDK_ANONYMOUS_ID_IDENTIFIED);
 *  - retries follow the one rule of write-retry.ts (offline, 429 and 5xx never
 *    count toward the cap);
 *  - at page unload the ready writes are handed to the browser with fetch
 *    keepalive, and stay stored until acknowledged (a resend is harmless).
 */

import type { Logger } from '../utils/logger';
import type { StorageManager } from './storage';
import type { NetworkResponse } from './network';
import { generateUUID } from '../utils/uuid';
import {
  WriteRecord,
  WriteOwner,
  isWithdrawal,
  classifyWriteResponse,
  writeAttemptsExhausted,
  writeRetryDelay,
} from './write-retry';

/** Where the outbox lives. */
export const OUTBOX_KEY = 'write_outbox';
/** Where an earlier build kept writes held while consent was pending. */
export const LEGACY_DEFERRED_WRITES_KEY = 'deferred_writes';
/**
 * Ids of writes that left the shared list - settled, replaced by a newer write
 * of the same subject, or discarded - and when (rule 77). Another tab still
 * holding one of them in memory drops it instead of sending it: an older
 * subscribe waiting out a backoff in tab A must not land after the newer
 * unsubscribe tab B already delivered.
 */
export const OUTBOX_REMOVED_KEY = 'write_outbox_removed';
/** Bound on stored writes; the oldest non-withdrawal goes first. */
export const MAX_OUTBOX_ENTRIES = 200;
/** Bound on remembered removals (newest kept), and how long one is remembered. */
const MAX_REMOVED_IDS = 500;
const REMOVED_ID_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A write handed to keepalive is not handed off again within this window (one unload). */
const UNLOAD_HANDOFF_WINDOW_MS = 10_000;

export interface OutboxEntry {
  id: string;
  record: WriteRecord;
  withdrawal: boolean;
  /** Counted attempts (contract item 40), apart from 404s. */
  attempts: number;
  /** 404 "no profile yet" attempts. */
  notFoundAttempts: number;
  /** Every failed attempt, for the backoff. */
  failures: number;
  /** Not before this time (backoff, Retry-After). */
  notBefore: number;
  /** When the write was made (epoch ms): orders writes of several tabs in the shared store. */
  createdAt: number;
}

export type OutboxGate = 'send' | 'hold' | 'drop';

export interface OutboxDeps {
  storage: StorageManager;
  logger: Logger;
  /** May this write go now ('hold': later; 'drop': never - e.g. opted out). */
  gate(entry: OutboxEntry): OutboxGate;
  /** The ids this write is sent with (contract item 38). */
  resolveOwner(owner: WriteOwner): WriteOwner;
  /** Is this the signed-in user's write (for an SDK-authentication 401)? */
  ownerIsCurrentUser(owner: WriteOwner): boolean;
  /** The current identity, to tell whether two writes are about the same person. */
  currentIdentity(): { anonymousId: string; userId: string | null };
  /** Send one write. Must never reject (a NetworkResponse with ok:false instead). */
  send(entry: OutboxEntry, owner: WriteOwner): Promise<NetworkResponse>;
  /** Before an attempt: get queued events and any identify to the server. */
  beforeSend(entry: OutboxEntry): Promise<void>;
  isSdkAuthError(status: number, data: any): boolean;
  /** A write left the outbox: stored ('done') or given up ('drop'). */
  onSettled?(entry: OutboxEntry, outcome: 'done' | 'drop'): void;
  /** Hand one write to the browser at unload; returns the bytes used, or null. */
  keepalive?(entry: OutboxEntry, owner: WriteOwner): number | null;
}

export function ownerOf(record: WriteRecord): WriteOwner {
  const p: any = record.payload;
  return { anonymousId: p.anonymousId, ...(p.userId ? { userId: p.userId } : {}) };
}

/** The subject a newer write replaces an older one on; null = never superseded. */
export function subjectOf(record: WriteRecord): string | null {
  switch (record.kind) {
    case 'subscription':
      return `subscription:${record.payload.channel}`;
    case 'group':
      return `group:${record.payload.groupId}:${record.payload.channel}`;
    case 'marker':
      return 'marker';
    default:
      return null;
  }
}

export function labelOf(record: WriteRecord): string {
  switch (record.kind) {
    case 'alias':
      return 'addAlias';
    case 'subscription':
      return `Update ${record.payload.channel} subscription`;
    case 'group':
      return `Subscription group ${record.payload.groupId} ${record.payload.action}`;
    case 'marker':
      return 'The tracking_opted_out marker';
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (navigator as any).onLine === false;
}

function isRecord(raw: any): raw is WriteRecord {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw.kind === 'alias' || raw.kind === 'subscription' || raw.kind === 'group' || raw.kind === 'marker') &&
    !!raw.payload &&
    typeof raw.payload === 'object' &&
    typeof raw.payload.anonymousId === 'string'
  );
}

/** One stored write, or null when it is malformed. */
function entryFromStored(raw: any): OutboxEntry | null {
  if (!raw || !isRecord(raw.record)) return null;
  const count = (n: any) => (Number.isInteger(n) && n >= 0 ? n : 0);
  return {
    id: typeof raw.id === 'string' ? raw.id : generateUUID(),
    record: raw.record,
    withdrawal: isWithdrawal(raw.record),
    attempts: count(raw.attempts),
    notFoundAttempts: count(raw.notFoundAttempts),
    failures: count(raw.failures),
    // A new page view tries again now.
    notBefore: 0,
    // Stored by an earlier build: older than anything made now.
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
  };
}

export class WriteOutbox {
  private entries: OutboxEntry[] = [];
  private inFlight: OutboxEntry | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The key was refused (a 401 that is not SDK authentication): nothing more
   * this page view (kept for the next one). NOT a 402: a paused workspace
   * still accepts withdrawals, so a 402 only holds the writes that are not
   * (rule 50; the SDK's gate does that).
   */
  private stopped = false;
  /**
   * Writes handed to keepalive at this unload, and when. An unload runs
   * `beforeunload` AND `pagehide`; the second must not hand the same writes
   * off again (the browser's 64 KiB keepalive budget is shared).
   */
  private handedOffAt = new Map<string, number>();
  private destroyed = false;
  /**
   * Ids of every write this tab loaded or made. The stored list is shared by
   * every tab of the site (rule 62): an id in it that is NOT here is another
   * tab's write, kept when this tab stores its own list; an id that is here
   * but no longer in `entries` was settled or discarded by this tab.
   */
  private knownIds = new Set<string>();

  constructor(private readonly deps: OutboxDeps) {
    this.load();
  }

  /** Queue a write (after the caller checked it may be made at all). */
  enqueue(record: WriteRecord): void {
    if (this.destroyed) return;
    const entry: OutboxEntry = {
      id: generateUUID(),
      record,
      withdrawal: isWithdrawal(record),
      attempts: 0,
      notFoundAttempts: 0,
      failures: 0,
      notBefore: 0,
      createdAt: Date.now(),
    };
    this.knownIds.add(entry.id);
    const subject = subjectOf(record);
    if (subject) {
      // A newer write to the same subject of the same person: what was still
      // waiting is moot. One already on the wire is answered first, and not
      // retried (see run()).
      this.entries = this.entries.filter(
        (e) => e === this.inFlight || subjectOf(e.record) !== subject || !this.sameOwner(e.record, record),
      );
    }
    this.entries.push(entry);
    this.trim();
    this.persist();
    this.kick();
  }

  /**
   * Opt-out, consent denied, wipeData(): forget every write that is not a
   * withdrawal. One on the wire is forgotten too - its answer is ignored.
   */
  discardNonWithdrawals(): void {
    this.entries = this.entries.filter((e) => e.withdrawal);
    // Every tab's: the decision is the site's, and a tab that closed left its
    // writes only in storage (contract item 21, scan 7 N6).
    this.persist({ discardNonWithdrawals: true });
  }

  /** Store this tab's list again (another tab cleared localStorage). */
  persistNow(): void {
    this.persist();
  }

  /** Is a write matching this test still waiting (or on the wire)? */
  find(test: (entry: OutboxEntry) => boolean): OutboxEntry | undefined {
    return this.entries.find(test);
  }

  /** The newest waiting write matching this test. */
  findLast(test: (entry: OutboxEntry) => boolean): OutboxEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) if (test(this.entries[i])) return this.entries[i];
    return undefined;
  }

  /** Remove waiting writes matching this test (never the one on the wire). */
  cancel(test: (entry: OutboxEntry) => boolean): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e === this.inFlight || !test(e));
    if (this.entries.length !== before) this.persist();
  }

  /**
   * The identity is about to change: writes made while `anonymousId` was
   * anonymous belong to `userId` from now on (see resolveOwner).
   */
  pinOwner(anonymousId: string, userId: string): void {
    let changed = false;
    for (const e of this.entries) {
      const payload: any = e.record.payload;
      if (payload.anonymousId === anonymousId && !payload.userId) {
        e.record = { ...e.record, payload: { ...payload, userId } } as WriteRecord;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  isInFlight(entry: OutboxEntry): boolean {
    return this.inFlight === entry;
  }

  size(): number {
    return this.entries.length;
  }

  /** The waiting writes, oldest first (tests and diagnostics). */
  records(): WriteRecord[] {
    return this.entries.map((e) => e.record);
  }

  /** Send what may be sent now. Safe to call at any time. */
  kick(): void {
    if (this.destroyed || this.stopped || this.inFlight) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Offline: the SDK kicks again on the browser's `online` event.
    if (isOffline()) return;
    const now = Date.now();
    const blocked = new Set<string>();
    let wake = Number.POSITIVE_INFINITY;
    let pick: OutboxEntry | null = null;
    for (const entry of [...this.entries]) {
      const key = this.blockKey(entry);
      if (blocked.has(key)) continue;
      const gate = this.safeGate(entry);
      if (gate === 'drop') {
        this.remove(entry); // not allowed any more (opt-out): discarded, not refused
        continue;
      }
      if (gate === 'hold') {
        blocked.add(key);
        continue;
      }
      if (entry.notBefore > now) {
        blocked.add(key);
        wake = Math.min(wake, entry.notBefore);
        continue;
      }
      pick = entry;
      break;
    }
    if (pick) {
      void this.run(pick);
      return;
    }
    if (wake < Number.POSITIVE_INFINITY) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, Math.max(0, wake - now));
    }
  }

  /**
   * Page unload: hand the writes that may go now to the browser with fetch
   * keepalive. They STAY stored until acknowledged on a later page view (a
   * repeated subscription or alias write is harmless); only one write per
   * subject is handed off, so two of one subject never race.
   *
   * The same rule-77 check as run() first (rule 85): a write another tab
   * settled, or replaced with a newer one, is never handed off - a tab
   * closing with an older subscribe in its backoff must not land it after
   * the other tab's newer unsubscribe. persist() drops what the stored
   * removal list names and what a newer stored write replaced;
   * removedElsewhere() catches the rest.
   */
  handOffAtUnload(budgetBytes: number): number {
    let used = 0;
    if (!this.deps.keepalive || this.destroyed || this.stopped || isOffline()) return used;
    this.persist();
    const now = Date.now();
    const blocked = new Set<string>();
    if (this.inFlight) blocked.add(this.blockKey(this.inFlight));
    for (const entry of [...this.entries]) {
      const key = this.blockKey(entry);
      if (blocked.has(key)) continue;
      if (entry !== this.inFlight && this.removedElsewhere(entry)) {
        this.deps.logger.debug(`${labelOf(entry.record)} not handed off: another tab settled or replaced it`);
        const i = this.entries.indexOf(entry);
        if (i >= 0) this.entries.splice(i, 1);
        continue;
      }
      blocked.add(key);
      if (entry === this.inFlight || this.safeGate(entry) !== 'send') continue;
      const handed = this.handedOffAt.get(entry.id);
      if (handed !== undefined && now - handed < UNLOAD_HANDOFF_WINDOW_MS) continue;
      try {
        const bytes = this.deps.keepalive(entry, this.deps.resolveOwner(ownerOf(entry.record)));
        if (bytes === null) break;
        this.handedOffAt.set(entry.id, now);
        used += bytes;
        if (used >= budgetBytes) break;
      } catch {
        break;
      }
    }
    this.persist();
    return used;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------

  private async run(entry: OutboxEntry): Promise<void> {
    this.inFlight = entry;
    const label = labelOf(entry.record);
    try {
      await this.deps.beforeSend(entry).catch(() => undefined);
      // Re-checked after the await: an opt-out, a denial or a wipe meanwhile.
      if (!this.entries.includes(entry)) return;
      const gate = this.safeGate(entry);
      if (gate === 'drop') {
        this.remove(entry);
        return;
      }
      if (gate === 'hold') return;
      // Another tab settled this write, or made a newer one of the same
      // subject for the same person (rule 77): sending it now could land an
      // older choice after a newer one, or send it twice.
      if (this.removedElsewhere(entry)) {
        this.deps.logger.debug(`${label} not sent: another tab settled or replaced it`);
        this.remove(entry);
        return;
      }

      const owner = this.deps.resolveOwner(ownerOf(entry.record));
      const res = await this.deps.send(entry, owner);
      // Discarded while on the wire (opt-out, wipe): its answer is moot.
      if (!this.entries.includes(entry)) return;

      const verdict = classifyWriteResponse(res, {
        isSdkAuthError: this.deps.isSdkAuthError(res.status, res.data),
        ownerIsCurrentUser: this.deps.ownerIsCurrentUser(owner),
      });
      switch (verdict.action) {
        case 'done':
          this.settle(entry, 'done');
          return;
        case 'drop':
          this.deps.logger.error(`${label} dropped: ${verdict.reason}`);
          this.settle(entry, 'drop');
          return;
        case 'hold':
          this.deps.logger.error(`${label} not sent: ${verdict.reason}; kept for the next page view`);
          this.stopped = true;
          return;
        case 'retry':
          if (this.hasNewerOfSameSubject(entry)) {
            // A newer write to this subject is queued: retrying this one
            // could land it after the newer one.
            this.remove(entry);
            return;
          }
          entry.failures++;
          if (verdict.counts) {
            if (verdict.notFound) entry.notFoundAttempts++;
            else entry.attempts++;
          }
          if (writeAttemptsExhausted(entry.attempts, entry.notFoundAttempts)) {
            this.deps.logger.error(`${label} failed (HTTP ${res.status || 'no response'}) too many times; dropping it`);
            this.settle(entry, 'drop');
            return;
          }
          entry.notBefore = Date.now() + writeRetryDelay(entry.failures, verdict.retryAfterMs);
          this.deps.logger.debug(`${label} failed with HTTP ${res.status || 'no response'}; retrying`);
          return;
      }
    } catch (error) {
      // A bug, not an answer: keep the write, back off, never throw.
      this.deps.logger.error(`${label} failed:`, error);
      entry.failures++;
      entry.notBefore = Date.now() + writeRetryDelay(entry.failures);
    } finally {
      if (this.inFlight === entry) this.inFlight = null;
      this.persist();
      this.kick();
    }
  }

  private safeGate(entry: OutboxEntry): OutboxGate {
    try {
      return this.deps.gate(entry);
    } catch {
      return 'hold';
    }
  }

  private settle(entry: OutboxEntry, outcome: 'done' | 'drop'): void {
    this.remove(entry);
    try {
      this.deps.onSettled?.(entry, outcome);
    } catch (error) {
      this.deps.logger.error('Outbox bookkeeping failed:', error);
    }
  }

  private remove(entry: OutboxEntry): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) {
      this.entries.splice(i, 1);
      this.persist();
    }
  }

  private hasNewerOfSameSubject(entry: OutboxEntry): boolean {
    const subject = subjectOf(entry.record);
    if (!subject) return false;
    const i = this.entries.indexOf(entry);
    return this.entries.slice(i + 1).some((e) => subjectOf(e.record) === subject && this.sameOwner(e.record, entry.record));
  }

  /** The user id a write will carry: its own, or the current one when its anonymous id is current. */
  private effectiveUser(owner: WriteOwner): string | null {
    if (owner.userId) return owner.userId;
    const current = this.deps.currentIdentity();
    return owner.anonymousId === current.anonymousId ? current.userId : null;
  }

  private sameOwner(a: WriteRecord, b: WriteRecord): boolean {
    const oa = ownerOf(a);
    const ob = ownerOf(b);
    return oa.anonymousId === ob.anonymousId && this.effectiveUser(oa) === this.effectiveUser(ob);
  }

  /** Writes of one subject and person go in order; anything else may pass. */
  private blockKey(entry: OutboxEntry): string {
    const owner = ownerOf(entry.record);
    return `${subjectOf(entry.record) ?? `${entry.record.kind}:${entry.id}`}|${owner.anonymousId}`;
  }

  /** Bound memory and storage: the oldest non-withdrawal waiting goes first. */
  private trim(): void {
    while (this.entries.length > MAX_OUTBOX_ENTRIES) {
      let i = this.entries.findIndex((e) => !e.withdrawal && e !== this.inFlight);
      if (i < 0) i = this.entries.findIndex((e) => e !== this.inFlight);
      if (i < 0) break;
      const [dropped] = this.entries.splice(i, 1);
      this.deps.logger.warn(`Too many profile writes waiting; dropped the oldest (${labelOf(dropped.record)})`);
    }
  }

  /**
   * Store this tab's list MERGED into the stored one (rule 62, scan 5 N8):
   * every tab writes the same key, and a blind overwrite lost the writes of
   * the others - an opt-out marker queued in tab A was gone once tab B stored
   * its list, and with it the withdrawal if tab A closed before sending it.
   * Another tab's writes are kept, in the order they were made; one of them
   * replaced by a newer write of this tab for the same subject and person is
   * dropped (and a newer one of theirs replaces a waiting one of ours).
   *
   * Every write that leaves the stored list is remembered under
   * OUTBOX_REMOVED_KEY (rule 77), and a write another tab removed is dropped
   * here too - never stored again by this tab, never sent (see run()).
   */
  private persist(options: { discardNonWithdrawals?: boolean } = {}): void {
    try {
      const stored = this.deps.storage.get<any[]>(OUTBOX_KEY);
      const storedIds = Array.isArray(stored)
        ? stored.filter((raw) => raw && typeof raw.id === 'string').map((raw) => raw.id as string)
        : [];
      const removed = this.readRemoved();
      // Settled or replaced by another tab: moot here too. (One on the wire
      // stays in memory until its answer; it is not stored again.)
      this.entries = this.entries.filter((e) => e === this.inFlight || !removed.has(e.id));
      let foreign = this.foreignStoredEntries(stored).filter((e) => !removed.has(e.id));
      if (options.discardNonWithdrawals) foreign = foreign.filter((e) => e.withdrawal);
      let kept: OutboxEntry[] = this.entries;
      if (foreign.length) {
        const merged = [...this.entries, ...foreign].sort((x, y) => x.createdAt - y.createdAt);
        const superseded = (e: OutboxEntry, i: number) => {
          const subject = subjectOf(e.record);
          return (
            !!subject &&
            e !== this.inFlight &&
            merged.slice(i + 1).some((n) => subjectOf(n.record) === subject && this.sameOwner(n.record, e.record))
          );
        };
        kept = merged.filter((e, i) => !superseded(e, i));
        // Bounded like one tab's list: the oldest non-withdrawal goes first,
        // whichever tab made it - a tab that closed left its writes only
        // here, so "theirs are still in their memory" does not hold (N3).
        while (kept.length > MAX_OUTBOX_ENTRIES) {
          let i = kept.findIndex((e) => !e.withdrawal && e !== this.inFlight);
          if (i < 0) i = kept.findIndex((e) => e !== this.inFlight);
          if (i < 0) break;
          this.deps.logger.warn(`Too many profile writes waiting; dropped the oldest (${labelOf(kept[i].record)})`);
          kept = kept.filter((_, j) => j !== i);
        }
        // A newer write of another tab replaced one of ours still waiting: ours is moot here too.
        this.entries = this.entries.filter((e) => e === this.inFlight || kept.includes(e));
      }
      const list = kept.filter((e) => !removed.has(e.id));
      this.write(list);
      const written = new Set(list.map((e) => e.id));
      const leaving = storedIds.filter((id) => !written.has(id) && !removed.has(id));
      if (leaving.length) this.writeRemoved(removed, leaving);
    } catch (error) {
      this.deps.logger.error('Failed to store pending profile writes:', error);
    }
  }

  /**
   * Did another tab settle this write, or store a newer write of the same
   * subject for the same person (rule 77)?
   */
  private removedElsewhere(entry: OutboxEntry): boolean {
    try {
      if (this.readRemoved().has(entry.id)) return true;
      const subject = subjectOf(entry.record);
      if (!subject) return false;
      const stored = this.deps.storage.get<any[]>(OUTBOX_KEY);
      if (!Array.isArray(stored)) return false;
      return stored.some(
        (raw) =>
          raw &&
          raw.id !== entry.id &&
          isRecord(raw.record) &&
          typeof raw.createdAt === 'number' &&
          raw.createdAt > entry.createdAt &&
          subjectOf(raw.record) === subject &&
          this.sameOwner(raw.record, entry.record),
      );
    } catch {
      return false;
    }
  }

  /** The remembered removals (id -> when), expired ones left out. */
  private readRemoved(): Map<string, number> {
    const out = new Map<string, number>();
    const stored = this.deps.storage.get<unknown>(OUTBOX_REMOVED_KEY);
    if (!Array.isArray(stored)) return out;
    const now = Date.now();
    for (const item of stored) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'number') continue;
      if (now - item[1] > REMOVED_ID_MAX_AGE_MS) continue;
      out.set(item[0], item[1]);
    }
    return out;
  }

  private writeRemoved(removed: Map<string, number>, leaving: string[]): void {
    const now = Date.now();
    const all: [string, number][] = [...removed.entries(), ...leaving.map((id): [string, number] => [id, now])];
    this.deps.storage.set(OUTBOX_REMOVED_KEY, all.slice(-MAX_REMOVED_IDS));
  }

  private write(list: OutboxEntry[]): void {
    if (list.length) {
      this.deps.storage.set(
        OUTBOX_KEY,
        list.map((e) => ({
          id: e.id,
          record: e.record,
          attempts: e.attempts,
          notFoundAttempts: e.notFoundAttempts,
          failures: e.failures,
          createdAt: e.createdAt,
        })),
      );
    } else {
      this.deps.storage.remove(OUTBOX_KEY);
    }
  }

  /** Stored writes this tab never saw: another tab's. */
  private foreignStoredEntries(stored: any[] | null): OutboxEntry[] {
    if (!Array.isArray(stored)) return [];
    const out: OutboxEntry[] = [];
    for (const raw of stored) {
      if (!raw || typeof raw.id !== 'string' || this.knownIds.has(raw.id) || !isRecord(raw.record)) continue;
      const entry = entryFromStored(raw);
      if (entry) out.push(entry);
    }
    return out;
  }

  private load(): void {
    const stored = this.deps.storage.get<any[]>(OUTBOX_KEY);
    if (Array.isArray(stored)) {
      // Every stored entry is read and THEN bounded by trim(), which drops the
      // oldest non-withdrawal first. A plain slice(-MAX) here dropped the
      // oldest entries whatever they were - an unsubscribe among them - when
      // another tab had stored more than the bound (contract v5 51).
      for (const raw of stored) {
        const entry = entryFromStored(raw);
        if (!entry) continue;
        this.entries.push(entry);
        this.knownIds.add(entry.id);
      }
    }
    // Writes an earlier build held while consent was pending.
    const legacy = this.deps.storage.get<any[]>(LEGACY_DEFERRED_WRITES_KEY);
    if (Array.isArray(legacy)) {
      for (const raw of legacy) {
        if (!isRecord(raw)) continue;
        const entry: OutboxEntry = {
          id: generateUUID(),
          record: raw,
          withdrawal: isWithdrawal(raw),
          attempts: 0,
          notFoundAttempts: 0,
          failures: 0,
          notBefore: 0,
          createdAt: 0,
        };
        this.entries.push(entry);
        this.knownIds.add(entry.id);
      }
      this.deps.storage.remove(LEGACY_DEFERRED_WRITES_KEY);
      this.trim();
      this.persist();
    } else if (this.entries.length > MAX_OUTBOX_ENTRIES) {
      this.trim();
      this.persist();
    }
  }
}
