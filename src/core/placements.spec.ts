import {
  PlacementManager,
  PlacementConsent,
  PLACEMENT_MIN_REFRESH_SECONDS,
  PLACEMENT_VIEWABLE_FRACTION,
  PLACEMENT_BATCH_WINDOW_MS,
  isAppDeepLink,
  placementsStorageKey,
  PLACEMENT_PRODUCT_CARD_WIDTH,
  PLACEMENT_PRODUCT_ELEMENT_PREFIX,
  placementProductElementId,
} from './placements';
import { IN_APP_DISPLAY_DWELL_MS } from './inapp';
import { installFetch, RecordedRequest, Responder } from './test-harness';
import { LinkRouter, JoryioLink } from './links';

/**
 * Placements on web (docs/PLACEMENTS_PLAN.md, PR 5). The serve endpoint is
 * mocked; the request and response shapes are the plan's section 3.5.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
let userId: string | null = null;
const identity = {
  getUserId: () => userId,
  getAnonymousId: () => 'anon-1',
} as any;
const session = { getSessionId: () => 's-1' } as any;

// ── a tiny DOM + IntersectionObserver ────────────────────────────────────
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs = new Map<string, string>();
  style: any = { cssText: '', display: '', height: '' };
  className = '';
  textContent = '';
  srcdoc = '';
  src = '';
  alt = '';
  type = '';
  isConnected = true;
  listeners = new Map<string, () => void>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, fn);
  }
  click() {
    this.listeners.get('click')?.();
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    for (const c of this.children) {
      if (pred(c)) return c;
      const d = c.find(pred);
      if (d) return d;
    }
    return null;
  }
}

class FakeIO {
  static all: FakeIO[] = [];
  targets: any[] = [];
  disconnected = false;
  constructor(public cb: (entries: any[]) => void) {
    FakeIO.all.push(this);
  }
  observe(t: any) {
    this.targets.push(t);
  }
  disconnect() {
    this.disconnected = true;
  }
}
/** Report `ratio` of `target` in view to every live observer of it. */
const view = (target: any, ratio: number) =>
  FakeIO.all
    .filter((o) => !o.disconnected && o.targets.includes(target))
    .forEach((o) => o.cb([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]));

let docListeners: Map<string, () => void>;
let autoMountEls: FakeEl[];
let session_: Map<string, string>;

beforeEach(() => {
  jest.useFakeTimers();
  userId = null;
  FakeIO.all = [];
  docListeners = new Map();
  autoMountEls = [];
  session_ = new Map();
  (globalThis as any).IntersectionObserver = FakeIO;
  (globalThis as any).document = {
    createElement: (tag: string) => new FakeEl(tag),
    visibilityState: 'visible',
    readyState: 'complete',
    body: new FakeEl('body'),
    addEventListener: (t: string, fn: () => void) => docListeners.set(t, fn),
    removeEventListener: () => undefined,
    querySelectorAll: () => autoMountEls,
  };
  (globalThis as any).window = {
    location: { origin: 'https://shop.example', pathname: '/cart', href: 'https://shop.example/cart?email=a@b.c#x' },
    open: jest.fn(),
  };
  (globalThis as any).navigator = { language: 'he-IL' };
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => session_.get(k) ?? null,
    setItem: (k: string, v: string) => session_.set(k, v),
    removeItem: (k: string) => session_.delete(k),
  };
});

afterEach(() => {
  jest.useRealTimers();
  for (const k of ['IntersectionObserver', 'document', 'window', 'navigator', 'sessionStorage']) delete (globalThis as any)[k];
});

const item = (extra: Record<string, unknown> = {}) => ({
  id: 'camp-1',
  variantId: 'v2',
  deliveryToken: 'tok-1',
  priority: 8,
  kind: 'native',
  data: { headline: 'Free shipping today' },
  content: { kind: 'native', title: 'Free shipping', body: 'Today only', buttons: [{ id: 'cta', text: 'Shop', action: 'url', url: 'https://shop.example/sale' }] },
  ...extra,
});

