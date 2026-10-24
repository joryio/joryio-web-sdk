import { JoryioSDK, EVENT_PROPERTY_LIMITS, TRACKING_OPTED_OUT_ATTRIBUTE, eventPropertiesProblem } from './sdk';
import { installSnippetQueue } from '../index';
import { resolveConfig, MIN_FLUSH_INTERVAL } from './config';
import {
  BASE_CONFIG,
  installFetch,
  installLocalStorage,
  uninstallLocalStorage,
  settle,
  waitFor,
  RecordedRequest,
  Responder,
  installFakeDocument,
  uninstallFakeDocument,
} from './test-harness';

/**
 * SDK 1.3.0 scan 3 (web findings 1-13) and contract addendum v3 (items
 * 24-35). Each test names what it pins; every one fails on the code before
 * this round (the scan's probes, made into real assertions).
 */

let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
let store: Map<string, string>;

const batches = () => calls.filter((c) => c.path === '/api/v1/track/batch');
const events = () => batches().flatMap((c) => c.body.events || []);
const types = () => events().map((e: any) => e.type);
const attributeBodies = () => calls.filter((c) => c.path === '/api/v1/attributes').map((c) => c.body);

const ok: Responder = (req) => {
  if (req.path.endsWith('/v1/track/batch')) {
    return { status: 200, body: { success: true, ...(req.body?.identify ? { identified: true } : {}) } };
  }
  if (req.path.endsWith('/v1/in-app/sync')) return { status: 200, body: { success: true, campaigns: [] } };
  return { status: 200, body: { success: true } };
};

/** A browser-ish window, document and navigator (enough for the snippet and sessions). */
function browser(extra: any = {}) {
  const w: any = {
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    location: { href: 'https://x.test/', pathname: '/', search: '' },
    ...extra,
  };
  (globalThis as any).window = w;
  const d: any = (globalThis as any).document || {};
  Object.assign(d, {
    referrer: '',
    title: 't',
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  });
  if (!d.createElement) {
    d.createElement = () => ({ style: {}, setAttribute() {}, appendChild() {} });
    d.getElementById = () => null;
    d.documentElement = { appendChild() {} };
  }
  (globalThis as any).document = d;
  (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
  return w;
}

beforeEach(() => {
  store = installLocalStorage();
  calls = installFetch(ok);
});

afterEach(async () => {
  jest.useRealTimers();
  if (sdk) await sdk.destroy();
  sdk = null;
  await JoryioSDK.getInstance()?.destroy();
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).navigator;
  delete (globalThis as any).document;
});

/** A fresh SDK on the same storage - a reload. */
async function reload(config: any = {}): Promise<JoryioSDK> {
  if (sdk) await sdk.destroy();
  sdk = new JoryioSDK({ ...BASE_CONFIG, ...config });
  return sdk;
}

// ---------------------------------------------------------------------------
// Finding 1 / item 31: attribute operations keep call order and every value
// ---------------------------------------------------------------------------

