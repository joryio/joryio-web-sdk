import { JoryioSDK } from './sdk';
import { urlWithoutQuery } from './utm';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, waitFor, RecordedRequest } from './test-harness';

/**
 * 1.4.0-beta.14 test: localStorage held the full landing URL with its query
 * string (`session_landing_page`, `session_utm.landing_page`) - even with
 * `captureUTM: false`, because the UTM manager always ran. 1.4.0-beta.15:
 * what is KEPT is origin + path; the utm_* values only with captureUTM; with
 * captureUTM off nothing from the URL is stored at all. The events' own
 * url / search are unchanged (analytics, sent by design).
 */

const LANDING = 'https://shop.example/welcome?utm_source=x&token=secret#frag';
const REFERRER = 'https://shop.example/login?reset=secret2';

let sdk: JoryioSDK | null = null;
let store: Map<string, string>;
let calls: RecordedRequest[] = [];

function installWindow(href: string, referrer = REFERRER) {
  const u = new URL(href);
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = {
    location: { href, search: u.search, pathname: u.pathname, origin: u.origin, hash: u.hash },
    history: { state: null, replaceState: () => undefined },
    ...listeners,
  };
  (globalThis as any).document = { referrer, title: 'Welcome', readyState: 'complete', visibilityState: 'visible', ...listeners };
}

/** Everything the SDK wrote to localStorage, as one string. */
const stored = () => Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join('\n');
const value = (suffix: string) => {
  const entry = Array.from(store.entries()).find(([k]) => k.endsWith(`_${suffix}`));
  return entry ? JSON.parse(entry[1]).value : undefined;
};

beforeEach(() => {
  store = installLocalStorage();
  calls = installFetch();
  installWindow(LANDING);
});

afterEach(async () => {
  if (sdk) await sdk.destroy();
  sdk = null;
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('urlWithoutQuery', () => {
  it('keeps origin + path only', () => {
    expect(urlWithoutQuery('https://a.example/p/q?x=1&y=2#h')).toBe('https://a.example/p/q');
    expect(urlWithoutQuery('https://a.example')).toBe('https://a.example/');
    expect(urlWithoutQuery('not a url?token=1')).toBe('not a url');
    expect(urlWithoutQuery('')).toBeUndefined();
    expect(urlWithoutQuery(null)).toBeUndefined();
  });
});

describe('what the web SDK keeps in localStorage after a landing', () => {
  it('captureUTM on (default): the landing page without its query, utm_source kept, no token', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    expect(stored()).not.toContain('secret');
    expect(stored()).not.toContain('frag');
    expect(value('session_landing_page')).toBe('https://shop.example/welcome');
    expect(value('session_referrer')).toBe('https://shop.example/login');
    const session = value('session_utm');
    expect(session.utm_source).toBe('x');
    expect(session.landing_page).toBe('https://shop.example/welcome');
    expect(value('first_touch_utm').landing_page).toBe('https://shop.example/welcome');
    expect(value('last_touch_utm').utm_source).toBe('x');
    // The events attach the parsed values from storage - no query there either.
    sdk.track('Viewed Thing');
    await sdk.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/track/batch'));
    const events = calls.filter((c) => c.path === '/api/v1/track/batch').flatMap((c) => (c.body as any).events);
    const viewed = events.find((e: any) => e.type === 'Viewed Thing');
    expect(viewed).toBeDefined();
    expect(viewed.properties.utm_source).toBe('x');
    expect(viewed.properties.landing_page).toBe('https://shop.example/welcome');
    expect(viewed.properties.first_touch_landing_page).toBe('https://shop.example/welcome');
  });

  it('Session Start still sends the full landing address on the wire (the server builds the first Page Viewed from it)', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackSessionStart: true });
    await sdk.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/track/batch'));
    const events = calls.filter((c) => c.path === '/api/v1/track/batch').flatMap((c) => (c.body as any).events);
    const start = events.find((e: any) => e.type === 'Session Start');
    expect(start).toBeDefined();
    expect(start.properties.landing_page).toBe(LANDING);
    expect(start.properties.landing_search).toBe('?utm_source=x&token=secret');
    expect(stored()).not.toContain('secret');
  });

  it('captureUTM: false stores no UTM, referrer or landing page at all', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, captureUTM: false });
    expect(stored()).not.toContain('secret');
    expect(stored()).not.toContain('utm_source');
    expect(stored()).not.toContain('shop.example');
    for (const key of ['session_utm', 'first_touch_utm', 'last_touch_utm', 'session_referrer', 'session_landing_page']) {
      expect(value(key)).toBeUndefined();
    }
    expect(sdk.getUTMData()).toEqual({ current: null, firstTouch: null, lastTouch: null });
    sdk.updateUTM();
    expect(stored()).not.toContain('shop.example');
  });

  it('captureUTM: false removes what an earlier version or setting stored', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    expect(value('session_landing_page')).toBeDefined();
    await sdk.destroy();
    sdk = new JoryioSDK({ ...BASE_CONFIG, captureUTM: false });
    expect(stored()).not.toContain('shop.example');
  });

  it('records stored by 1.4.0-beta.14 (full URL with its query) are cut to origin + path on load', async () => {
    // Learn the key prefix, then plant beta.14-shaped records under it.
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await sdk.destroy();
    sdk = null;
    const prefix = Array.from(store.keys()).find((k) => k.endsWith('_session_utm'))!.replace(/session_utm$/, '');
    const old = { utm_source: 'old', landing_page: 'https://shop.example/a?token=secret', referrer: 'https://shop.example/r?k=secret', captured_at: 1 };
    const put = (k: string, v: unknown) => store.set(prefix + k, JSON.stringify({ value: v, expiresAt: null }));
    put('first_touch_utm', old);
    put('session_landing_page', 'https://shop.example/a?token=secret');
    installWindow('https://shop.example/plain', '');
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    expect(stored()).not.toContain('secret');
    expect(value('first_touch_utm')).toMatchObject({ utm_source: 'old', landing_page: 'https://shop.example/a', referrer: 'https://shop.example/r' });
  });
});