const answer = (placements: Record<string, any>) => ({
  status: 200,
  body: { success: true, evaluatedAt: '2026-11-20T10:00:00Z', placements },
});

const hero = (extra: Record<string, unknown> = {}) => ({
  placementKey: 'home_hero',
  emptyBehavior: 'collapse',
  maxItems: 1,
  ttlSeconds: 300,
  isControl: false,
  controlToken: null,
  items: [item()],
  ...extra,
});

let calls: RecordedRequest[];
const serves = () => calls.filter((c) => c.path === '/api/v1/in-app/placements');
const tracks = () => calls.filter((c) => c.path === '/api/v1/in-app/track').map((c) => c.body);

function make(opts: { consent?: PlacementConsent | null; allowHtml?: boolean; responder?: Responder } = {}) {
  calls = installFetch(opts.responder || (() => answer({ home_hero: hero() })));
  const consent = 'consent' in opts ? opts.consent! : 'granted';
  return new PlacementManager('https://api.example/api', 'jry_sdk_web_test', identity, session, logger, {
    consent: () => consent,
    allowHtml: () => opts.allowHtml === true,
  });
}

const flush = async (ms = PLACEMENT_BATCH_WINDOW_MS) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('placements: fetching', () => {
  it('batches keys asked for within the window into ONE request with the plan 3.5 body', async () => {
    const m = make({ responder: () => answer({ home_hero: hero(), cart_upsell: { placementKey: 'cart_upsell', items: [] } }) });
    const a = m.getPlacements(['home_hero']);
    const b = m.getPlacements(['cart_upsell', 'home_hero']);
    await flush();
    const [ra, rb] = await Promise.all([a, b]);
    expect(serves()).toHaveLength(1);
    const body = serves()[0].body;
    expect(body.placements.sort()).toEqual(['cart_upsell', 'home_hero']);
    expect(body).toMatchObject({
      anonymousId: 'anon-1',
      sessionId: 's-1',
      deviceType: 'web',
      locale: 'he-IL',
      trackingConsent: 'granted',
      shown: {},
    });
    expect(body.capabilities).toEqual(expect.arrayContaining(['placements', 'content.native', 'content.data']));
    expect(body.capabilities).not.toContain('content.html');
    // The page address without its query or fragment (PII lives there).
    expect(body.context).toEqual({ url: 'https://shop.example/cart', screen: null });
    expect(ra.home_hero.items[0]).toMatchObject({ id: 'camp-1', kind: 'native', data: { headline: 'Free shipping today' } });
    // A key the server left out is an empty placement, not an error.
    expect(rb.cart_upsell).toMatchObject({ placementKey: 'cart_upsell', items: [], isControl: false, emptyBehavior: 'collapse' });
    expect(serves()[0].init.headers['X-SDK-Key']).toBe('jry_sdk_web_test');
  });

  it('serves from the cache for ttlSeconds, then asks again', async () => {
    const m = make();
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    await m.getPlacements(['home_hero']);
    expect(serves()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(300_000);
    const again = m.getPlacements(['home_hero']);
    await flush();
    await again;
    expect(serves()).toHaveLength(2);
  });

  it(`refreshes a key at most once per ${PLACEMENT_MIN_REFRESH_SECONDS} s; extra refreshes coalesce into one`, async () => {
    const m = make();
    const first = m.refreshPlacements(['home_hero']);
    await flush();
    await first;
    await m.refreshPlacements(['home_hero']);
    await m.refreshPlacements(['home_hero']);
    await m.refreshPlacements(['home_hero']);
    expect(serves()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(PLACEMENT_MIN_REFRESH_SECONDS * 1000 + 100);
    expect(serves()).toHaveLength(2);
  });

  it('keeps the cached answer when the server says 429', async () => {
    let status = 200;
    const m = make({ responder: () => (status === 200 ? answer({ home_hero: hero({ ttlSeconds: 60 }) }) : { status }) });
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    status = 429;
    await jest.advanceTimersByTimeAsync(61_000);
    const again = m.getPlacements(['home_hero']);
    await flush();
    const r = await again;
    expect(serves()).toHaveLength(2);
    expect(r.home_hero.items.map((i) => i.id)).toEqual(['camp-1']);
  });

  it('discards an answer that predates an identity change', async () => {
    const m = make();
    let release: (v: any) => void = () => undefined;
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = jest.fn((url: string, init: any) =>
      new Promise((resolve) => {
        release = () => resolve(original(url, init));
      }));
    const p = m.getPlacements(['home_hero']);
    await flush();
    m.invalidate(); // identify / reset / consent while the request is out
    release(undefined);
    await jest.advanceTimersByTimeAsync(0);
    expect((await p).home_hero.items).toHaveLength(0);
  });

  it('chunks more than 10 keys into several requests', async () => {
    const m = make({ responder: () => answer({}) });
    const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const p = m.getPlacements(keys);
    await flush();
    await p;
    expect(serves().map((s) => s.body.placements.length)).toEqual([10, 2]);
  });

  it('refuses keys that are not placement keys', async () => {
    const m = make();
    const r = m.getPlacements(['Home Hero', '']);
    await flush();
    expect(await r).toEqual({});
    expect(serves()).toHaveLength(0);
  });
});

describe('placements: consent', () => {
  it('without consent: an anonymous request (no ids, no session, no auth) and nothing reported', async () => {
    const m = make({ consent: 'denied' });
    const p = m.getPlacements(['home_hero']);
    await flush();
    const r = await p;
    const body = serves()[0].body;
    expect(body.trackingConsent).toBe('denied');
    expect(body).not.toHaveProperty('anonymousId');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('sessionId');
    r.home_hero.items[0].markDisplayed();
    r.home_hero.items[0].markClicked('cta');
    await flush();
    expect(tracks()).toHaveLength(0);
  });

  it('pending consent is sent as `pending`', async () => {
    const m = make({ consent: 'pending' });
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    expect(serves()[0].body.trackingConsent).toBe('pending');
  });

  it('nothing at all while sending is impossible (not initialised, suspended)', async () => {
    const m = make({ consent: null });
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    expect(calls).toHaveLength(0);
  });
});

describe('placements: drawing and viewability', () => {
  const insert = async (m: PlacementManager, el: FakeEl = new FakeEl('div')) => {
    m.insertPlacement('home_hero', el as any);
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    return el;
  };
  const card = (el: FakeEl) => el.find((e) => e.className === 'joryio-placement-card');

  it('draws a native item inside the element, as text (never markup)', async () => {
    const m = make({
      responder: () => answer({ home_hero: hero({ items: [item({ content: { kind: 'native', title: '<img src=x onerror=alert(1)>', body: 'b' } })] }) }),
    });
    const el = await insert(m);
    const c = card(el)!;
    expect(c).toBeTruthy();
    expect(c.find((e) => e.className === 'joryio-placement-title')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.getAttribute('data-joryio-placement-state')).toBe('filled');
  });

  it(`reports in_app.displayed once ${PLACEMENT_VIEWABLE_FRACTION * 100}% was in view for ${IN_APP_DISPLAY_DWELL_MS} ms`, async () => {
    const m = make();
    const el = await insert(m);
    const c = card(el)!;
    view(c, 0.4);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 2);
    expect(tracks()).toHaveLength(0);
    view(c, 0.6);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS - 1);
    view(c, 0.2); // scrolled away before the dwell
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS);
    expect(tracks()).toHaveLength(0);
    view(c, 0.6);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS);
    expect(tracks()).toEqual([
      expect.objectContaining({
        campaignId: 'camp-1',
        variantId: 'v2',
        deliveryToken: 'tok-1',
        placementKey: 'home_hero',
        action: 'displayed',
        anonymousId: 'anon-1',
        deviceType: 'web',
      }),
    ]);
    view(c, 0.9);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 2);
    expect(tracks()).toHaveLength(1);
  });

  it('pauses the dwell while the page is hidden', async () => {
    const m = make();
    const el = await insert(m);
    view(card(el)!, 1);
    (document as any).visibilityState = 'hidden';
    docListeners.get('visibilitychange')!();
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 3);
    expect(tracks()).toHaveLength(0);
    (document as any).visibilityState = 'visible';
    docListeners.get('visibilitychange')!();
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS);
    expect(tracks()).toHaveLength(1);
  });

  it('a button click reports displayed first, then clicked, opens http(s) only, and keeps the item', async () => {
    const m = make();
    const el = await insert(m);
    const button = el.find((e) => e.tagName === 'BUTTON')!;
    button.click();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks().map((t) => t.action)).toEqual(['displayed', 'clicked']);
    expect(tracks()[1]).toMatchObject({ elementId: 'cta', clicked: true });
    expect((window as any).open).toHaveBeenCalledWith('https://shop.example/sale', '_blank', 'noopener');
    expect(card(el)).toBeTruthy();
  });

  it('a dismissal is reported and the item is gone until the server answers again', async () => {
    const m = make();
    await insert(m);
    const r = await m.getPlacements(['home_hero']);
    r.home_hero.items[0].markDismissed();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks().map((t) => t.action)).toEqual(['displayed', 'dismissed']);
    expect((await m.getPlacements(['home_hero'])).home_hero.items).toHaveLength(0);
  });

  it('collapse: nothing drawn takes no space; keep_space keeps the box', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [] }) }) });
    const el = await insert(m);
    expect(el.getAttribute('data-joryio-placement-state')).toBe('empty');
    expect(el.find((e) => e.className === 'joryio-placement')!.style.display).toBe('none');
    session_.clear();
    const k = make({ responder: () => answer({ home_hero: hero({ items: [], emptyBehavior: 'keep_space' }) }) });
    const el2 = await insert(k);
    expect(el2.find((e) => e.className === 'joryio-placement')!.style.display).toBe('');
  });

  it('a held-out visitor sees nothing, and in_app.control_viewed goes once when the spot was viewable', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [], isControl: true, controlToken: 'ctl-1' }) }) });
    const el = await insert(m);
    expect(card(el)).toBeNull();
    expect(el.getAttribute('data-joryio-placement-state')).toBe('control');
    view(el, 1); // a collapsed (zero-area) spot reports ratio 1 while on screen
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS);
    expect(tracks()).toEqual([
      expect.objectContaining({ action: 'control_viewed', controlToken: 'ctl-1', placementKey: 'home_hero', anonymousId: 'anon-1' }),
    ]);
    expect(tracks()[0]).not.toHaveProperty('campaignId');
    (await m.getPlacements(['home_hero'])).home_hero.markDisplayed();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks()).toHaveLength(1);
  });

  it('never swaps content under the reader: a new answer waits until the spot leaves the viewport', async () => {
    let n = 1;
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ id: `camp-${n}` })] }) }) });
    const el = await insert(m);
    view(el, 1);
    n = 2;
    await jest.advanceTimersByTimeAsync(PLACEMENT_MIN_REFRESH_SECONDS * 1000);
    const p = m.refreshPlacements(['home_hero']);
    await flush();
    await p;
    expect(serves()[1].body.shown).toEqual({ home_hero: ['camp-1'] });
    expect(card(el)!.getAttribute('data-joryio-item')).toBe('camp-1');
    view(el, 0);
    expect(card(el)!.getAttribute('data-joryio-item')).toBe('camp-2');
  });

  it('HTML items: skipped unless allowHtmlJsInAppMessages; otherwise the overlay sandbox and nonce CSP', async () => {
    const html = item({ kind: 'html', content: { kind: 'html', html: '<p>Hi</p><script>alert(1)</script>', css: 'p{color:red}' } });
    const off = make({ responder: () => answer({ home_hero: hero({ items: [html] }) }) });
    const el = await insert(off);
    expect(el.find((e) => e.tagName === 'IFRAME')).toBeNull();
    session_.clear();
    const on = make({ allowHtml: true, responder: () => answer({ home_hero: hero({ items: [html] }) }) });
    const el2 = await insert(on);
    const frame = el2.find((e) => e.tagName === 'IFRAME')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups');
    expect(frame.srcdoc).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'nonce-/);
    expect(frame.srcdoc).toContain('"__joryioPlacement"');
    expect(serves()[0].body.capabilities).toContain('content.html');
  });

  it('the HTML bridge acts only for a drawn frame', async () => {
    const html = item({ kind: 'html', content: { kind: 'html', html: '<a href="https://x.example">x</a>' } });
    const m = make({ allowHtml: true, responder: () => answer({ home_hero: hero({ items: [html] }) }) });
    await insert(m);
    const bridge = (window as any).__joryioPlacement;
    bridge.logClick('p999', 'cta');
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks()).toHaveLength(0);
    bridge.logClick('p1', 'cta');
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks().map((t) => t.action)).toEqual(['displayed', 'clicked']);
    bridge.navigate('p1', 'javascript:alert(1)');
    expect((window as any).open).not.toHaveBeenCalled();
  });

  it('a data-only item is not drawn (the app draws it from getPlacements)', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ kind: 'data', content: undefined })] }) }) });
    const el = await insert(m);
    expect(card(el)).toBeNull();
    expect((await m.getPlacements(['home_hero'])).home_hero.items[0].kind).toBe('data');
  });

  const products = [
    { id: 'sku-1', title: 'Mug', price: '$9', compareAtPrice: '$12', discountPercent: 25, imageUrl: 'https://cdn.example/mug.png', url: 'https://shop.example/mug' },
    { id: 'sku-2', title: 'Cup', price: '$5', compareAtPrice: null, discountPercent: null, imageUrl: 'javascript:alert(1)', url: 'myapp://product/2' },
    { id: 'sku-3', title: 'No link', price: '$1', compareAtPrice: null, discountPercent: null, imageUrl: null, url: null },
  ];
  const productCards = (el: FakeEl) => {
    const row = el.find((e) => e.className === 'joryio-placement-products');
    return row ? row.children : [];
  };

  it('a data item with products draws the built-in product cards row (image, title, price, compare-at price)', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ kind: 'data', content: undefined, products })] }) }) });
    const el = await insert(m);
    const cards = productCards(el);
    expect(cards.map((c) => c.getAttribute('data-joryio-product'))).toEqual(['sku-1', 'sku-2', 'sku-3']);
    expect(cards[0].style.cssText).toContain(`flex:0 0 ${PLACEMENT_PRODUCT_CARD_WIDTH}px`);
    expect(cards[0].find((e) => e.className === 'joryio-placement-product-image')!.src).toBe('https://cdn.example/mug.png');
    expect(cards[0].find((e) => e.className === 'joryio-placement-product-title')!.textContent).toBe('Mug');
    expect(cards[0].find((e) => e.className === 'joryio-placement-product-price')!.textContent).toBe('$9');
    expect(cards[0].find((e) => e.className === 'joryio-placement-product-compare')!.textContent).toBe('$12');
    // An unsafe image URL draws no image; no button unless productButtonText is set.
    expect(cards[1].find((e) => e.className === 'joryio-placement-product-image')).toBeNull();
    expect(el.find((e) => e.className === 'joryio-placement-product-button')).toBeNull();
    expect(el.getAttribute('data-joryio-placement-state')).toBe('filled');
  });

  it('a product tap reports clicked with product:<id> and opens its link like a deep_link button', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ products })] }) }) });
    const onDeepLink = jest.fn();
    const el = new FakeEl('div');
    m.insertPlacement('home_hero', el as any, { onDeepLink, productButtonText: 'Buy', productCardWidth: 120 });
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    // The native card stays; the row follows it.
    expect(card(el)).toBeTruthy();
    const cards = productCards(el);
    expect(cards[0].style.cssText).toContain('flex:0 0 120px');
    cards[0].click();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks().map((t) => t.action)).toEqual(['displayed', 'clicked']);
    expect(tracks()[1]).toMatchObject({ elementId: placementProductElementId('sku-1'), clicked: true, placementKey: 'home_hero' });
    expect(placementProductElementId('sku-1')).toBe(`${PLACEMENT_PRODUCT_ELEMENT_PREFIX}sku-1`);
    expect((window as any).open).toHaveBeenCalledWith('https://shop.example/mug', '_blank', 'noopener');
    // The optional button does the same as the card, once.
    cards[1].find((e) => e.className === 'joryio-placement-product-button')!.click();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks()[2]).toMatchObject({ elementId: 'product:sku-2' });
    expect(onDeepLink).toHaveBeenCalledWith('myapp://product/2', expect.objectContaining({ id: 'camp-1' }));
    // No link: no button, and a tap does nothing.
    expect(cards[2].find((e) => e.className === 'joryio-placement-product-button')).toBeNull();
    cards[2].click();
    expect(tracks()).toHaveLength(3);
  });

  it('showProducts: false leaves the products to the app (the data item is not drawn)', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ kind: 'data', content: undefined, products })] }) }) });
    const el = new FakeEl('div');
    m.insertPlacement('home_hero', el as any, { showProducts: false });
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(productCards(el)).toEqual([]);
    expect(el.getAttribute('data-joryio-placement-state')).toBe('empty');
    expect((await m.getPlacements(['home_hero'])).home_hero.items[0].products.map((p) => p.id)).toEqual(['sku-1', 'sku-2', 'sku-3']);
  });

  it('placementProductElementId stays within the 128-character elementId limit', () => {
    expect(placementProductElementId('x'.repeat(300))).toHaveLength(128);
  });

  it('auto-mounts [data-joryio-placement] elements, and remove() stops filling one', async () => {
    const el = new FakeEl('div');
    el.setAttribute('data-joryio-placement', 'home_hero');
    autoMountEls = [el];
    const m = make();
    m.autoMount();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(card(el)).toBeTruthy();
    const handle = m.insertPlacement('home_hero', el as any)!;
    handle.remove();
    expect(card(el)).toBeNull();
    expect(el.getAttribute('data-joryio-placement-state')).toBeNull();
  });
});