describe('attribute writes (finding 1, item 31)', () => {
  it('two addToArray on one key inside the debounce send both values', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.addToArray('tags', 'a');
    sdk.addToArray('tags', 'b');
    await waitFor(() => attributeBodies().length > 0, 3000);
    await settle(30);
    expect(attributeBodies()).toEqual([expect.objectContaining({ append: { tags: ['a', 'b'] } })]);
  });

  it('addToArray then removeFromArray of one key: two requests, in call order', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.addToArray('tags', 'x');
    sdk.removeFromArray('tags', 'y');
    await waitFor(() => attributeBodies().length >= 2, 3000);
    const bodies = attributeBodies();
    expect(bodies[0].append).toEqual({ tags: ['x'] });
    expect(bodies[0].remove).toBeUndefined();
    expect(bodies[1].remove).toEqual({ tags: ['y'] });
  });

  it('setAttribute then incrementAttribute of one key never share a request', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.setAttribute('score', 10);
    sdk.incrementAttribute('score', 5);
    await waitFor(() => attributeBodies().length >= 2, 3000);
    const [first, second] = attributeBodies();
    expect(first.attributes.score).toBe(10);
    expect(first.increment).toBeUndefined();
    expect(second.increment).toEqual({ score: 5 });
  });

  it("a reset() during an attribute request: the old answer does not ack the new user's write", async () => {
    let release: (() => void) | null = null;
    const inner = (globalThis as any).fetch;
    let held = false;
    (globalThis as any).fetch = (url: string, init: any) => {
      if (String(url).endsWith('/v1/attributes') && !held) {
        held = true;
        return new Promise((resolve) => {
          release = () => resolve(inner(url, init));
        });
      }
      return inner(url, init);
    };
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.setAttribute('plan', 'free');
    await waitFor(() => release !== null, 3000);
    await sdk.reset();
    sdk.setAttribute('plan', 'pro');
    release!();
    await waitFor(() => attributeBodies().some((b) => b.attributes?.plan === 'pro'), 3000);
    expect((sdk as any).identity.pending.isEmpty()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 / item 25: decisions queued before init apply before its side effects
// ---------------------------------------------------------------------------

describe('snippet: privacy calls queued before init (finding 4, item 25)', () => {
  function snippet(commands: any[][], extra: any = {}) {
    const q: any = [];
    const w = browser({ joryio: q });
    for (const c of commands) q.push(c);
    installSnippetQueue(w);
    sdk = w.joryio;
    return w;
  }

  it('optOut() before init: no Session Start, no batch, no in-app sync, no push', async () => {
    snippet([['optOut'], ['init', { ...BASE_CONFIG, inApp: { enabled: true } }], ['track', 'Clicked']]);
    await settle(100);
    expect(batches()).toHaveLength(0);
    expect(calls.some((c) => c.path.endsWith('/v1/in-app/sync'))).toBe(false);
    expect(calls.some((c) => c.path.includes('/push'))).toBe(false);
    expect(sdk!.isUserOptedOut()).toBe(true);
  });

  it("updateConsent('denied') before init: nothing is sent", async () => {
    snippet([['updateConsent', 'denied'], ['init', { ...BASE_CONFIG, inApp: { enabled: true } }]]);
    await settle(100);
    expect(calls.filter((c) => c.path !== '/api/v1/attributes')).toHaveLength(0);
    expect(sdk!.getTrackingConsent()).toBe('denied');
  });

  it('an optOut() queued after init (but before load) still applies first', async () => {
    snippet([['init', { ...BASE_CONFIG }], ['optOut']]);
    await settle(100);
    expect(batches()).toHaveLength(0);
  });

  it('optIn() before init lifts a stored opt-out before init runs', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    sdk.optOut();
    await sdk.destroy();
    sdk = null;
    calls.length = 0;
    snippet([['optIn'], ['init', { ...BASE_CONFIG }], ['track', 'After opt-in']]);
    expect(sdk!.isUserOptedOut()).toBe(false);
    await sdk!.flush();
    expect(types()).toContain('After opt-in');
  });

  it('wipeData() before init: the previous visitor never reaches the server', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, persistQueue: true, userId: 'old-user' });
    const oldAnon = sdk.getAnonymousId();
    (globalThis as any).fetch = async () => {
      throw new Error('offline');
    };
    sdk.track('Old visitor event');
    await sdk.destroy();
    sdk = null;
    calls = installFetch(ok);
    snippet([['wipeData'], ['init', { ...BASE_CONFIG, persistQueue: true }]]);
    await waitFor(() => batches().length > 0, 3000);
    expect(types()).not.toContain('Old visitor event');
    expect(events().every((e: any) => e.anonymousId !== oldAnon && !e.userId)).toBe(true);
    expect(sdk!.getUserId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 24: the consent model
// ---------------------------------------------------------------------------

describe('consent model A (item 24)', () => {
  it('denied survives a restart; an unset config keeps it denied', async () => {
    await reload();
    sdk!.updateConsent('denied');
    await reload();
    expect(sdk!.getTrackingConsent()).toBe('denied');
    sdk!.track('Should not send');
    await settle(50);
    expect(types()).not.toContain('Should not send');
  });

  it("only an explicit grant lifts it: updateConsent('granted') or trackingConsent: 'granted'", async () => {
    await reload({ trackingConsent: 'denied' });
    await reload({ trackingConsent: 'granted' });
    expect(sdk!.getTrackingConsent()).toBe('granted');
    sdk!.updateConsent('denied');
    await reload();
    expect(sdk!.getTrackingConsent()).toBe('denied');
    sdk!.updateConsent('granted');
    await reload();
    expect(sdk!.getTrackingConsent()).toBe('granted');
  });

  it('pending is not persisted and never overrides a stored denial', async () => {
    await reload({ trackingConsent: 'pending' });
    expect(sdk!.getTrackingConsent()).toBe('pending');
    await reload();
    expect(sdk!.getTrackingConsent()).toBe('granted');
    sdk!.updateConsent('denied');
    await reload({ trackingConsent: 'pending' });
    expect(sdk!.getTrackingConsent()).toBe('denied');
    sdk!.updateConsent('pending');
    expect(sdk!.getTrackingConsent()).toBe('denied');
  });

  it('a grant never cancels an opt-out, and optOut() never changes the consent', async () => {
    await reload();
    sdk!.optOut();
    expect(sdk!.getTrackingConsent()).toBe('granted');
    sdk!.updateConsent('granted');
    expect(sdk!.isUserOptedOut()).toBe(true);
    sdk!.track('Still opted out');
    await settle(50);
    expect(types()).not.toContain('Still opted out');
    sdk!.optIn();
    expect(sdk!.isUserOptedOut()).toBe(false);
  });

  it('isUserOptedOut() reflects only the opt-out switch', async () => {
    await reload({ trackingConsent: 'denied' });
    expect(sdk!.isUserOptedOut()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding 5 / item 32: sessions
// ---------------------------------------------------------------------------

describe('sessions (finding 5, finding 10, item 32)', () => {
  it('a track after 31 idle minutes in a visible tab starts a new session, Session Start first', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    browser();
    try {
      sdk = new JoryioSDK({ ...BASE_CONFIG, sendImmediately: true });
      await waitFor(() => batches().length > 0, 3000);
      const s1 = sdk.getSessionInfo().sessionId;
      now += 31 * 60 * 1000;
      sdk.track('Clicked');
      await waitFor(() => types().includes('Clicked'), 3000);
      const s2 = sdk.getSessionInfo().sessionId;
      expect(s2).not.toBe(s1);
      const ofS2 = events().filter((e: any) => e.sessionId === s2).map((e: any) => e.type);
      expect(ofS2).toEqual(['Session Start', 'Clicked']);
    } finally {
      Date.now = realNow;
    }
  });

  it('a reload inside the timeout resumes the session with no new Session Start', async () => {
    await reload({ persistQueue: true });
    await reload({ persistQueue: true });
    await sdk!.flush();
    expect(types().filter((t: string) => t === 'Session Start')).toHaveLength(1);
  });

  it('consent denied at init, granted later: the session gets its one Session Start', async () => {
    await reload({ trackingConsent: 'denied' });
    sdk!.updateConsent('granted');
    await sdk!.flush();
    expect(types().filter((t: string) => t === 'Session Start')).toHaveLength(1);
    sdk!.updateConsent('denied');
    sdk!.updateConsent('granted');
    await sdk!.flush();
    expect(types().filter((t: string) => t === 'Session Start')).toHaveLength(1);
  });

  it('opted out at init, optIn() later: Session Start is sent', async () => {
    await reload({ optOut: true });
    sdk!.optIn();
    await sdk!.flush();
    expect(types()).toContain('Session Start');
  });
});

// ---------------------------------------------------------------------------
// Finding 6 / item 29: permanent refusals
// ---------------------------------------------------------------------------

describe('permanently refused events (finding 6, item 29)', () => {
  it('events in rejectedIndices are dropped, failedIndices ones retried', async () => {
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/track/batch')) {
        const evs = req.body.events as any[];
        const poison = evs.map((e, i) => (e.type === 'Poison' ? i : -1)).filter((i) => i >= 0);
        if (!poison.length) return { status: 200, body: { success: true } };
        // The backend lists a permanent refusal in both: failedIndices for
        // older SDKs, rejectedIndices for "never retry".
        return { status: 200, body: { success: false, failedIndices: poison, rejectedIndices: poison } };
      }
      return { status: 200, body: { success: true } };
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('Poison');
    sdk.track('Fine');
    await sdk.flush();
    (sdk as any).queue.resetBackoff();
    await sdk.flush();
    await sdk.flush();
    const poisonSends = batches().filter((c) => c.body.events.some((e: any) => e.type === 'Poison')).length;
    expect(poisonSends).toBe(1);
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });

  it('a 2xx success with rejectedIndices drops those too', async () => {
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/track/batch')) return { status: 200, body: { success: true, rejectedIndices: [0] } };
      return { status: 200, body: { success: true } };
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('A');
    await sdk.flush();
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });

  it.each([
    ['over 50 KB', { blob: 'x'.repeat(EVENT_PROPERTY_LIMITS.maxJsonChars) }],
    ['over 200 keys', Object.fromEntries(Array.from({ length: 201 }, (_v, i) => [`k${i}`, i]))],
    ['nested deeper than 5', { a: { b: { c: { d: { e: { f: 1 } } } } } }],
  ])('track() drops an event with properties %s, without a request', async (_label, props) => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('Too big', props as any);
    await sdk.flush();
    expect(types()).not.toContain('Too big');
    expect((sdk as any).queue.getQueueSize()).toBe(0);
  });

  // The backend measures JSON.stringify(...).length (characters), not UTF-8
  // bytes: Hebrew text under 51,200 characters is accepted even though it is
  // ~2x that in bytes, so the SDK must not refuse it.
  it('non-ASCII properties are measured in characters, like the server', () => {
    const hebrew = { text: 'ש'.repeat(40000) };
    expect(JSON.stringify(hebrew).length).toBeLessThan(EVENT_PROPERTY_LIMITS.maxJsonChars);
    expect(eventPropertiesProblem(hebrew)).toBeNull();
  });

  it('properties at the limits are sent', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, captureUTM: false, trackDeviceProperties: false });
    sdk.track('Deep enough', { a: { b: { c: { d: { e: 1 } } } } });
    await sdk.flush();
    expect(types()).toContain('Deep enough');
  });
});

// ---------------------------------------------------------------------------
// Finding 7 / item 30: SDK authentication and a change of user
// ---------------------------------------------------------------------------

describe('SDK auth across a logout (finding 7, item 30)', () => {
  it("user A's queued events do not block user B's; no batch mixes users", async () => {
    let offline = true;
    calls = installFetch((req) => {
      if (offline) return { status: 503, body: {} };
      if (req.path.endsWith('/v1/track/batch')) {
        const tok = req.init.headers['X-Joryio-Auth'];
        const ids = new Set<string>([
          ...(req.body.events || []).map((e: any) => e.userId).filter(Boolean),
          ...(req.body.identify ? [req.body.identify.userId] : []),
        ]);
        if ([...ids].some((u) => `t${u}` !== tok)) {
          return { status: 401, body: { error: 'sdk_authentication_error', reason: 'sub_mismatch' } };
        }
        return { status: 200, body: { success: true, ...(req.body.identify ? { identified: true } : {}) } };
      }
      return { status: 200, body: { success: true } };
    });
    sdk = new JoryioSDK({
      ...BASE_CONFIG,
      trackSessionStart: false,
      enableSdkAuthentication: true,
      sdkAuthenticationToken: 'tA',
    });
    sdk.setSdkAuthenticationErrorCallback(() => undefined);
    sdk.identify('A');
    sdk.track('A did');
    await settle(50);
    await sdk.reset();
    sdk.identify('B');
    sdk.setSdkAuthenticationToken('tB');
    sdk.track('B did');
    offline = false;
    (sdk as any).queue.resetBackoff();
    await sdk.flush();
    await sdk.flush();

    expect(batches().some((c) => c.body.events?.some((e: any) => e.type === 'B did') && c.init.headers['X-Joryio-Auth'] === 'tB')).toBe(true);
    expect((sdk as any).queue.getQueueSize()).toBe(0);
    for (const c of batches()) {
      const users = new Set((c.body.events || []).map((e: any) => e.userId).filter(Boolean));
      expect(users.size).toBeLessThanOrEqual(1);
    }
  });

  it('the auth error handler fires with MISSING when no token was ever set', async () => {
    calls = installFetch((req) =>
      req.path.endsWith('/v1/track/batch') && !req.init.headers['X-Joryio-Auth']
        ? { status: 401, body: { error: 'sdk_authentication_error' } }
        : { status: 200, body: { success: true } });
    const seen: any[] = [];
    sdk = new JoryioSDK({ ...BASE_CONFIG, enableSdkAuthentication: true });
    sdk.setSdkAuthenticationErrorCallback((info) => {
      seen.push(info.reason);
      return 'fresh';
    });
    sdk.track('X');
    await sdk.flush();
    expect(seen).toContain('missing');
    expect(types()).toContain('X');
  });
});

// ---------------------------------------------------------------------------
// Findings 8 and 9: identify
// ---------------------------------------------------------------------------

describe('identify (findings 8, 9)', () => {
  it('a standalone identify refused with a 4xx is dropped, not retried forever', async () => {
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/track/batch')) return { status: 200, body: { success: true } }; // no `identified`
      if (req.path.endsWith('/v1/identify')) return { status: 400, body: { message: 'bad' } };
      return { status: 200, body: { success: true } };
    });
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.identify('u1');
    await settle(50);
    await sdk.flush();
    await sdk.flush();
    expect(calls.filter((c) => c.path.endsWith('/v1/identify'))).toHaveLength(1);
    expect((sdk as any).queue.getPendingIdentify()).toBeNull();
  });

  it("identify('A') made offline survives reset(); identify('B'): both merges reach the server, in order", async () => {
    let offline = true;
    calls = installFetch((req) => (offline ? { status: 503, body: {} } : ok(req)));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    const anon1 = sdk.getAnonymousId();
    sdk.identify('A');
    await settle(30);
    await sdk.reset();
    const anon2 = sdk.getAnonymousId();
    sdk.identify('B');
    offline = false;
    (sdk as any).queue.resetBackoff();
    await sdk.flush();
    const sent = batches().filter((c) => c.body.identify).map((c) => [c.body.identify.userId, c.body.identify.anonymousId]);
    expect(sent.slice(-2)).toEqual([['A', anon1], ['B', anon2]]);
    expect((sdk as any).queue.getPendingIdentify()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding 11 / item 33: the tracking_opted_out marker
// ---------------------------------------------------------------------------

describe('tracking_opted_out marker (finding 11, item 33)', () => {
  const markers = () =>
    attributeBodies().filter((b) => b.attributes && TRACKING_OPTED_OUT_ATTRIBUTE in b.attributes)
      .map((b) => b.attributes[TRACKING_OPTED_OUT_ATTRIBUTE]);

  it('optOut: true at init writes it once, and not again on the next page view', async () => {
    await reload({ optOut: true });
    await waitFor(() => markers().length === 1, 3000);
    await reload({ optOut: true });
    await settle(50);
    expect(markers()).toEqual([true]);
  });

  it('optIn() clears it; an unchanged switch sends nothing', async () => {
    await reload();
    await settle(50);
    expect(markers()).toEqual([]);
    sdk!.optOut();
    await waitFor(() => markers().length === 1, 3000);
    sdk!.optIn();
    await waitFor(() => markers().length === 2, 3000);
    expect(markers()).toEqual([true, false]);
  });

  it('is retried until acknowledged', async () => {
    let fail = true;
    calls = installFetch((req) =>
      req.path.endsWith('/v1/attributes') && fail ? { status: 503, body: {} } : ok(req));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    sdk = new JoryioSDK({ ...BASE_CONFIG, optOut: true });
    await jest.advanceTimersByTimeAsync(10);
    fail = false;
    await jest.advanceTimersByTimeAsync(6000);
    jest.useRealTimers();
    await settle(20);
    expect(markers().length).toBeGreaterThanOrEqual(2);
    expect(store.get([...store.keys()].find((k) => k.endsWith('reported_tracking_opted_out'))!)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Item 35: forced flushes and the flush interval
// ---------------------------------------------------------------------------

describe('flush pacing (item 35)', () => {
  it("flush() skips the SDK's own backoff", async () => {
    let fail = true;
    calls = installFetch((req) => (req.path.endsWith('/v1/track/batch') && fail ? { status: 503, body: {} } : ok(req)));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false, retryBackoffMs: 60_000 });
    sdk.track('E');
    await sdk.flush();
    fail = false;
    await sdk.flush();
    expect(batches().filter((c) => c.body.events.some((e: any) => e.type === 'E'))).toHaveLength(2);
  });

  it("flush() never skips a server's Retry-After", async () => {
    let fail = true;
    calls = installFetch((req) =>
      req.path.endsWith('/v1/track/batch') && fail ? { status: 429, body: {}, headers: { 'retry-after': '120' } } : ok(req));
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: false });
    sdk.track('E');
    await sdk.flush();
    fail = false;
    await sdk.flush();
    expect(batches()).toHaveLength(1);
  });

  it('batchFlushInterval is clamped to a sane minimum', () => {
    expect(resolveConfig({ sdkKey: 'jry_sdk_x', batchFlushInterval: 5 }).batchFlushInterval).toBe(MIN_FLUSH_INTERVAL);
    expect(resolveConfig({ sdkKey: 'jry_sdk_x', batchFlushInterval: 20000 }).batchFlushInterval).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// Findings 3 / item 26 (SDK level): reset during an in-flight in-app sync
// ---------------------------------------------------------------------------

describe('reset during an in-flight in-app sync (finding 3, item 26)', () => {
  it("the previous user's campaigns are never installed, and the new visitor is synced", async () => {
    installFakeDocument();
    browser();
    let syncCount = 0;
    calls = installFetch((req) => {
      if (req.path.endsWith('/v1/in-app/sync')) {
        syncCount++;
        const campaigns = req.body.userId === 'A'
          ? [{ id: 'A-only', name: 'A', type: 'modal', triggers: [], content: { kind: 'native', title: 'A', body: 'A' } }]
          : [];
        return { status: 200, body: { success: true, campaigns } };
      }
      return ok(req);
    });
    const inner = (globalThis as any).fetch;
    let release: (() => void) | null = null;
    let first = true;
    (globalThis as any).fetch = (url: string, init: any) => {
      if (String(url).endsWith('/v1/in-app/sync') && first) {
        first = false;
        return new Promise((resolve) => {
          release = () => resolve(inner(url, init));
        });
      }
      return inner(url, init);
    };
    try {
      sdk = new JoryioSDK({ ...BASE_CONFIG, userId: 'A', inApp: { enabled: true } });
      await waitFor(() => release !== null, 3000);
      await sdk.reset();
      const newAnon = sdk.getAnonymousId();
      release!();
      await waitFor(() => syncCount >= 2, 3000);
      await settle(30);
      expect(sdk.getInAppCampaigns().map((c) => c.id)).not.toContain('A-only');
      const last = calls.filter((c) => c.path.endsWith('/v1/in-app/sync')).pop()!;
      expect(last.body.userId).toBeUndefined();
      expect(last.body.anonymousId).toBe(newAnon);
    } finally {
      uninstallFakeDocument();
    }
  });
});
