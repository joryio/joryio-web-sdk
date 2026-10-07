import type { AttributeOps } from './network';
import type { WriteOwner } from './write-retry';

/** One attribute write, in call order. */
export type AttributeOpKind = 'set' | 'unset' | 'increment' | 'append' | 'remove';

export interface AttributeEntry {
  key: string;
  kind: AttributeOpKind;
  /** `set`: the value. `increment`: the summed delta. */
  value?: any;
  /** `append` / `remove`: every value, in call order, de-duplicated. */
  values?: any[];
  /** Carried by a request whose answer has not arrived: never merged into. */
  inFlight?: boolean;
  /**
   * Whose write this is, captured at the call (contract items 28, 31, 38).
   * A write of user A still waiting when the app calls identify('B') or
   * reset() is sent with A's ids, not the new ones; one made while anonymous
   * gets the user id at send time when that anonymous id was identified.
   * Absent on entries stored by an earlier build: the current identity.
   */
  owner?: WriteOwner;
  /** Counted failed attempts (contract item 40). */
  attempts?: number;
}

/** One request's worth of writes, and the entries it carries (for the ack). */
export interface AttributeRequest {
  ops: AttributeOps;
  entries: AttributeEntry[];
  /** Every entry of a request belongs to this one person. */
  owner?: WriteOwner;
}

/**
 * The ids an entry is SENT with (the SDK resolves an anonymous capture to the
 * user that anonymous id became). Requests group entries by this, so a write
 * made just before identify() rides with the ones made just after.
 */
export type OwnerResolver = (owner: WriteOwner | undefined) => WriteOwner | undefined;

function sameOwner(a?: WriteOwner, b?: WriteOwner): boolean {
  if (!a || !b) return !a && !b;
  return a.anonymousId === b.anonymousId && (a.userId || null) === (b.userId || null);
}

/**
 * Attribute writes the server has not acknowledged yet, as an ORDERED log.
 *
 * It used to be one map per operation (set / unset / append / remove), which
 * lost writes in three ways (scan 3, contract item 31):
 *
 *  - `addToArray('tags', 'a'); addToArray('tags', 'b')` kept ONE value per
 *    key, so only `b` was ever sent;
 *  - an `append` and a `remove` of the same key rode one request, and the API
 *    applies a single operator per key per request ($set > $inc > $addToSet >
 *    $pull > $unset), so the `remove` was silently skipped;
 *  - acknowledging by KEY cleared an append that was added while the request
 *    was in flight.
 *
 * Now every call appends an entry. Adjacent writes of the same kind on the
 * same key merge (two appends become one append of both values, two
 * increments one summed increment); an absolute write (`set` / `unset`)
 * supersedes everything still waiting for that key. A request carries at most
 * ONE entry per key - the oldest - so a later write to a key is always sent
 * after the earlier one is acknowledged, and never shares a request with it.
 * Acknowledgement removes the exact entries that were sent (by identity, so a
 * value added meanwhile survives).
 *
 * ## Which operations are retried
 *
 * `set`, `unset`, `append` and `remove` are idempotent and retried until the
 * server answers. `increment` is NOT: a retried `$inc` after an ambiguous
 * failure (request delivered, response lost) counts twice, so an increment
 * whose request failed ambiguously is reported and dropped instead (see
 * `release`).
 */
export class PendingAttributes {
  private entries: AttributeEntry[] = [];

  constructor(private readonly maxEntries = 500) {}

  /** Record one write at the end of the log. */
  add(kind: AttributeOpKind, key: string, value?: any, owner?: WriteOwner): void {
    if (!key) return;
    const who = owner ? { ...owner } : undefined;
    if (kind === 'set' || kind === 'unset') {
      // Absolute: whatever was still waiting for this key OF THIS PERSON is
      // moot - except what is already on the wire, which is answered first.
      this.entries = this.entries.filter((e) => e.key !== key || e.inFlight || !sameOwner(e.owner, who));
      this.entries.push(kind === 'set' ? { key, kind, value, owner: who } : { key, kind, owner: who });
      this.trim();
      return;
    }
    const last = this.lastFor(key);
    if (last && !last.inFlight && last.kind === kind && sameOwner(last.owner, who)) {
      if (kind === 'increment') {
        last.value = (Number(last.value) || 0) + Number(value);
      } else {
        for (const v of flatten(value)) if (!includesValue(last.values!, v)) last.values!.push(v);
      }
      return;
    }
    if (kind === 'increment') this.entries.push({ key, kind, value: Number(value), owner: who });
    else this.entries.push({ key, kind, values: dedupe(flatten(value)), owner: who });
    this.trim();
  }