describe('placements: security review fixes', () => {
  const insert = async (m: PlacementManager, opts: any = {}, el: FakeEl = new FakeEl('div')) => {
    m.insertPlacement('home_hero', el as any, opts);
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    return el;
  };

  it('a deep_link goes to the app handler; without one only http(s) opens, never another scheme', async () => {
    const deep = (url: string) =>
      answer({ home_hero: hero({ items: [item({ content: { kind: 'native', title: 't', buttons: [{ id: 'go', text: 'Go', action: 'deep_link', url }] } })] }) });
    const routed: string[] = [];
    let m = make({ responder: () => deep('myapp://cart') });
    let el = await insert(m, { onDeepLink: (url: string) => routed.push(url) });
    el.find((e) => e.tagName === 'BUTTON')!.click();
    expect(routed).toEqual(['myapp://cart']);
    expect((window as any).open).not.toHaveBeenCalled();
    session_.clear();
    m = make({ responder: () => deep('javascript:alert(1)') });
    el = await insert(m);
    el.find((e) => e.tagName === 'BUTTON')!.click();
    expect((window as any).open).not.toHaveBeenCalled();
  });

  it('isAppDeepLink: only a scheme:// app link that is not http(s) nor a refused scheme', () => {
    for (const url of ['myapp://cart', 'MyApp://p/1?x=y', 'com.shop.app://home']) expect({ url, ok: isAppDeepLink(url) }).toEqual({ url, ok: true });
    for (const url of [
      'javascript:alert(1)', 'javascript://%0aalert(1)', 'JAVASCRIPT://x', 'data:text/html,x', 'data://x', 'intent://scan#Intent;end',
      'file:///etc/passwd', 'vbscript://x', 'blob://x', 'about://blank', 'content://x', 'http://x.example', 'https://x.example',
      'myapp:cart', 'myapp://', '/relative', '', null, undefined, 42,
    ]) expect({ url, ok: isAppDeepLink(url) }).toEqual({ url, ok: false });
  });

  it('a deep_link handler never receives javascript:, data:, intent: or http(s); http(s) opens in a new tab', async () => {
    const deep = (url: string) =>
      answer({ home_hero: hero({ items: [item({ content: { kind: 'native', title: 't', buttons: [{ id: 'go', text: 'Go', action: 'deep_link', url }] } })] }) });
    for (const url of ['javascript:alert(1)', 'javascript://%0aalert(1)', 'data:text/html,<script>x</script>', 'intent://x#Intent;end', 'https://shop.example/p', 'http://shop.example/p']) {
      const routed: string[] = [];
      (window as any).open.mockClear();
      session_.clear();
      const m = make({ responder: () => deep(url) });
      const el = await insert(m, { onDeepLink: (u: string) => routed.push(u) });
      el.find((e) => e.tagName === 'BUTTON')!.click();
      expect({ url, routed }).toEqual({ url, routed: [] });
      if (url.startsWith('http')) expect((window as any).open).toHaveBeenCalledWith(url, '_blank', 'noopener');
      else expect((window as any).open).not.toHaveBeenCalled();
    }
  });

  it('the HTML bridge counts a click and opens a link only with a user gesture, and never navigates the host page', async () => {
    const html = item({ kind: 'html', content: { kind: 'html', html: '<a href="https://x.example">x</a>' } });
    const m = make({ allowHtml: true, responder: () => answer({ home_hero: hero({ items: [html] }) }) });
    await insert(m);
    const bridge = (window as any).__joryioPlacement;
    (navigator as any).userActivation = { isActive: false };
    bridge.logClick('p1', 'cta');
    bridge.navigate('p1', 'https://x.example', '_top');
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks()).toHaveLength(0);
    expect((window as any).open).not.toHaveBeenCalled();
    (navigator as any).userActivation = { isActive: true };
    bridge.navigate('p1', 'https://x.example', '_top');
    expect((window as any).open).toHaveBeenCalledWith('https://x.example', '_blank', 'noopener');
    expect((window as any).top).toBeUndefined();
    const frame = (m as any).frames.get('p1').iframe as FakeEl;
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-top-navigation|allow-forms/);
    expect(frame.srcdoc).toContain("form-action 'none'");
  });

  it('a Placement or item from before an identity change reports nothing', async () => {
    const m = make();
    const p = m.getPlacements(['home_hero']);
    await flush();
    const old = (await p).home_hero;
    m.invalidate();
    old.items[0].markDisplayed();
    old.items[0].markClicked('cta');
    old.items[0].markDismissed();
    await jest.advanceTimersByTimeAsync(0);
    expect(tracks()).toHaveLength(0);
  });

  it('identify / reset clears the drawn content at once, even on screen', async () => {
    const m = make();
    const el = await insert(m);
    view(el, 1);
    expect(el.find((e) => e.className === 'joryio-placement-card')).toBeTruthy();
    m.invalidate();
    expect(el.find((e) => e.className === 'joryio-placement-card')).toBeNull();
  });
});

