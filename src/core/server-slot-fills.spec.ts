/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/hat"}
 */
import { PlacementManager, PLACEMENT_BATCH_WINDOW_MS, SERVER_FILLED_ATTR, SERVER_FILL_ATTR, SERVER_FILLS_MARKER_KEY } from './placements';
import { SERVER_PAGE_EDITS_MARKER_ID } from './page-edits';
import { IN_APP_DISPLAY_DWELL_MS } from './inapp';

/**
 * Server-filled placement slots (D466): a store plugin wrote the slot's
 * content into the HTML because Joryio's answer was the same for every
 * visitor. The SDK keeps it when the visitor's own answer is the same, and
 * reports the impression with the visitor's own token; otherwise it replaces
 * or removes it. The fill below is the backend renderer's real output
 * (common/placements/server-slot-fills.ts), as the plugins' shared PHP test pins it.
 */
const C = '3f1c2b4a-0000-4000-8000-0000000000f1';
const TOKEN = `home_hero:${C}:v1`;
// One line, a plain string: server-page-edits-parity.spec.ts compares it with the plugins' fixture.
const FILL = '<div class="joryio-placement" data-joryio-placement-key="home_hero" data-joryio-server-fill="home_hero:3f1c2b4a-0000-4000-8000-0000000000f1:v1"><div class="joryio-placement-item" data-joryio-item="3f1c2b4a-0000-4000-8000-0000000000f1"><div class="joryio-placement-html" data-joryio-item="3f1c2b4a-0000-4000-8000-0000000000f1"><template shadowrootmode="open"><style>:host{all:initial;display:block;contain:paint}.jr-body{display:flow-root;margin:8px}@media (max-width:480px){.jr-hide-mobile{display:none!important}}@media (min-width:481px){.jr-hide-desktop{display:none!important}}.jr-body{margin:0}.hero h2{color:#c00}</style><div class="jr-body"><div class="hero"><h2>Free shipping</h2><a href="https://shop.example/sale">Shop now</a></div></div></template></div><div class="joryio-placement-products" data-joryio-item="3f1c2b4a-0000-4000-8000-0000000000f1" style="display:flex;gap:8px;overflow-x:auto;box-sizing:border-box;"><a class="joryio-placement-product" data-joryio-product="sku-1" href="https://shop.example/hat" target="_blank" rel="noopener" style="flex:0 0 160px;width:160px;box-sizing:border-box;display:block;color:inherit;text-decoration:none;cursor:pointer;"><img class="joryio-placement-product-image" src="https://cdn.example/hat.png" alt="Hat" style="display:block;width:100%;aspect-ratio:1/1;object-fit:cover;"><div class="joryio-placement-product-title">Hat</div><div class="joryio-placement-product-price">$10</div></a></div></div></div>';

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1' } as any;
const session = { getSessionId: () => 's-1' } as any;

type Rec = { path: string; body: any };
let calls: Rec[];
let answer: () => any;
let consent: 'granted' | 'denied';
let allowHtml: boolean;
const tracks = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track')).map((c) => c.body);

const item = (over: Record<string, unknown> = {}) => ({
  id: C,
  variantId: 'v1',
  deliveryToken: 'visitor-token',
  deliveryId: 'dlv_x',
  kind: 'html',
  data: {},
  content: { kind: 'html', html: '<div class="hero"><h2>Free shipping</h2></div>', css: '' },
  products: [{ id: 'sku-1', title: 'Hat', price: '$10', url: 'https://shop.example/hat', imageUrl: 'https://cdn.example/hat.png' }],
  ...over,
});