  /**
   * Record an op payload (the sections in their API order). Kept for callers
   * and for state stored by an earlier SDK version.
   */
  mark(ops: AttributeOps, owner?: WriteOwner): void {
    for (const [k, v] of Object.entries(ops.attributes || {})) this.add('set', k, v, owner);
    for (const k of ops.unset || []) this.add('unset', k, undefined, owner);
    for (const [k, v] of Object.entries(ops.increment || {})) {
      if (typeof v === 'number' && Number.isFinite(v)) this.add('increment', k, v, owner);
    }
    for (const [k, v] of Object.entries(ops.append || {})) this.add('append', k, v, owner);
    for (const [k, v] of Object.entries(ops.remove || {})) this.add('remove', k, v, owner);
  }

  /** True when there is nothing awaiting acknowledgement. */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** True when there is something not yet on the wire. */
  hasUnsent(): boolean {
    return this.entries.some((e) => !e.inFlight);
  }

  /**
   * The next request: the OLDEST entry of every key that has nothing in
   * flight. Marks those entries in flight; answer with acknowledge / release /
   * drop. Null when there is nothing that may be sent now.
   */
  nextRequest(resolve?: OwnerResolver): AttributeRequest | null {
    return this.build(true, resolve);
  }

  /** The same request, without marking anything (unload, logout, storage). */
  peekRequest(resolve?: OwnerResolver): AttributeRequest | null {
    return this.build(false, resolve);
  }

  /** Legacy shape of peekRequest(): the op payload only. */
  toOps(): AttributeOps | null {
    return this.peekRequest()?.ops ?? null;
  }

  /** The server stored these: forget them (exactly these entries). */
  acknowledge(sent: AttributeEntry[]): void {
    const done = new Set(sent);
    this.entries = this.entries.filter((e) => !done.has(e));
  }

  /**
   * The request failed: its entries wait for the next attempt. Increments are
   * dropped when the failure was ambiguous (`dropIncrements`), because a
   * retried `$inc` may count twice; returns how many were dropped.
   */
  release(sent: AttributeEntry[], dropIncrements: boolean): number {
    let dropped = 0;
    const set = new Set(sent);
    this.entries = this.entries.filter((e) => {
      if (!set.has(e)) return true;
      e.inFlight = false;
      if (dropIncrements && e.kind === 'increment') {
        dropped++;
        return false;
      }
      return true;
    });
    return dropped;
  }

  /** The server refused these for good: drop them. */
  drop(sent: AttributeEntry[]): void {
    this.acknowledge(sent);
  }

  /** Increments handed off at page unload: never sent twice. */
  dropIncrements(sent: AttributeEntry[]): void {
    const set = new Set(sent.filter((e) => e.kind === 'increment'));
    this.entries = this.entries.filter((e) => !set.has(e));
  }

  /**
   * Un-acked absolute values, for the in-app sync request: where each key will
   * land once the log is applied. Only `set` values - those are what targeting
   * reads and what can be fresher on the device than in the profile. Given an
   * anonymous id, only that visitor's writes (not a previous user's leftovers).
   */
  pending(anonymousId?: string): Record<string, any> {
    const out: Record<string, any> = {};
    for (const e of this.entries) {
      if (anonymousId && e.owner && e.owner.anonymousId !== anonymousId) continue;
      if (e.kind === 'set') out[e.key] = e.value;
      else if (e.kind === 'unset') delete out[e.key];
    }
    return out;
  }

  /** The log as data, for storage while consent is pending. */
  serialize(): AttributeEntry[] {
    return this.entries.map((e) => {
      const copy: AttributeEntry = { key: e.key, kind: e.kind };
      if (e.kind === 'set' || e.kind === 'increment') copy.value = e.value;
      if (e.values) copy.values = [...e.values];
      if (e.owner) copy.owner = { ...e.owner };
      if (e.attempts) copy.attempts = e.attempts;
      return copy;
    });
  }