describe('placements: event triggers, listeners, session cache', () => {
  it('an event-triggered item waits, hidden, until the app tracks its event', async () => {
    const triggered = item({ triggers: [{ type: 'event', event: 'checkout_started', attribute: 'value', operator: 'gt', value: 50 }] });
    const m = make({ responder: () => answer({ home_hero: hero({ items: [triggered] }) }) });
    const p = m.getPlacements(['home_hero']);
    await flush();
    expect((await p).home_hero.items).toHaveLength(0);
    m.onEventTracked('checkout_started', { value: 10 });
    expect((await m.getPlacements(['home_hero'])).home_hero.items).toHaveLength(0);
    m.onEventTracked('checkout_started', { value: 80 });
    expect((await m.getPlacements(['home_hero'])).home_hero.items).toHaveLength(1);
    expect(serves()).toHaveLength(1); // no round trip
  });

  it('onPlacementsUpdated hears changed placements; the unsubscribe stops it', async () => {
    const m = make();
    const heard: string[][] = [];
    const off = m.onPlacementsUpdated((u) => heard.push(Object.keys(u)));
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    expect(heard).toEqual([['home_hero']]);
    off();
    m.invalidate();
    const q = m.getPlacements(['home_hero']);
    await flush();
    await q;
    expect(heard).toHaveLength(1);
  });

  it('the session cache serves the next page view for the same visitor only', async () => {
    const m = make();
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    const next = make();
    expect((await next.getPlacements(['home_hero'])).home_hero.items).toHaveLength(1);
    expect(serves()).toHaveLength(0); // the new fetch stub saw nothing
    userId = 'user-2';
    const other = make();
    const r = other.getPlacements(['home_hero']);
    await flush();
    await r;
    expect(serves()).toHaveLength(1);
    expect(serves()[0].body.userId).toBe('user-2');
  });

  it('the session cache is per workspace (SDK key hash); the old origin-wide entry is never read and is removed', async () => {
    session_.set('joryio_placements_v1', JSON.stringify({ subject: '|anon-1', entries: { home_hero: { placement: hero(), fetchedAt: Date.now() } } }));
    const m = make();
    expect(session_.has('joryio_placements_v1')).toBe(false);
    const p = m.getPlacements(['home_hero']);
    await flush();
    await p;
    expect(serves()).toHaveLength(1);
    expect(session_.get(placementsStorageKey('jry_sdk_web_test'))).toContain('home_hero');
    expect(placementsStorageKey('jry_live_workspace_a')).not.toBe(placementsStorageKey('jry_live_workspace_b'));
    expect(placementsStorageKey('jry_sdk_web_test')).not.toContain('jry_sdk_web_test');
  });

  it('expired items are not shown from the cache', async () => {
    const m = make({ responder: () => answer({ home_hero: hero({ items: [item({ expiresAt: new Date(Date.now() + 1000).toISOString() })] }) }) });
    const p = m.getPlacements(['home_hero']);
    await flush();
    expect((await p).home_hero.items).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect((await m.getPlacements(['home_hero'])).home_hero.items).toHaveLength(0);
  });
});