function page(opts: { marker?: unknown; slotToken?: string; fill?: string } = {}) {
  const marker = opts.marker === undefined ? { v: 1, experiences: [], [SERVER_FILLS_MARKER_KEY]: [{ placementKey: 'home_hero', campaignId: C, variantId: 'v1', products: ['sku-1'] }] } : opts.marker;
  document.head.innerHTML = marker ? `<script type="application/json" id="${SERVER_PAGE_EDITS_MARKER_ID}">${JSON.stringify(marker)}</script>` : '';
  document.body.innerHTML = `<div id="spot" data-joryio-placement="home_hero" ${SERVER_FILLED_ATTR}="${opts.slotToken ?? TOKEN}" data-joryio-placement-state="filled">${opts.fill ?? FILL}</div>`;
  return document.getElementById('spot')!;
}

function start() {
  const m = new PlacementManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => consent, allowHtml: () => allowHtml });
  m.autoMount();
  return m;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  sessionStorage.clear();
  localStorage.clear();
  calls = [];
  consent = 'granted';
  allowHtml = true;
  answer = () => ({ items: [item()] });
  (window as any).open = jest.fn();
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const data = path.endsWith('/v1/in-app/placements') ? { success: true, placements: { home_hero: { placementKey: 'home_hero', ttlSeconds: 300, emptyBehavior: 'collapse', maxItems: 1, ...answer() } } } : { success: true };
    return { ok: true, status: 200, json: async () => data };
  });
});
afterEach(() => jest.useRealTimers());

const settle = async () => {
  await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
  await jest.advanceTimersByTimeAsync(0);
};