  /** Re-add stored entries (in order) after anything already recorded. */
  restore(stored: unknown): void {
    if (!Array.isArray(stored)) return;
    for (const raw of stored) {
      if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') continue;
      const kind = raw.kind as AttributeOpKind;
      const owner: WriteOwner | undefined =
        raw.owner && typeof raw.owner === 'object' && typeof raw.owner.anonymousId === 'string'
          ? { anonymousId: raw.owner.anonymousId, ...(typeof raw.owner.userId === 'string' ? { userId: raw.owner.userId } : {}) }
          : undefined;
      const before = this.entries.length;
      if (kind === 'set') this.add('set', raw.key, raw.value, owner);
      else if (kind === 'unset') this.add('unset', raw.key, undefined, owner);
      else if (kind === 'increment' && typeof raw.value === 'number' && Number.isFinite(raw.value)) {
        this.add('increment', raw.key, raw.value, owner);
      } else if ((kind === 'append' || kind === 'remove') && Array.isArray(raw.values)) {
        this.add(kind, raw.key, raw.values, owner);
      }
      const added = this.entries.length > before ? this.entries[this.entries.length - 1] : undefined;
      if (added && Number.isInteger(raw.attempts) && raw.attempts > 0) added.attempts = raw.attempts;
    }
  }

  /**
   * The identity is about to change (reset, wipe, identify of another user):
   * writes made while `anonymousId` was anonymous belong to `userId`, who
   * that anonymous id became. Pinned now, they keep going to that person.
   */
  pinOwner(anonymousId: string, userId: string): void {
    for (const e of this.entries) {
      if (!e.owner) e.owner = { anonymousId, userId };
      else if (e.owner.anonymousId === anonymousId && !e.owner.userId) e.owner = { anonymousId, userId };
    }
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * One request: the oldest waiting entry of every key, all of ONE person (the
   * owner of the oldest sendable entry). An entry of another person keeps its
   * key's place, so a key's writes still go in call order across people.
   */
  private build(markInFlight: boolean, resolve: OwnerResolver = (o) => o): AttributeRequest | null {
    const busy = new Set(this.entries.filter((e) => e.inFlight).map((e) => e.key));
    const used = new Set<string>();
    const ops: AttributeOps = {};
    const picked: AttributeEntry[] = [];
    let owner: WriteOwner | undefined;
    let ownerChosen = false;
    for (const e of this.entries) {
      if (e.inFlight || busy.has(e.key) || used.has(e.key)) {
        used.add(e.key);
        continue;
      }
      const who = resolve(e.owner);
      if (ownerChosen && !sameOwner(who, owner)) {
        used.add(e.key);
        continue;
      }
      if (!ownerChosen) {
        ownerChosen = true;
        owner = who;
      }
      used.add(e.key);
      picked.push(e);
      switch (e.kind) {
        case 'set':
          (ops.attributes ??= {})[e.key] = e.value;
          break;
        case 'unset':
          (ops.unset ??= []).push(e.key);
          break;
        case 'increment':
          (ops.increment ??= {})[e.key] = e.value;
          break;
        case 'append':
          (ops.append ??= {})[e.key] = [...e.values!];
          break;
        case 'remove':
          (ops.remove ??= {})[e.key] = [...e.values!];
          break;
      }
    }
    if (!picked.length) return null;
    if (markInFlight) for (const e of picked) e.inFlight = true;
    return { ops, entries: picked, ...(owner ? { owner: { ...owner } } : {}) };
  }

  private lastFor(key: string): AttributeEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].key === key) return this.entries[i];
    }
    return undefined;
  }

  /** Bound memory if an app writes unique keys in a loop while offline (oldest first). */
  private trim(): void {
    while (this.entries.length > this.maxEntries) {
      const i = this.entries.findIndex((e) => !e.inFlight);
      if (i < 0) break;
      this.entries.splice(i, 1);
    }
  }
}

/** The API treats an array value as "each element", so a stored list is flat. */
function flatten(value: any): any[] {
  return Array.isArray(value) ? [...value] : [value];
}

function includesValue(list: any[], v: any): boolean {
  if (v !== null && typeof v === 'object') {
    const json = safeJson(v);
    return list.some((x) => x !== null && typeof x === 'object' && safeJson(x) === json);
  }
  return list.some((x) => Object.is(x, v));
}

function dedupe(values: any[]): any[] {
  const out: any[] = [];
  for (const v of values) if (!includesValue(out, v)) out.push(v);
  return out;
}

function safeJson(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