describe('placements: the site-wide link handler (setLinkHandler)', () => {
  const insert = async (m: PlacementManager, opts: any = {}, el: FakeEl = new FakeEl('div')) => {
    m.insertPlacement('home_hero', el as any, opts);
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    return el;
  };
  const withButton = (action: string, url: string) =>
    answer({ home_hero: hero({ items: [item({ content: { kind: 'native', title: 't', buttons: [{ id: 'go', text: 'Go', action, url }] } })] }) });

  it('sees http(s) and deep links first; taking one stops the default, declining keeps it', async () => {
    for (const take of [true, false]) {
      for (const [action, url] of [['url', 'https://shop.example/sale'], ['deep_link', 'myapp://cart']]) {
        (window as any).open.mockClear();
        session_.clear();
        const seen: JoryioLink[] = [];
        const routed: string[] = [];
        const m = make({ responder: () => withButton(action, url) });
        m.links = new LinkRouter();
        m.links.setHandler((link) => (seen.push(link), take));
        const el = await insert(m, { onDeepLink: (u: string) => routed.push(u) });
        el.find((e) => e.tagName === 'BUTTON')!.click();
        expect(seen.map((l) => [l.url, l.source, l.placementKey])).toEqual([[url, 'placement', 'home_hero']]);
        const isWeb = url.startsWith('https');
        expect({ take, url, opened: (window as any).open.mock.calls.length }).toEqual({ take, url, opened: !take && isWeb ? 1 : 0 });
        expect({ take, url, routed }).toEqual({ take, url, routed: !take && !isWeb ? [url] : [] });
      }
    }
  });

  it('a deep link reaches the site-wide handler without an onDeepLink; a refused scheme never does', async () => {
    for (const url of ['myapp://cart', 'javascript:alert(1)', 'intent://x#Intent;end']) {
      session_.clear();
      const seen: string[] = [];
      const m = make({ responder: () => withButton('deep_link', url) });
      m.links = new LinkRouter();
      m.links.setHandler((link) => (seen.push(link.url), true));
      const el = await insert(m);
      el.find((e) => e.tagName === 'BUTTON')!.click();
      expect({ url, seen }).toEqual({ url, seen: url === 'myapp://cart' ? [url] : [] });
    }
  });
});

