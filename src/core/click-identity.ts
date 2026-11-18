/**
 * Click-link identity (Joryio BACKLOG D407).
 *
 * A tracked link in a Joryio message lands with `jr_t` - an opaque,
 * authenticated token naming the recipient (no personal data in it). The
 * SDK removes it from the address bar at once (so it is never bookmarked,
 * shared or recorded as a landing page), and - only when tracking is allowed
 * and nobody is identified on this browser - sends it to
 * POST /v1/identify-link with the anonymous id, so this visit is the
 * recipient's. `jr_cid` / `jr_jid` / utm_* stay in the URL as before.
 *
 * Wire contract, identical in every Joryio SDK (the backend's
 * sdk-click-identity-parity.spec.ts): param `jr_t`, path `/v1/identify-link`,
 * body keys `token` and `anonymousId`, public method `identifyFromLink`.
 */

export const CLICK_IDENTITY_PARAM = 'jr_t';
export const CLICK_IDENTITY_PATH = '/v1/identify-link';
/** Base64url, sane length: anything else is not ours and is never sent. */
export const CLICK_IDENTITY_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;

/** The `jr_t` value of a URL (absolute, or relative to the page), or null. */
export function readClickIdentityToken(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.includes(`${CLICK_IDENTITY_PARAM}=`)) return null;
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.href : 'https://x.invalid/';
    const value = new URL(url, base).searchParams.get(CLICK_IDENTITY_PARAM);
    return value && CLICK_IDENTITY_TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** `url` without `jr_t` (every other parameter and the fragment kept), or null when it had none. */
export function withoutClickIdentityToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(CLICK_IDENTITY_PARAM)) return null;
    parsed.searchParams.delete(CLICK_IDENTITY_PARAM);
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Read `jr_t` from the current page and remove it from the address bar
 * (history.replaceState, keeping the history entry's state). Always strips,
 * whatever consent says: URL hygiene is not collection. Returns the token
 * (valid shape only) or null.
 */
export function consumeClickIdentityTokenFromLocation(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const href = window.location.href;
  const token = readClickIdentityToken(href);
  const stripped = withoutClickIdentityToken(href);
  if (stripped) {
    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(window.history.state, '', stripped);
      }
    } catch {
      // A sandboxed frame may refuse; the token is still only used once.
    }
  }
  return token;
}