describe('server-filled slots (D466)', () => {
  it('the visitor\'s answer is the same: the server drawing is kept (no redraw) and its impression is reported with the visitor\'s own token', async () => {
    const spot = page();
    const wrapper = spot.querySelector(`[${SERVER_FILL_ATTR}]`)!;
    const m = start();
    await settle();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBe(wrapper);
    expect(spot.querySelectorAll('.joryio-placement')).toHaveLength(1);
    expect(spot.querySelector('iframe')).toBeNull();
    expect(spot.getAttribute('data-joryio-placement-state')).toBe('filled');
    // A browser without declarative shadow DOM (jsdom): the SDK attached the root as the parser would.
    const host = spot.querySelector('.joryio-placement-html')!;
    expect(host.shadowRoot?.querySelector('h2')?.textContent).toBe('Free shipping');
    expect(tracks()).toEqual([]);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS);
    expect(tracks()).toEqual([expect.objectContaining({ action: 'displayed', campaignId: C, variantId: 'v1', deliveryToken: 'visitor-token', placementKey: 'home_hero' })]);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 3);
    expect(tracks()).toHaveLength(1);
    // The next request names what is shown, like any drawn item.
    m.destroy();
  });

  it('consent denied: the generic content stays, nothing is reported', async () => {
    consent = 'denied';
    const spot = page();
    const wrapper = spot.querySelector(`[${SERVER_FILL_ATTR}]`)!;
    answer = () => ({ items: [item({ deliveryToken: null, deliveryId: null })] });
    const m = start();
    await settle();
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 2);
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBe(wrapper);
    expect(tracks()).toEqual([]);
    const serve = calls.find((c) => c.path.endsWith('/v1/in-app/placements'))!;
    expect(serve.body.userId).toBeUndefined();
    expect(serve.body.anonymousId).toBeUndefined();
    m.destroy();
  });

  it.each([
    ['another campaign', () => ({ items: [{ id: 'other', deliveryToken: 'tok-o', kind: 'native', data: {}, content: { kind: 'native', title: 'Just for you' } }] })],
    ['another variant', () => ({ items: [item({ variantId: 'v2', content: { kind: 'native', title: 'Just for you' }, kind: 'native', products: [] })] })],
    ['other products (a personal re-rank)', () => ({ items: [item({ products: [{ id: 'sku-9', title: 'Bag' }], content: { kind: 'native', title: 'Just for you' }, kind: 'native' })] })],
  ])('the visitor\'s answer differs (%s): the server drawing is replaced by the visitor\'s', async (_name, a) => {
    answer = a as any;
    const spot = page();
    const m = start();
    await settle();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBeNull();
    expect(spot.hasAttribute(SERVER_FILLED_ATTR)).toBe(false);
    expect(spot.querySelector('.joryio-placement-title')?.textContent).toBe('Just for you');
    expect(spot.querySelectorAll('.joryio-placement')).toHaveLength(1);
    m.destroy();
  });

  it.each([
    ['nothing (suppressed, paused, capped)', () => ({ items: [] })],
    ['a control answer', () => ({ items: [], isControl: true, controlToken: 'ctl' })],
  ])('the visitor gets %s: the server drawing is removed, the slot collapses', async (_name, a) => {
    answer = a as any;
    const spot = page();
    const m = start();
    await settle();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBeNull();
    expect(['empty', 'control']).toContain(spot.getAttribute('data-joryio-placement-state'));
    expect((spot.querySelector('.joryio-placement') as HTMLElement).style.display).toBe('none');
    m.destroy();
  });

  it('no answer yet (or the request failed): the server drawing stays as it is', async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error('offline');
    });
    const spot = page();
    const m = start();
    await settle();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).not.toBeNull();
    m.destroy();
  });

  it.each([
    ['no marker block', { marker: null }],
    ['the marker names another campaign', { marker: { v: 1, experiences: [], fills: [{ placementKey: 'home_hero', campaignId: 'x', variantId: 'v1', products: [] }] } }],
    ['the slot token disagrees', { slotToken: 'home_hero:x:v1' }],
  ])('an untrusted fill (%s) is removed at once and the slot drawn as usual', async (_name, opts) => {
    const spot = page(opts as any);
    const m = start();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBeNull();
    await settle();
    expect(spot.querySelector('.joryio-placement')).not.toBeNull();
    m.destroy();
  });

  it('HTML not allowed in this SDK (allowHtmlJsInAppMessages off): an HTML fill is removed, as the SDK would not draw it', async () => {
    allowHtml = false;
    const spot = page();
    const m = start();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBeNull();
    m.destroy();
  });

  it('a kept drawing reports clicks with the SDK\'s names and opens links in a new tab', async () => {
    const spot = page();
    const m = start();
    await settle();
    const card = spot.querySelector('[data-joryio-product="sku-1"]') as HTMLElement;
    card.querySelector('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(tracks()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'clicked', elementId: 'product:sku-1', deliveryToken: 'visitor-token' })]));
    expect(window.open).toHaveBeenCalledWith('https://shop.example/hat', '_blank', 'noopener');
    const link = spot.querySelector('.joryio-placement-html')!.shadowRoot!.querySelector('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // The frame's `link_click` - a generic name, sent without an elementId exactly as the frame's click is.
    const clicks = tracks().filter((t) => t.action === 'clicked');
    expect(clicks).toHaveLength(2);
    expect(clicks[1]).toMatchObject({ campaignId: C, deliveryToken: 'visitor-token' });
    expect(clicks[1].elementId).toBeUndefined();
    expect(window.open).toHaveBeenCalledWith('https://shop.example/sale', '_blank', 'noopener');
    m.destroy();
  });

  it('remove(): a drawing never settled goes with the mount', () => {
    const spot = page();
    (globalThis as any).fetch = jest.fn(() => new Promise(() => undefined));
    const m = new PlacementManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => consent, allowHtml: () => allowHtml });
    const handle = m.insertPlacement('home_hero', spot)!;
    handle.remove();
    expect(spot.querySelector(`[${SERVER_FILL_ATTR}]`)).toBeNull();
    expect(spot.hasAttribute(SERVER_FILLED_ATTR)).toBe(false);
    m.destroy();
  });

  it('wire names', () => {
    expect(SERVER_FILLED_ATTR).toBe('data-joryio-server-filled');
    expect(SERVER_FILL_ATTR).toBe('data-joryio-server-fill');
    expect(SERVER_FILLS_MARKER_KEY).toBe('fills');
  });
});
