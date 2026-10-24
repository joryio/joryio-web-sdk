import type { NetworkResponse } from './network';

/**
 * Who a write is about, captured when the call was made. `userId` is absent
 * for a write made while the visitor was anonymous; it is filled in at SEND
 * time when that anonymous id is still the current one (contract item 38).
 */
export interface WriteOwner {
  anonymousId: string;
  userId?: string;
}

/**
 * A profile write described as DATA, so it can be kept in storage and sent on
 * a later page view. Closures die with the page; these survive navigation.
 */
export type WriteRecord =
  | {
      kind: 'alias';
      payload: { anonymousId: string; userId?: string; aliasLabel: string; aliasName: string };
    }
  | {
      kind: 'subscription';
      payload: { channel: any; status: any; userId?: string; anonymousId: string };
    }
  | {
      kind: 'group';
      payload: { groupId: string; channel: any; action: 'subscribe' | 'unsubscribe'; userId?: string; anonymousId: string };
    }
  | {
      /** The `tracking_opted_out` profile marker (contract items 33 and 36). */
      kind: 'marker';
      payload: { value: boolean; userId?: string; anonymousId: string };
    };

/** @deprecated the pre-1.3.0 name; kept for state stored by an earlier build. */
export type DeferredWriteRecord = WriteRecord;

/** Hands a write to the SDK's outbox. Provided by JoryioSDK. */
export type WriteRunner = (label: string, record: WriteRecord) => void;

/**
 * A WITHDRAWAL is always delivered (contract item 36): an unsubscribe, a
 * group unsubscribe and the opt-out marker set to `true`. Opt-out, consent
 * denied or pending, and wipeData() stop every other write - never these,
 * because they are how the server learns that the person said no.
 */
export function isWithdrawal(record: WriteRecord): boolean {
  switch (record.kind) {
    case 'subscription':
      return record.payload.status === 'unsubscribed';
    case 'group':
      return record.payload.action === 'unsubscribe';
    case 'marker':
      return record.payload.value === true;
    default:
      return false;
  }
}

/**
 * The same caps on every SDK (contract item 40): a 404 "no profile yet" is
 * tried at most 5 times; any other retryable SERVER answer (a 401 for the
 * current user, a 2xx with `success: false`) at most 10 times. Offline,
 * timeouts, 429 and 5xx never count - they are waited out with a growing
 * backoff instead.
 */
export const WRITE_MAX_ATTEMPTS = 10;
export const WRITE_MAX_NOT_FOUND_ATTEMPTS = 5;

/** Waits before the 2nd through 10th attempt; later waits stay at the last value. */
export const WRITE_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000];
/** The longest wait between two attempts of one write, whatever the server or the backoff says. */
export const WRITE_MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

/** Wait before the next attempt, after `failures` failed ones. */
export function writeRetryDelay(failures: number, retryAfterMs?: number): number {
  const base = WRITE_RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), WRITE_RETRY_DELAYS_MS.length) - 1];
  const grown = failures > WRITE_RETRY_DELAYS_MS.length
    ? Math.min(base * Math.pow(2, failures - WRITE_RETRY_DELAYS_MS.length), WRITE_MAX_RETRY_DELAY_MS)
    : base;
  return Math.min(Math.max(grown, retryAfterMs ?? 0), WRITE_MAX_RETRY_DELAY_MS);
}

/**
 * What to do with a write after one answer. The ONE rule every profile write
 * follows (contract item 40) - subscriptions, aliases, attributes, the
 * opt-out marker, push unregister and identify:
 *
 *  - `done`: stored.
 *  - `retry`: try again later. `counts` says whether the attempt counts toward
 *    the cap (`notFound` selects the 404 cap).
 *  - `drop`: refused for good (400, 403, 409, 413, 422, other 4xx), or an
 *    SDK-authentication 401 for a user who is no longer the current one - no
 *    token for them will ever be set again (contract item 39).
 *  - `hold`: the key was refused (401 that is not SDK auth): nothing is sent
 *    for the rest of the page view; the write is kept for the next one.
 *
 * A 402 (ingestion paused for the workspace) is a `retry` that never counts
 * (rule 50): it must not stop the outbox, because WITHDRAWALS queued behind
 * the refused write are still accepted by the server. The SDK's gate holds
 * every non-withdrawal while the pause lasts.
 */
export type WriteVerdict =
  | { action: 'done' }
  | { action: 'retry'; counts: boolean; notFound?: boolean; retryAfterMs?: number }
  | { action: 'drop'; reason: string }
  | { action: 'hold'; reason: string };

export function classifyWriteResponse(
  res: NetworkResponse,
  ctx: { isSdkAuthError: boolean; ownerIsCurrentUser: boolean },
): WriteVerdict {
  if (res.ok) return { action: 'done' };
  if (res.softFailure) return { action: 'retry', counts: true };
  const status = res.status;
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { action: 'retry', counts: false, retryAfterMs: res.retryAfterMs };
  }
  if (status === 404) return { action: 'retry', counts: true, notFound: true };
  if (status === 401) {
    if (!ctx.isSdkAuthError) return { action: 'hold', reason: 'the SDK key was refused (401)' };
    if (!ctx.ownerIsCurrentUser) {
      return { action: 'drop', reason: 'SDK authentication refused a write of a user who is no longer signed in (401)' };
    }
    return { action: 'retry', counts: true };
  }
  // Paused workspace: wait, never count, never stop the withdrawals behind it.
  if (status === 402) return { action: 'retry', counts: false, retryAfterMs: res.retryAfterMs };
  return { action: 'drop', reason: `refused by the server (HTTP ${status})` };
}

/** True once a write has used up its attempts. */
export function writeAttemptsExhausted(attempts: number, notFoundAttempts: number): boolean {
  return attempts >= WRITE_MAX_ATTEMPTS || notFoundAttempts >= WRITE_MAX_NOT_FOUND_ATTEMPTS;
}
