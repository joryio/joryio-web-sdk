import { JoryioSDK } from './sdk';
import {
  BASE_CONFIG,
  installFetch,
  installLocalStorage,
  uninstallLocalStorage,
  settle,
  waitFor,
  RecordedRequest,
} from './test-harness';
import { readClickIdentityToken, withoutClickIdentityToken } from './click-identity';

/**
 * Click-link identity (Joryio BACKLOG D407): a tracked link lands with
 * `jr_t`. The SDK strips it from the address bar before anything records
 * the landing page, and sends it to POST /v1/identify-link only when
 * tracking is allowed and nobody is identified on this browser.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const LANDING = `https://shop.example/sale?utm_source=joryio&jr_cid=enc123&jr_t=${TOKEN}#top`;

let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
let replaceState: jest.Mock;
const linkCalls = () => calls.filter((c) => c.path === '/api/v1/identify-link');

function installWindow(href: string) {
  const location = { href, search: new URL(href).search };
  replaceState = jest.fn((_state: unknown, _title: string, url: string) => {
    location.href = url;
    location.search = new URL(url).search;
  });
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location, history: { state: { app: 1 }, replaceState }, ...listeners };
  (globalThis as any).document = { referrer: '', readyState: 'complete', visibilityState: 'visible', ...listeners };
}

beforeEach(() => {
  installLocalStorage();
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

describe('jr_t on the landing page', () => {
  it('is removed from the address bar (jr_cid, utm and the fragment stay), keeping the history state', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    expect(replaceState).toHaveBeenCalledWith({ app: 1 }, '', 'https://shop.example/sale?utm_source=joryio&jr_cid=enc123#top');
    expect((globalThis as any).window.location.href).not.toContain('jr_t');
  });

  it('is never recorded as the landing page', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await sdk.flush();
    await waitFor(() => calls.some((c) => c.path === '/api/v1/track/batch'));
    const body = JSON.stringify(calls.find((c) => c.path === '/api/v1/track/batch')!.body);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain('jr_cid=enc123');
  });

  it('consent granted, anonymous: POST /v1/identify-link with exactly { token, anonymousId }, once', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await waitFor(() => linkCalls().length === 1);
    const req = linkCalls()[0];
    expect(req.init.method).toBe('POST');
    expect(req.body).toEqual({ token: TOKEN, anonymousId: sdk.getAnonymousId() });
    sdk.identifyFromLink(LANDING); // the same token again: not re-sent
    await settle(50);
    expect(linkCalls()).toHaveLength(1);
  });

  it('consent pending: nothing until the grant, then sent', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'pending' });
    await settle(50);
    expect(linkCalls()).toHaveLength(0);
    expect(replaceState).toHaveBeenCalled(); // stripped regardless
    sdk.updateConsent('granted');
    await waitFor(() => linkCalls().length === 1);
  });

  it('consent off (pending then denied, or denied, or opted out): never sent', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'pending' });
    sdk.updateConsent('denied');
    sdk.updateConsent('granted');
    await settle(100);
    expect(linkCalls()).toHaveLength(0);
    await sdk.destroy();
    sdk = null;

    installWindow(LANDING);
    localStorage.clear();
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'denied' });
    await settle(50);
    expect(linkCalls()).toHaveLength(0);
    await sdk.destroy();
    sdk = null;

    installWindow(LANDING);
    localStorage.clear();
    sdk = new JoryioSDK({ ...BASE_CONFIG, optOut: true });
    await settle(50);
    expect(linkCalls()).toHaveLength(0);
    expect((globalThis as any).window.location.href).not.toContain('jr_t');
  });

  it('an identified user on this browser always wins: not sent', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, userId: 'user-1' });
    await settle(50);
    expect(linkCalls()).toHaveLength(0);
  });

  it('a signed-in store customer (storefront identity token) always wins: not sent', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const sfToken = (vid: string) =>
      `${b64({ alg: 'ES256' })}.${b64({ iss: 'joryio-storefront', vid, exp: Math.floor(Date.now() / 1000) + 600 })}.sig`;
    sdk = new JoryioSDK({ ...BASE_CONFIG, anonymousId: 'jry_vis_STORE', storefrontIdentityToken: sfToken('jry_vis_STORE') } as any);
    await settle(50);
    expect(linkCalls()).toHaveLength(0);
  });

  it('identifyFromLink(url) for a single-page app: sends a new link\'s token, ignores a URL without one', async () => {
    installWindow('https://shop.example/');
    sdk = new JoryioSDK({ ...BASE_CONFIG });
    await settle(30);
    expect(linkCalls()).toHaveLength(0);
    sdk.identifyFromLink('https://shop.example/product/9');
    sdk.identifyFromLink('/product/9?jr_t=bad token');
    await settle(30);
    expect(linkCalls()).toHaveLength(0);
    sdk.identifyFromLink(`/product/9?jr_t=${TOKEN}`);
    await waitFor(() => linkCalls().length === 1);
  });
});

describe('helpers', () => {
  it('readClickIdentityToken accepts only a base64url token', () => {
    expect(readClickIdentityToken(LANDING)).toBe(TOKEN);
    expect(readClickIdentityToken('https://x.example/?jr_t=<script>')).toBeNull();
    expect(readClickIdentityToken('https://x.example/?jr_t=short')).toBeNull();
    expect(readClickIdentityToken(undefined)).toBeNull();
  });

  it('withoutClickIdentityToken keeps everything else', () => {
    expect(withoutClickIdentityToken('https://x.example/p?a=1&jr_t=abc&b=2#f')).toBe('https://x.example/p?a=1&b=2#f');
    expect(withoutClickIdentityToken('https://x.example/p?a=1')).toBeNull();
  });
});
