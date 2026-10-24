import { NetworkClient, SDK_AUTH_HEADER } from './network';

// SDK Authentication (JWT-based): when enabled + a token is set the client
// attaches `X-Joryio-Auth` to every request; on a 401 sdk_authentication_error
// it fires the host refresh callback and retries the request ONCE with the
// fresh token. When disabled, behaviour is unchanged (no header, no refresh).
describe('NetworkClient SDK authentication', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;
  // maxRetries: 0 so the normal backoff loop can't confuse the auth one-shot.
  // Signed in as u1: a token goes only on requests about a user (rule 72 -
  // an anonymous request carries none, the server checks none for it).
  const make = () => {
    const client = new NetworkClient('jry_sdk_test', stubLogger, { maxRetries: 0, backoffMs: 0 });
    client.setCurrentUserId('u1');
    return client;
  };
  const api = 'https://api.example';

  const jsonResponse = (status: number, body: any): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      clone() {
        return this;
      },
    } as any);

  afterEach(() => {
    (global as any).fetch = undefined;
  });

  it('attaches X-Joryio-Auth when enabled and a token is set', async () => {
    const client = make();
    client.setSdkAuthenticationEnabled(true);
    client.setSdkAuthenticationToken('tok-1');

    const seenHeaders: Record<string, string>[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      seenHeaders.push(init.headers);
      return jsonResponse(200, { ok: true });
    });

    await client.sendEvents(api, [{ type: 'X', userId: 'u1' }]);

    expect((global as any).fetch).toHaveBeenCalledTimes(1);
    expect(seenHeaders[0][SDK_AUTH_HEADER]).toBe('tok-1');
  });

  it('on a 401 sdk_authentication_error: fires the callback and retries ONCE with the new token', async () => {
    const client = make();
    client.setSdkAuthenticationEnabled(true);
    client.setSdkAuthenticationToken('stale-token');

    const callbackCalls: any[] = [];
    // Host callback mints a fresh token by calling setSdkAuthenticationToken.
    client.setSdkAuthenticationFailureCallback((info) => {
      callbackCalls.push(info);
      client.setSdkAuthenticationToken('fresh-token');
    });

    const tokensSeen: (string | undefined)[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      tokensSeen.push(init.headers[SDK_AUTH_HEADER]);
      // First call: reject with sdk_authentication_error. Second: succeed.
      if (tokensSeen.length === 1) {
        return jsonResponse(401, { error: 'sdk_authentication_error', reason: 'expired' });
      }
      return jsonResponse(200, { ok: true });
    });

    const res = await client.sendEvents(api, [{ type: 'X', userId: 'u1' }]);

    // Exactly two fetches: the failed one + the single refresh retry.
    expect((global as any).fetch).toHaveBeenCalledTimes(2);
    expect(tokensSeen).toEqual(['stale-token', 'fresh-token']);
    // Callback received the failure reason + endpoint.
    expect(callbackCalls).toHaveLength(1);
    expect(callbackCalls[0].reason).toBe('expired');
    expect(callbackCalls[0].endpoint).toContain('/v1/track/batch');
    // Retry succeeded → overall success.
    expect(res.ok).toBe(true);
  });

  it('honours a token RETURNED (promised) by the callback', async () => {
    const client = make();
    client.setSdkAuthenticationEnabled(true);
    client.setSdkAuthenticationToken('stale');
    client.setSdkAuthenticationFailureCallback(async () => 'returned-token');

    const tokensSeen: (string | undefined)[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      tokensSeen.push(init.headers[SDK_AUTH_HEADER]);
      if (tokensSeen.length === 1) {
        return jsonResponse(401, { error: 'sdk_authentication_error', reason: 'invalid' });
      }
      return jsonResponse(200, { ok: true });
    });

    const res = await client.sendEvents(api, [{ type: 'X', userId: 'u1' }]);
    expect(tokensSeen).toEqual(['stale', 'returned-token']);
    expect(res.ok).toBe(true);
  });

  it('does NOT loop: no new token → single attempt, surfaces the 401', async () => {
    const client = make();
    client.setSdkAuthenticationEnabled(true);
    client.setSdkAuthenticationToken('stale');
    // Callback provides no fresh token.
    const cb = jest.fn(() => {});
    client.setSdkAuthenticationFailureCallback(cb);

    (global as any).fetch = jest.fn(async () =>
      jsonResponse(401, { error: 'sdk_authentication_error', reason: 'sub_mismatch' }),
    );

    const res = await client.sendEvents(api, [{ type: 'X', userId: 'u1' }]);
    // Callback fired once; request NOT retried (no fresh token).
    expect(cb).toHaveBeenCalledTimes(1);
    expect((global as any).fetch).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('disabled → no header attached and no refresh behaviour', async () => {
    const client = make();
    // Not enabled; token set should be inert.
    client.setSdkAuthenticationToken('tok');
    const cb = jest.fn();
    client.setSdkAuthenticationFailureCallback(cb);

    const seenHeaders: Record<string, string>[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      seenHeaders.push(init.headers);
      return jsonResponse(401, { error: 'sdk_authentication_error', reason: 'missing' });
    });

    const res = await client.sendEvents(api, [{ type: 'X', userId: 'u1' }]);

    expect(seenHeaders[0][SDK_AUTH_HEADER]).toBeUndefined();
    // No refresh callback fired, no retry (401 is non-retryable).
    expect(cb).not.toHaveBeenCalled();
    expect((global as any).fetch).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
  });

  it('getSdkAuthHeaders reflects enabled+token state (used by in-app raw fetch)', () => {
    const client = make();
    expect(client.getSdkAuthHeaders()).toEqual({});
    client.setSdkAuthenticationEnabled(true);
    expect(client.getSdkAuthHeaders()).toEqual({});
    client.setSdkAuthenticationToken('abc');
    expect(client.getSdkAuthHeaders()).toEqual({ [SDK_AUTH_HEADER]: 'abc' });
  });

  it('a token set for the next user before reset() waits on standby: the prune keeps it, identify() adopts it (rule 72)', () => {
    const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64').replace(/=+$/, '')}.s`;
    const client = new NetworkClient('jry_sdk_test', stubLogger, { maxRetries: 0, backoffMs: 0 });
    client.setSdkAuthenticationEnabled(true);
    client.setCurrentUserId('A');
    client.setSdkAuthenticationToken(jwt('A'));
    // The host sets B's token while A is still signed in, then logs A out.
    client.setSdkAuthenticationToken(jwt('B'));
    client.retireSdkAuthToken();
    client.switchUser(null);
    // Nothing of B's is queued; ten minutes later an ordinary retired token would be gone.
    const later = Date.now() + 10 * 60 * 1000;
    client.forgetRetiredSdkAuthTokensExcept(new Set(['A']), later);
    expect(client.retiredSdkAuthUsers()).toContain('B');
    client.switchUser('B');
    expect((client as any).sdkAuthTokenFor('B')).toBe(jwt('B'));
    // A's own retired token is not standby: forgotten once nothing of A's is left.
    client.forgetRetiredSdkAuthTokensExcept(new Set(), later);
    expect(client.retiredSdkAuthUsers()).not.toContain('A');
  });
});
