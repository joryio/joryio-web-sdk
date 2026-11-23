/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?utm=x"}
 */
import { PageEditManager, SERVER_PAGE_EDITS_MARKER_ID, SERVER_APPLIED_ATTR, SERVER_ORIG_ATTR, SERVER_SPOT_ATTR, PAGE_EDIT_ANTI_FLICKER_MS, PAGE_EDIT_OPERATIONS, PAGE_EDIT_POSITIONS, PAGE_EDITS_CAPABILITY, isSafeSelector, isSafeEditUrl, trustedEdit, pageEditsStorageKeys, SITE_SETTINGS_SESSION_REFRESH_SECONDS } from './page-edits';
import { placementsStorageKey } from './placements';
const KEYS = pageEditsStorageKeys('jry_sdk');

/** Page edits on web (D444 Phase 4, docs/PLACEMENTS_WEBSITE_LAYER.md 2), in a real DOM. */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
let userId: string | null = null;
const identity = { getUserId: () => userId, getAnonymousId: () => 'anon-1' } as any;
let sessionId = 's-1';
const session = { getSessionId: () => sessionId } as any;

type Answer = { status?: number; body?: any; delayMs?: number };
let answer: (body: any) => Answer;
let calls: Array<{ path: string; body: any; init?: any }>;
let site: Answer | null;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = `
    <section id="hero"><h1>Welcome</h1><img class="hero" src="https://cdn.example/a.png" srcset="https://cdn.example/a2.png 2x"><a class="cta" href="/sale">Shop</a></section>
    <div class="promo">Promo</div>`;
  localStorage.clear();
  sessionStorage.clear();
  userId = null;
  sessionId = 's-1';
  calls = [];
  answer = () => ({ body: { success: true, ttlSeconds: 300, experiences: [] } });
  site = null; // no site-settings answer = unknown: behave as before
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/api/v1/in-app/site-settings')) {
      calls.push({ path, body: null, init });
      if (!site) throw new Error('offline');
      if (site.delayMs) await new Promise((r) => setTimeout(r, site!.delayMs));
      return { ok: (site.status ?? 200) < 400, status: site.status ?? 200, json: async () => site!.body };
    }
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const a = path.endsWith('/page-edits') ? answer(body) : { body: { success: true } };
    if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body };
  });
});

const experience = (edits: any[], over: Record<string, unknown> = {}) => ({
  id: 'c1', variantId: 'A', deliveryId: 'dlv_1', deliveryToken: 'tok.1', isControl: false, controlToken: null,
  selectors: edits.map((e) => e.selector), edits, ...over,
});
function make(consent: 'granted' | 'denied' = 'granted') {
  return new PageEditManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => consent });
}
const tracks = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track')).map((c) => c.body);

