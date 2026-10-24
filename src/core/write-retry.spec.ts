import {
  classifyWriteResponse,
  isWithdrawal,
  writeAttemptsExhausted,
  writeRetryDelay,
  WRITE_MAX_ATTEMPTS,
  WRITE_MAX_NOT_FOUND_ATTEMPTS,
  WRITE_MAX_RETRY_DELAY_MS,
} from './write-retry';

/**
 * The ONE retry rule every profile write follows, the same on every SDK
 * (contract item 40): offline, timeouts, 429 and 5xx never count toward a
 * write's cap; a 404 counts toward a cap of 5; any other retryable server
 * answer (success:false, a 401 for the current user) toward a cap of 10;
 * 403/400/413/422 drop.
 */
describe('classifyWriteResponse (contract item 40)', () => {
  const current = { isSdkAuthError: false, ownerIsCurrentUser: true };
  const v = (status: number, extra: any = {}, ctx = current) =>
    classifyWriteResponse({ ok: status >= 200 && status < 300 && !extra.softFailure, status, ...extra }, ctx);

  it('the caps', () => {
    expect(WRITE_MAX_ATTEMPTS).toBe(10);
    expect(WRITE_MAX_NOT_FOUND_ATTEMPTS).toBe(5);
    expect(writeAttemptsExhausted(9, 0)).toBe(false);
    expect(writeAttemptsExhausted(10, 0)).toBe(true);
    expect(writeAttemptsExhausted(0, 5)).toBe(true);
  });

  it('offline, timeouts, 429 and 5xx are retried WITHOUT counting', () => {
    for (const status of [0, 408, 429, 500, 503]) {
      expect(v(status)).toEqual(expect.objectContaining({ action: 'retry', counts: false }));
    }
  });

  it('success:false and a 401 for the current user count (cap 10); a 404 counts toward cap 5', () => {
    expect(v(200, { softFailure: true })).toEqual({ action: 'retry', counts: true });
    expect(v(401, {}, { isSdkAuthError: true, ownerIsCurrentUser: true })).toEqual({ action: 'retry', counts: true });
    expect(v(404)).toEqual({ action: 'retry', counts: true, notFound: true });
  });

  it("drops 400/403/409/413/422 and an SDK-auth 401 of a user who is no longer signed in (contract item 39)", () => {
    for (const status of [400, 403, 409, 413, 422]) expect(v(status).action).toBe('drop');
    expect(v(401, {}, { isSdkAuthError: true, ownerIsCurrentUser: false }).action).toBe('drop');
  });

  it('holds on a refused key', () => {
    expect(v(401).action).toBe('hold');
  });

  it('a paused workspace (402) is a retry that never counts - it must not stop the outbox (rule 50)', () => {
    expect(v(402)).toEqual({ action: 'retry', counts: false, retryAfterMs: undefined });
  });

  it('the backoff grows, is capped, and respects Retry-After within the cap', () => {
    expect(writeRetryDelay(1)).toBe(2000);
    expect(writeRetryDelay(2)).toBe(5000);
    expect(writeRetryDelay(50)).toBe(WRITE_MAX_RETRY_DELAY_MS);
    expect(writeRetryDelay(1, 30_000)).toBe(30_000);
    expect(writeRetryDelay(1, 60 * 60 * 1000)).toBe(WRITE_MAX_RETRY_DELAY_MS);
  });
});

describe('withdrawals (contract item 36)', () => {
  const ids = { anonymousId: 'a' };
  it('an unsubscribe, a group unsubscribe and the opt-out marker are withdrawals; nothing else is', () => {
    expect(isWithdrawal({ kind: 'subscription', payload: { channel: 'email', status: 'unsubscribed', ...ids } })).toBe(true);
    expect(isWithdrawal({ kind: 'subscription', payload: { channel: 'email', status: 'subscribed', ...ids } })).toBe(false);
    expect(isWithdrawal({ kind: 'subscription', payload: { channel: 'email', status: 'optedIn', ...ids } })).toBe(false);
    expect(isWithdrawal({ kind: 'group', payload: { groupId: 'g', channel: 'email', action: 'unsubscribe', ...ids } })).toBe(true);
    expect(isWithdrawal({ kind: 'group', payload: { groupId: 'g', channel: 'email', action: 'subscribe', ...ids } })).toBe(false);
    expect(isWithdrawal({ kind: 'marker', payload: { value: true, ...ids } })).toBe(true);
    expect(isWithdrawal({ kind: 'marker', payload: { value: false, ...ids } })).toBe(false);
    expect(isWithdrawal({ kind: 'alias', payload: { aliasLabel: 'l', aliasName: 'n', ...ids } })).toBe(false);
  });
});
