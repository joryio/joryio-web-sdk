/**
 * resetTo(anonymousId): the rule a caller-supplied anonymous id must pass
 * (BACKLOG D366). The SAME rule on all five SDKs, byte-identical - the
 * backend parity suite greps the pattern and the length bounds.
 *
 *  - 8 to 255 characters (the backend stores at most 255), letters, digits
 *    and `.` `_` `:` `-` only - a UUID, `jry_<uuid>`, `hp_<hex>` all pass;
 *  - not 24 lowercase hex characters: that is the shape of a Joryio internal
 *    profile id, which several server paths read as the profile itself;
 *  - not the user id the SDK holds now (signed in, or kept for withdrawals):
 *    a user id is never an anonymous id;
 *  - not the anonymous id the SDK holds while a user is signed in: that id is
 *    tied to the signed-in user's profile (identify merged it there), so the
 *    next person on a shared device would inherit their in-app messages,
 *    events, form attribution and push subscription.
 *
 * A refused id is logged and the call behaves exactly like reset(): a
 * random anonymous id. resetTo() is a logout first - a bad id must never
 * leave the previous person signed in on a shared device.
 */
export const RESET_TO_ANONYMOUS_ID_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;
export const RESET_TO_INTERNAL_ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * How many anonymous ids tied to a signed-in user (held when a reset() or
 * resetTo() signed them out) this browser remembers, newest kept. The same
 * cap on all five SDKs; wipeData() forgets them with all other data.
 */
export const SIGNED_IN_ANONYMOUS_IDS_MAX = 20;
/** Storage key (under the SDK's own prefix). */
export const SIGNED_IN_ANONYMOUS_IDS_KEY = 'signed_in_anonymous_ids';

/** Append `id` (moved to the end if present), keeping the newest SIGNED_IN_ANONYMOUS_IDS_MAX. */
export function rememberSignedInAnonymousId(list: readonly string[], id: string): string[] {
  return [...list.filter((x) => x !== id), id].slice(-SIGNED_IN_ANONYMOUS_IDS_MAX);
}

/** Null when `anonymousId` may be adopted, otherwise why not. */
export function resetToRefusal(
  anonymousId: unknown,
  knownUserIds: Array<string | null | undefined>,
  signedInAnonymousId: string | null | undefined = null,
  rememberedSignedInAnonymousIds: readonly string[] = [],
): string | null {
  if (typeof anonymousId !== 'string' || !RESET_TO_ANONYMOUS_ID_PATTERN.test(anonymousId)) {
    return 'resetTo: the anonymous id must be 8 to 255 letters, digits, ".", "_", ":" or "-"';
  }
  if (RESET_TO_INTERNAL_ID_PATTERN.test(anonymousId)) {
    return 'resetTo: the anonymous id has the shape of a Joryio profile id';
  }
  if (knownUserIds.some((u) => typeof u === 'string' && u === anonymousId)) {
    return 'resetTo: the anonymous id is a user id';
  }
  // ...and so is one a signed-in user held before an earlier reset.
  if ((typeof signedInAnonymousId === 'string' && signedInAnonymousId === anonymousId) || rememberedSignedInAnonymousIds.includes(anonymousId)) {
    return 'resetTo: the anonymous id belongs to the signed-in user';
  }
  return null;
}