describe('page edits', () => {
  it('pins the wire values (the backend pins the same list)', () => {
    expect(PAGE_EDIT_OPERATIONS).toEqual(['replace_text', 'replace_image', 'replace_link', 'hide', 'insert_placement']);
    expect(PAGE_EDIT_POSITIONS).toEqual(['before', 'after', 'prepend', 'append', 'replace']);
    expect(PAGE_EDITS_CAPABILITY).toBe('page_edits');
    expect(PAGE_EDIT_ANTI_FLICKER_MS).toBe(300);
  });

  it('asks for the page without its query string, and applies every operation', async () => {
    answer = () => ({
      body: {
        success: true,
        experiences: [
          experience([
            { id: 'e1', selector: '#hero h1', operation: 'replace_text', value: '<b>Hi Ada</b>' },
            { id: 'e2', selector: 'img.hero', operation: 'replace_image', value: 'https://cdn.example/b.png' },
            { id: 'e3', selector: 'a.cta', operation: 'replace_link', value: 'https://shop.example/new' },
            { id: 'e4', selector: '.promo', operation: 'hide' },
            { id: 'e5', selector: '#hero', operation: 'insert_placement', placementKey: 'home_hero', position: 'after' },
          ]),
        ],
      },
    });
    const m = make();
    m.start();
    await flush();
    await flush();
    const req = calls.find((c) => c.path === '/api/v1/in-app/page-edits')!;
    expect(req.body.context.url).toBe('https://shop.example/products/shoes');
    expect(req.body.capabilities).toEqual(['page_context', 'page_edits']);
    const h1 = document.querySelector('#hero h1')!;
    expect(h1.textContent).toBe('<b>Hi Ada</b>'); // text is text
    expect(h1.querySelector('b')).toBeNull();
    const img = document.querySelector('img.hero')!;
    expect(img.getAttribute('src')).toBe('https://cdn.example/b.png');
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(document.querySelector('a.cta')!.getAttribute('href')).toBe('https://shop.example/new');
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('none');
    expect(document.querySelector('#hero')!.nextElementSibling!.getAttribute('data-joryio-placement')).toBe('home_hero');
    // Exposure once, with the token.
    expect(tracks()).toEqual([expect.objectContaining({ action: 'displayed', deliveryToken: 'tok.1', campaignId: 'c1', variantId: 'A' })]);
    m.destroy();
    // destroy undoes everything
    expect(document.querySelector('#hero h1')!.textContent).toBe('Welcome');
    expect(document.querySelector('img.hero')!.getAttribute('srcset')).toBe('https://cdn.example/a2.png 2x');
    expect(document.querySelector('[data-joryio-placement]')).toBeNull();
  });

  it('"Instead of it" (position replace): the element is hidden, the spot takes its place, destroy puts it back', async () => {
    (document.querySelector('.promo') as HTMLElement).style.setProperty('display', 'flex');
    answer = () => ({
      body: { success: true, experiences: [experience([{ id: 'r1', selector: '.promo', operation: 'insert_placement', placementKey: 'home_hero', position: 'replace' }])] },
    });
    expect(trustedEdit({ id: 'r1', selector: '.promo', operation: 'insert_placement', placementKey: 'home_hero', position: 'replace' })).toMatchObject({ position: 'replace' });
    const m = make();
    m.start();
    await flush();
    await flush();
    const promo = document.querySelector('.promo') as HTMLElement;
    expect(promo.style.getPropertyValue('display')).toBe('none');
    expect(promo.style.getPropertyPriority('display')).toBe('important');
    expect(promo.nextElementSibling!.getAttribute('data-joryio-placement')).toBe('home_hero');
    expect(tracks()).toEqual([expect.objectContaining({ action: 'displayed', campaignId: 'c1' })]);
    m.destroy();
    expect(promo.style.getPropertyValue('display')).toBe('flex');
    expect(document.querySelector('[data-joryio-placement]')).toBeNull();
  });

  it('never applies an untrusted edit, whatever the server sent', async () => {
    answer = () => ({
      body: {
        success: true,
        experiences: [
          experience([
            { id: 'x1', selector: 'a.cta', operation: 'replace_link', value: 'javascript:alert(1)' },
            { id: 'x2', selector: 'h1 } body { display:none', operation: 'hide' },
            { id: 'x3', selector: '#hero h1', operation: 'set_html', value: '<img src=x onerror=alert(1)>' },
            { id: 'x4', selector: 'img.hero', operation: 'replace_image', value: 'data:image/png;base64,AAAA' },
          ]),
        ],
      },
    });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('a.cta')!.getAttribute('href')).toBe('/sale');
    expect(document.querySelector('#hero h1')!.innerHTML).toBe('Welcome');
    expect(document.querySelector('img.hero')!.getAttribute('src')).toBe('https://cdn.example/a.png');
    expect(m.appliedCount()).toBe(0);
    expect(tracks()).toEqual([]);
    m.destroy();
  });

  it('applies an edit to an element that appears later (MutationObserver)', async () => {
    answer = () => ({ body: { success: true, experiences: [experience([{ id: 'e1', selector: '.late', operation: 'replace_text', value: 'Now' }])] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(tracks()).toEqual([]); // nothing landed yet: no exposure
    const late = document.createElement('p');
    late.className = 'late';
    late.textContent = 'Before';
    document.body.appendChild(late);
    await flush();
    expect(late.textContent).toBe('Now');
    expect(tracks()).toHaveLength(1);
    m.destroy();
  });

  it('anti-flicker: hides only the remembered elements, at most 300 ms, never the body', async () => {
    jest.useFakeTimers();
    try {
      localStorage.setItem(KEYS.selectors, JSON.stringify({ 'https://shop.example/products/shoes': ['#hero h1', '.promo'] }));
      answer = () => ({ delayMs: 5000, body: { success: true, experiences: [] } });
      const m = make();
      m.start();
      const style = document.getElementById('joryio-page-edits-anti-flicker')!;
      expect(style.textContent).toBe('#hero h1,.promo{opacity:0 !important}');
      expect(style.textContent).not.toMatch(/body|html/);
      jest.advanceTimersByTime(PAGE_EDIT_ANTI_FLICKER_MS);
      expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
      m.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('static edits from the last answer apply at once on the next load; personalized ones are never stored', async () => {
    answer = () => ({
      body: {
        success: true,
        experiences: [
          experience([
            { id: 'e1', selector: '.promo', operation: 'replace_text', value: 'Static' },
            { id: 'e2', selector: '#hero h1', operation: 'replace_text', value: 'Hi Ada', personalized: true },
          ]),
        ],
      },
    });
    const first = make();
    first.start();
    await flush();
    await flush();
    first.destroy();
    expect(sessionStorage.getItem(KEYS.answers)).not.toMatch(/Ada/);
    expect(localStorage.getItem(KEYS.selectors)).not.toMatch(/Ada|Static/);
    answer = () => ({ delayMs: 10_000, body: { success: true, experiences: [] } });
    const second = make();
    second.start();
    expect(document.querySelector('.promo')!.textContent).toBe('Static'); // before any answer
    expect(document.querySelector('#hero h1')!.textContent).toBe('Welcome');
    expect(tracks()).toHaveLength(1); // the cached apply reports nothing
    second.destroy();
  });

  it('a control visitor sees the page unchanged and reports control_viewed once its element is there', async () => {
    answer = () => ({ body: { success: true, experiences: [experience([], { isControl: true, deliveryToken: null, controlToken: 'ctl.1', selectors: ['#hero h1'] })] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('#hero h1')!.textContent).toBe('Welcome');
    expect(tracks()).toEqual([expect.objectContaining({ action: 'control_viewed', controlToken: 'ctl.1' })]);
    m.destroy();
  });

  it('without consent: nobody named in the request, nothing reported', async () => {
    answer = () => ({ body: { success: true, experiences: [experience([{ id: 'e1', selector: '.promo', operation: 'hide' }], { deliveryToken: null })] } });
    const m = make('denied');
    m.start();
    await flush();
    await flush();
    const req = calls.find((c) => c.path.endsWith('/page-edits'))!;
    expect(req.body.anonymousId).toBeUndefined();
    expect(req.body.trackingConsent).toBe('denied');
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('none');
    expect(tracks()).toEqual([]);
    m.destroy();
  });

  it('a failed answer leaves the page as the site drew it', async () => {
    answer = () => ({ status: 429, body: {} });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(m.appliedCount()).toBe(0);
    expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
    m.destroy();
  });

  it('a route change undoes this page\'s edits and applies the next page\'s', async () => {
    const { PageContextTracker } = await import('./page-context');
    answer = (body) => ({
      body: {
        success: true,
        experiences: body.context.url.endsWith('/cart')
          ? [experience([{ id: 'c', selector: '.promo', operation: 'replace_text', value: 'Cart promo' }], { id: 'c2', deliveryToken: 'tok.2', deliveryId: 'dlv_2' })]
          : [experience([{ id: 'e', selector: '#hero h1', operation: 'replace_text', value: 'Shoes' }])],
      },
    });
    const tracker = new PageContextTracker();
    tracker.start();
    const m = make();
    m.setPageContext(tracker);
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('#hero h1')!.textContent).toBe('Shoes');
    history.pushState(null, '', '/cart');
    expect(document.querySelector('#hero h1')!.textContent).toBe('Welcome');
    await flush();
    await flush();
    expect(document.querySelector('.promo')!.textContent).toBe('Cart promo');
    expect(tracks().map((t) => t.deliveryToken)).toEqual(['tok.1', 'tok.2']);
    m.destroy();
    tracker.destroy();
    history.replaceState(null, '', '/products/shoes?utm=x');
  });

  it('the guards match the server', () => {
    expect(isSafeSelector('main > section:nth-of-type(2)')).toBe(true);
    expect(isSafeSelector('h1{}')).toBe(false);
    expect(isSafeSelector('h1[')).toBe(false); // the browser cannot parse it
    expect(isSafeEditUrl('//evil.example')).toBe(false);
    expect(trustedEdit({ id: 'a', selector: 'main', operation: 'insert_placement', placementKey: 'home_hero' })).toMatchObject({ position: 'after' });
  });

  describe('site settings (first view, page edits off, nothing live)', () => {
    const siteAnswer = (pe: Record<string, unknown>) => ({ body: { success: true, ttlSeconds: 60, pageEdits: { enabled: true, active: true, antiFlickerSelectors: [], ...pe } } });

    it('is a CORS-simple GET with the key in the query string only, asked once', async () => {
      site = siteAnswer({});
      const m = make();
      m.start();
      await flush();
      await flush();
      const req = calls.find((c) => c.path.startsWith('/api/v1/in-app/site-settings'))!;
      expect(req.path).toBe('/api/v1/in-app/site-settings?sdkKey=jry_sdk');
      expect(req.init.headers).toBeUndefined();
      expect(req.init.method).toBe('GET');
      await m.siteSettings();
      expect(calls.filter((c) => c.path.startsWith('/api/v1/in-app/site-settings'))).toHaveLength(1);
      m.destroy();
    });

    it('first view: hides the site list (only those elements, never the body) until the answer, within 300 ms', async () => {
      jest.useFakeTimers();
      try {
        site = siteAnswer({ antiFlickerSelectors: ['#hero h1', 'body{x}', '.promo'] });
        answer = () => ({ delayMs: 1000, body: { success: true, experiences: [] } });
        const m = make();
        m.start();
        await jest.advanceTimersByTimeAsync(5);
        const style = document.getElementById('joryio-page-edits-anti-flicker')!;
        expect(style.textContent).toBe('#hero h1,.promo{opacity:0 !important}');
        await jest.advanceTimersByTimeAsync(PAGE_EDIT_ANTI_FLICKER_MS);
        expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
        m.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a site list that arrives after 300 ms hides nothing', async () => {
      jest.useFakeTimers();
      try {
        site = { ...siteAnswer({ antiFlickerSelectors: ['#hero h1'] }), delayMs: 400 };
        const m = make();
        m.start();
        await jest.advanceTimersByTimeAsync(450);
        expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
        m.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    describe('once per session (sessionStorage, tied to the session id)', () => {
      const siteCalls = () => calls.filter((c) => c.path.startsWith('/api/v1/in-app/site-settings'));
      const editCalls = () => calls.filter((c) => c.path.endsWith('/page-edits'));
      /** One full page load: a fresh manager (memory gone), the same sessionStorage. */
      async function pageLoad(sdkKey = 'jry_sdk') {
        const m = new PageEditManager('https://api.example/api', sdkKey, identity, session, logger, { consent: () => 'granted' });
        m.start();
        await flush();
        await flush();
        return m;
      }
      let now = 1_800_000_000_000;
      beforeEach(() => {
        now = 1_800_000_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
      });
      afterEach(() => jest.restoreAllMocks());

      it('pins the refresh time: 10 minutes', () => {
        expect(SITE_SETTINGS_SESSION_REFRESH_SECONDS).toBe(600);
      });

      it('one request across many page loads of one session, whatever the server ttlSeconds', async () => {
        site = siteAnswer({});
        for (let i = 0; i < 6; i++) {
          (await pageLoad()).destroy();
          now += 60_000; // a page a minute; ttlSeconds is 60
        }
        expect(siteCalls()).toHaveLength(1);
        expect(editCalls()).toHaveLength(6);
        const stored = JSON.parse(sessionStorage.getItem(KEYS.site)!);
        expect(stored).toEqual({ sid: 's-1', at: 1_800_000_000_000, value: { enabled: true, active: true, antiFlickerSelectors: [] } });
      });

      it('nothing live, stored: no request at all on the next pages (no site settings, no page edits)', async () => {
        site = siteAnswer({ active: false });
        (await pageLoad()).destroy();
        calls = [];
        (await pageLoad()).destroy();
        (await pageLoad()).destroy();
        expect(calls).toEqual([]);
      });

      it('asks again once the stored answer is 10 minutes old - in the background, and a campaign launched meanwhile is asked for on that page', async () => {
        site = siteAnswer({ active: false });
        (await pageLoad()).destroy();
        now += SITE_SETTINGS_SESSION_REFRESH_SECONDS * 1000 - 1;
        (await pageLoad()).destroy();
        expect(siteCalls()).toHaveLength(1);
        now += 1;
        site = siteAnswer({ active: true }); // launched
        const m = await pageLoad();
        await flush();
        expect(siteCalls()).toHaveLength(2);
        expect(editCalls()).toHaveLength(1);
        expect(JSON.parse(sessionStorage.getItem(KEYS.site)!).at).toBe(now);
        m.destroy();
      });

      it('a new session asks again', async () => {
        site = siteAnswer({});
        (await pageLoad()).destroy();
        sessionId = 's-2';
        (await pageLoad()).destroy();
        (await pageLoad()).destroy();
        expect(siteCalls()).toHaveLength(2);
        expect(JSON.parse(sessionStorage.getItem(KEYS.site)!).sid).toBe('s-2');
      });

      it('with a stored answer the page does not wait for the site settings before asking for its edits', async () => {
        site = siteAnswer({ antiFlickerSelectors: ['#hero h1'] });
        (await pageLoad()).destroy();
        now += SITE_SETTINGS_SESSION_REFRESH_SECONDS * 1000; // stale: refreshed in the background
        site = { ...siteAnswer({ antiFlickerSelectors: ['#hero h1'] }), delayMs: 200 };
        calls = [];
        localStorage.clear(); // a first view of this page: the site list is held back at once
        const m = new PageEditManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => 'granted' });
        m.start();
        await flush();
        // The site-settings request is still on its way; /page-edits is already asked.
        expect(siteCalls()).toHaveLength(1);
        expect(editCalls()).toHaveLength(1);
        m.destroy();
        await new Promise((r) => setTimeout(r, 250));
      });

      it('a failed request: unknown (page edits asked as before), nothing stored; a failed refresh drops the stale answer', async () => {
        site = null; // offline
        (await pageLoad()).destroy();
        expect(editCalls()).toHaveLength(1);
        expect(sessionStorage.getItem(KEYS.site)).toBeNull();
        site = siteAnswer({ active: false });
        (await pageLoad()).destroy();
        expect(sessionStorage.getItem(KEYS.site)).not.toBeNull();
        now += SITE_SETTINGS_SESSION_REFRESH_SECONDS * 1000;
        site = { status: 503, body: {} };
        (await pageLoad()).destroy();
        await flush();
        expect(sessionStorage.getItem(KEYS.site)).toBeNull();
        calls = [];
        (await pageLoad()).destroy(); // unknown again: asks both
        expect(siteCalls()).toHaveLength(1);
        expect(editCalls()).toHaveLength(1);
      });

      it('reset / wipeData / consent (invalidate with siteSettings) forget it; identify (plain invalidate) keeps it', async () => {
        site = siteAnswer({});
        const m = await pageLoad();
        m.invalidate();
        await flush();
        await flush();
        expect(sessionStorage.getItem(KEYS.site)).not.toBeNull();
        expect(siteCalls()).toHaveLength(1);
        m.invalidate({ siteSettings: true });
        // Forgotten: the page asks again (and stores the new answer).
        await flush();
        await flush();
        expect(siteCalls()).toHaveLength(2);
        m.destroy();
      });

      it('per workspace: the key carries the SDK-key hash; another workspace on the origin asks for its own', async () => {
        expect(KEYS.site).toMatch(/^jry_page_edit_site_[0-9a-z]+$/);
        expect(pageEditsStorageKeys('jry_sdk_a').site).not.toBe(pageEditsStorageKeys('jry_sdk_b').site);
        site = siteAnswer({});
        (await pageLoad('jry_sdk_a')).destroy();
        (await pageLoad('jry_sdk_b')).destroy();
        (await pageLoad('jry_sdk_a')).destroy();
        expect(siteCalls().map((c) => c.path)).toEqual(['/api/v1/in-app/site-settings?sdkKey=jry_sdk_a', '/api/v1/in-app/site-settings?sdkKey=jry_sdk_b']);
      });

      it('an answer stored for another session is never used, and is removed', async () => {
        sessionStorage.setItem(KEYS.site, JSON.stringify({ sid: 'old', at: now, value: { enabled: true, active: false, antiFlickerSelectors: [] } }));
        site = siteAnswer({});
        (await pageLoad()).destroy();
        expect(siteCalls()).toHaveLength(1);
        expect(JSON.parse(sessionStorage.getItem(KEYS.site)!).sid).toBe('s-1');
      });
    });

    it('page edits off for the site, or nothing live: no per-visitor request, and the cached static edits are undone', async () => {
      for (const pe of [{ enabled: false }, { active: false }]) {
        localStorage.clear();
        sessionStorage.clear();
        calls = [];
        // A previous answer for this page in the session cache.
        answer = () => ({ body: { success: true, experiences: [experience([{ id: 'e1', selector: '#hero h1', operation: 'replace_text', value: 'Hi' }])] } });
        site = null;
        const first = make();
        first.start();
        await flush();
        await flush();
        expect(document.querySelector('#hero h1')!.textContent).toBe('Hi');
        first.destroy();

        site = siteAnswer(pe);
        calls = [];
        const m = make();
        m.start();
        await flush();
        await flush();
        expect(calls.filter((c) => c.path.endsWith('/page-edits'))).toEqual([]);
        expect(document.querySelector('#hero h1')!.textContent).toBe('Welcome');
        expect(m.appliedCount()).toBe(0);
        expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
        m.destroy();
      }
    });
  });

  it('stores per workspace: another SDK key on the same origin never reads them, and the unscoped stores are removed', async () => {
    localStorage.setItem('jry_page_edit_selectors', JSON.stringify({ 'https://shop.example/products/shoes': ['#hero h1'] }));
    sessionStorage.setItem('jry_page_edits', '{}');
    const a = pageEditsStorageKeys('jry_sdk_a');
    const b = pageEditsStorageKeys('jry_sdk_b');
    expect(a.answers).not.toBe(b.answers);
    expect(a.selectors).not.toBe(b.selectors);
    expect(placementsStorageKey('jry_sdk_a')).not.toBe(placementsStorageKey('jry_sdk_b'));
    expect(placementsStorageKey('jry_sdk_a')).toMatch(/^joryio_placements_v1_[0-9a-z]+$/);
    const m = make();
    expect(localStorage.getItem('jry_page_edit_selectors')).toBeNull();
    expect(sessionStorage.getItem('jry_page_edits')).toBeNull();
    m.destroy();
  });
});

/**
 * Server-applied edits (D450): the page arrives with edits a store plugin
 * wrote into its HTML. This is the plugins' shared core's real output for
 * these five edits (packages/woocommerce-plugin/includes/class-joryio-server-page-edits.php,
 * Joryio_Server_Page_Edits::apply), so the two sides are tested on one contract.
 */
const SERVER_PAGE = "<!DOCTYPE html>\n<html><head><script type=\"application/json\" id=\"joryio-server-page-edits\">{\"v\":1,\"experiences\":[{\"id\":\"c1\",\"variantId\":\"A\",\"edits\":[{\"id\":\"e1\",\"selector\":\"#hero h1\",\"operation\":\"replace_text\",\"value\":\"Hi \\u003Call\\u003E\"},{\"id\":\"e2\",\"selector\":\"img.hero\",\"operation\":\"replace_image\",\"value\":\"https://cdn.example/b.png\"},{\"id\":\"e3\",\"selector\":\"a.cta\",\"operation\":\"replace_link\",\"value\":\"https://shop.example/new\"},{\"id\":\"e4\",\"selector\":\".promo\",\"operation\":\"hide\"},{\"id\":\"e5\",\"selector\":\"#hero\",\"operation\":\"insert_placement\",\"placementKey\":\"home_hero\",\"position\":\"after\"}]}]}</script><title>Shop</title></head>\n<body>\n<section id=\"hero\" data-joryio-applied=\"c1:e5\" data-joryio-orig=\"{&quot;c1:e5&quot;:{&quot;spot&quot;:&quot;after&quot;}}\"><h1 data-joryio-applied=\"c1:e1\" data-joryio-orig=\"{&quot;c1:e1&quot;:{&quot;text&quot;:1}}\">Hi &lt;all&gt;<template data-joryio-orig=\"c1:e1\">Welcome <em>back</em></template></h1><img class=\"hero\" src=\"https://cdn.example/b.png\"  data-joryio-applied=\"c1:e2\" data-joryio-orig=\"{&quot;c1:e2&quot;:{&quot;src&quot;:&quot;https://cdn.example/a.png&quot;,&quot;srcset&quot;:&quot;https://cdn.example/a2.png 2x&quot;}}\"><a class=\"cta\" href=\"https://shop.example/new\" data-joryio-applied=\"c1:e3\" data-joryio-orig=\"{&quot;c1:e3&quot;:{&quot;href&quot;:&quot;/sale&quot;}}\">Shop</a></section><div data-joryio-placement=\"home_hero\" data-joryio-edit=\"e5\" data-joryio-server-spot=\"c1:e5\"></div>\n<div class=\"promo\" style=\"color:red;display:none !important\" data-joryio-applied=\"c1:e4\" data-joryio-orig=\"{&quot;c1:e4&quot;:{&quot;style&quot;:&quot;color:red&quot;}}\">Promo</div>\n</body>\n</html>\n";
const SERVER_EDITS = [
  { id: 'e1', selector: '#hero h1', operation: 'replace_text', value: 'Hi <all>' },
  { id: 'e2', selector: 'img.hero', operation: 'replace_image', value: 'https://cdn.example/b.png' },
  { id: 'e3', selector: 'a.cta', operation: 'replace_link', value: 'https://shop.example/new' },
  { id: 'e4', selector: '.promo', operation: 'hide' },
  { id: 'e5', selector: '#hero', operation: 'insert_placement', placementKey: 'home_hero', position: 'after' },
];
function serverPage() {
  document.open();
  document.write(SERVER_PAGE);
  document.close();
}
const spots = () => document.querySelectorAll('[data-joryio-placement="home_hero"]').length;
const original = () => ({
  h1: document.querySelector('#hero h1')!.innerHTML,
  src: document.querySelector('img.hero')!.getAttribute('src'),
  srcset: document.querySelector('img.hero')!.getAttribute('srcset'),
  href: document.querySelector('a.cta')!.getAttribute('href'),
  style: document.querySelector('.promo')!.getAttribute('style'),
  spots: spots(),
  markers: document.querySelectorAll('[data-joryio-applied], [data-joryio-orig]:not(template)').length,
});

describe('edits the server already applied (D450)', () => {
  it('pins the marker wire values (the backend and the three plugins pin the same)', () => {
    expect([SERVER_PAGE_EDITS_MARKER_ID, SERVER_APPLIED_ATTR, SERVER_ORIG_ATTR, SERVER_SPOT_ATTR]).toEqual([
      'joryio-server-page-edits',
      'data-joryio-applied',
      'data-joryio-orig',
      'data-joryio-server-spot',
    ]);
  });

  it('the same edits in the answer: nothing applied again, no second placeholder, exposure reported once', async () => {
    serverPage();
    answer = () => ({ body: { success: true, experiences: [experience(SERVER_EDITS)] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(m.serverAppliedCount()).toBe(5);
    expect(m.appliedCount()).toBe(0);
    expect(spots()).toBe(1);
    expect(document.querySelector('#hero h1')!.textContent).toBe('Hi <all>');
    expect(document.querySelector('#hero h1 template')).not.toBeNull();
    expect(tracks()).toEqual([expect.objectContaining({ action: 'displayed', deliveryToken: 'tok.1', campaignId: 'c1', variantId: 'A' })]);
    m.destroy();
    // The server's edits are the page's own content: destroy leaves them.
    expect(document.querySelector('#hero h1')!.textContent).toBe('Hi <all>');
  });

  it('the answer no longer carries them (paused, or this visitor is suppressed): every one is undone', async () => {
    serverPage();
    answer = () => ({ body: { success: true, experiences: [] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(original()).toEqual({
      h1: 'Welcome <em>back</em>',
      src: 'https://cdn.example/a.png',
      srcset: 'https://cdn.example/a2.png 2x',
      href: '/sale',
      style: 'color:red',
      spots: 0,
      markers: 0,
    });
    expect(m.serverAppliedCount()).toBe(0);
    expect(tracks()).toEqual([]);
    m.destroy();
  });

  it('an edit changed since the page was cached: that one is undone and applied as the answer says, the rest kept', async () => {
    serverPage();
    const edited = SERVER_EDITS.map((e) => (e.id === 'e1' ? { ...e, value: 'Hello' } : e));
    answer = () => ({ body: { success: true, experiences: [experience(edited)] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('#hero h1')!.textContent).toBe('Hello');
    expect(m.serverAppliedCount()).toBe(4);
    expect(m.appliedCount()).toBe(1);
    expect(spots()).toBe(1);
    expect(document.querySelector('a.cta')!.getAttribute('href')).toBe('https://shop.example/new');
    expect(tracks()).toHaveLength(1);
    m.destroy();
    // destroy undoes the SDK's own edit back to the page as the visitor got it
    expect(document.querySelector('#hero h1')!.innerHTML).toBe('Welcome <em>back</em>');
  });

  it('"Instead of it" written by the server: kept when the answer carries it, undone (element shown, spot removed) when not', async () => {
    const REPLACE_EDIT = { id: 'e6', selector: '.promo', operation: 'insert_placement', placementKey: 'home_hero', position: 'replace' };
    // The plugins' shared core's real output for this edit (Joryio_Server_Page_Edits::apply, php 8.2).
    const page = () => {
      document.open();
      document.write("<!DOCTYPE html>\n<html><head><script type=\"application/json\" id=\"joryio-server-page-edits\">{\"v\":1,\"experiences\":[{\"id\":\"c1\",\"variantId\":\"A\",\"edits\":[{\"id\":\"e6\",\"selector\":\".promo\",\"operation\":\"insert_placement\",\"placementKey\":\"home_hero\",\"position\":\"replace\"}]}]}</script><title>Shop</title></head>\n<body>\n<div class=\"promo\" style=\"color:red;display:none !important\" data-joryio-applied=\"c1:e6\" data-joryio-orig=\"{&quot;c1:e6&quot;:{&quot;spot&quot;:&quot;replace&quot;,&quot;style&quot;:&quot;color:red&quot;}}\">Promo</div><div data-joryio-placement=\"home_hero\" data-joryio-edit=\"e6\" data-joryio-server-spot=\"c1:e6\"></div>\n</body>\n</html>\n");
      document.close();
    };
    page();
    answer = () => ({ body: { success: true, experiences: [experience([REPLACE_EDIT])] } });
    let m = make();
    m.start();
    await flush();
    await flush();
    expect(m.serverAppliedCount()).toBe(1);
    expect(m.appliedCount()).toBe(0);
    expect(spots()).toBe(1);
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('none');
    m.destroy();

    page();
    answer = () => ({ body: { success: true, experiences: [] } });
    m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('.promo')!.getAttribute('style')).toBe('color:red');
    expect(spots()).toBe(0);
    expect(document.querySelectorAll('[data-joryio-applied]').length).toBe(0);
    m.destroy();
  });

  it('a control visitor (another variant than the cached page): undone, control_viewed reported', async () => {
    serverPage();
    answer = () => ({ body: { success: true, experiences: [experience([], { isControl: true, deliveryToken: null, deliveryId: null, controlToken: 'ctl.1', variantId: 'C', selectors: ['#hero h1'] })] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(original().h1).toBe('Welcome <em>back</em>');
    expect(spots()).toBe(0);
    expect(tracks()).toEqual([expect.objectContaining({ action: 'control_viewed', controlToken: 'ctl.1' })]);
    m.destroy();
  });

  it('page edits switched off for the site: undone; Joryio unreachable or failing: kept as sent', async () => {
    serverPage();
    site = { body: { success: true, ttlSeconds: 60, pageEdits: { enabled: false, active: false, antiFlickerSelectors: [] } } };
    let m = make();
    m.start();
    await flush();
    await flush();
    expect(original().spots).toBe(0);
    expect(calls.some((c) => c.path.endsWith('/page-edits'))).toBe(false);
    m.destroy();

    serverPage();
    // A new session: the "off" answer stored above is not used (it would be, for 10 minutes, in the same one).
    sessionId = 's-2';
    site = null;
    answer = () => ({ status: 500, body: { success: false } });
    m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('#hero h1')!.textContent).toBe('Hi <all>');
    expect(spots()).toBe(1);
    expect(m.appliedCount()).toBe(0);
    m.destroy();
  });

  it('anti-flicker never holds back an element the server already edited', async () => {
    serverPage();
    localStorage.setItem(KEYS.selectors, JSON.stringify({ 'https://shop.example/products/shoes': ['#hero h1', '.promo'] }));
    answer = () => ({ delayMs: 50, body: { success: true, experiences: [experience(SERVER_EDITS)] } });
    const m = make();
    m.start();
    const rule = document.getElementById('joryio-page-edits-anti-flicker')!.textContent!;
    expect(rule).toBe(':is(#hero h1,.promo):not([data-joryio-applied]){opacity:0 !important}');
    m.destroy();
  });

  it('a route change to another page undoes them', async () => {
    serverPage();
    const { PageContextTracker } = await import('./page-context');
    answer = (body) => ({ body: { success: true, experiences: body.context.url.endsWith('/cart') ? [] : [experience(SERVER_EDITS)] } });
    const tracker = new PageContextTracker();
    tracker.start();
    const m = make();
    m.setPageContext(tracker);
    m.start();
    await flush();
    await flush();
    expect(spots()).toBe(1);
    history.pushState(null, '', '/cart');
    expect(spots()).toBe(0);
    expect(document.querySelector('#hero h1')!.innerHTML).toBe('Welcome <em>back</em>');
    m.destroy();
    tracker.destroy();
    history.replaceState(null, '', '/products/shoes?utm=x');
  });

  it('a marker it cannot read is treated as none (nothing undone or re-applied blindly)', async () => {
    serverPage();
    document.getElementById('joryio-server-page-edits')!.textContent = '{not json';
    answer = () => ({ body: { success: true, experiences: [] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(m.serverAppliedCount()).toBe(0);
    expect(spots()).toBe(1);
    m.destroy();
  });

  it('a planted marker outside <head> (user content, DOM clobbering) is ignored: nothing undone, nothing written', async () => {
    document.open();
    document.write('<!DOCTYPE html><html><head><title>x</title></head><body>' +
      '<div id="joryio-server-page-edits">{"v":1,"experiences":[{"id":"c9","variantId":null,"edits":[{"id":"e1","selector":"a.x","operation":"replace_link","value":"https://shop.example/a"}]}]}</div>' +
      '<script type="application/json" id="joryio-server-page-edits">{"v":1,"experiences":[{"id":"c9","variantId":null,"edits":[{"id":"e1","selector":"a.x","operation":"replace_link","value":"https://shop.example/a"}]}]}</script>' +
      '<a class="x" href="https://shop.example/a" data-joryio-applied="c9:e1" data-joryio-orig=\'{"c9:e1":{"href":"javascript:alert(1)"}}\'>x</a></body></html>');
    document.close();
    answer = () => ({ body: { success: true, experiences: [] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(m.serverAppliedCount()).toBe(0);
    expect(document.querySelector('a.x')!.getAttribute('href')).toBe('https://shop.example/a');
    m.destroy();
  });

  it('a marker in <head> with a script URL, a CSS string or a changed element: nothing unsafe is written', async () => {
    document.open();
    document.write('<!DOCTYPE html><html><head><script type="application/json" id="joryio-server-page-edits">' +
      '{"v":1,"experiences":[{"id":"c9","variantId":null,"edits":[' +
      '{"id":"e1","selector":"a.x","operation":"replace_link","value":"https://shop.example/a"},' +
      '{"id":"e2","selector":"img.y","operation":"replace_image","value":"https://cdn.example/b.png"},' +
      '{"id":"e3","selector":".z","operation":"hide"},' +
      '{"id":"e4","selector":"a.w","operation":"replace_link","value":"https://shop.example/w"}]}]}</script></head><body>' +
      '<a class="x" href="https://shop.example/a" data-joryio-applied="c9:e1" data-joryio-orig=\'{"c9:e1":{"href":"javascript:alert(1)"}}\'>x</a>' +
      '<img class="y" src="https://cdn.example/b.png" data-joryio-applied="c9:e2" data-joryio-orig=\'{"c9:e2":{"src":"data:text/html,x","srcset":"javascript:x 2x"}}\'>' +
      '<div class="z" style="display:none !important" data-joryio-applied="c9:e3" data-joryio-orig=\'{"c9:e3":{"style":"background:url(https://evil.example/x)"}}\'>z</div>' +
      '<a class="w" href="https://elsewhere.example/" data-joryio-applied="c9:e4" data-joryio-orig=\'{"c9:e4":{"href":"/ok"}}\'>w</a>' +
      '</body></html>');
    document.close();
    answer = () => ({ body: { success: true, experiences: [] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    expect(document.querySelector('a.x')!.hasAttribute('href')).toBe(false);
    expect(document.querySelector('img.y')!.hasAttribute('src')).toBe(false);
    expect(document.querySelector('img.y')!.hasAttribute('srcset')).toBe(false);
    const z = document.querySelector('.z')!;
    expect(z.getAttribute('style') || '').not.toContain('evil');
    expect((z as HTMLElement).style.display).toBe('');
    // Not what the server applied any more: left alone.
    expect(document.querySelector('a.w')!.getAttribute('href')).toBe('https://elsewhere.example/');
    m.destroy();
  });

  it('a replaced text comes back through an allowlist: nothing executable is ever made live', async () => {
    const payloads = [
      '<script>window.__x=1</script>',
      '<iframe srcdoc="<script>parent.__x=1</script>"></iframe>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="javascript:alert(1)">',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<base href="https://evil.example/">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<style>body{background:url(https://evil.example/x)}</style>',
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>t</text></a></svg>',
      '<math><mtext>m</mtext></math>',
      '<form action="https://evil.example/"><button>go</button></form>',
      '<img src="x" onerror="window.__x=1" style="position:fixed">',
      '<a href="javascript:alert(1)" style="color:red" data-x="1">link</a>',
    ];
    const tpl = 'Kept <em class="k">sale</em> ' + payloads.join('');
    document.open();
    document.write('<!DOCTYPE html><html><head><script type="application/json" id="joryio-server-page-edits">' +
      '{"v":1,"experiences":[{"id":"c9","variantId":null,"edits":[{"id":"e1","selector":"h1","operation":"replace_text","value":"New"}]}]}</script></head><body>' +
      '<h1 data-joryio-applied="c9:e1" data-joryio-orig=\'{"c9:e1":{"text":1}}\'>New<template data-joryio-orig="c9:e1">' + tpl + '</template></h1></body></html>');
    document.close();
    answer = () => ({ body: { success: true, experiences: [] } });
    const m = make();
    m.start();
    await flush();
    await flush();
    const h1 = document.querySelector('h1')!;
    expect(h1.querySelector('em.k')!.textContent).toBe('sale');
    expect(h1.querySelectorAll('script, iframe, object, embed, meta, base, link, style, svg, math, form, button, animate, template').length).toBe(0);
    for (const e of Array.from(h1.querySelectorAll('*'))) {
      for (const a of Array.from(e.attributes)) {
        expect(/^on|^style$|^srcdoc$|^data/i.test(a.name)).toBe(false);
        if (a.name === 'href' || a.name === 'src') expect(a.value).not.toMatch(/^\s*javascript:/i);
      }
    }
    expect(h1.querySelector('a')!.hasAttribute('href')).toBe(false);
    expect((window as any).__x).toBeUndefined();
    m.destroy();
  });
});

