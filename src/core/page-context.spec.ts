/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?utm_source=mail#reviews"}
 */
import {
  PageContextTracker,
  currentPageUrl,
  pageTargetingMatches,
  pageTriggerMet,
  pathPatternMatches,
  PAGE_TRIGGER_TYPES,
  PAGE_URL_OPERATORS,
  PAGE_VARIABLE_OPERATORS,
  PAGE_VARIABLE_SOURCES,
  PAGE_CONTEXT_CAPABILITY,
  PAGE_UTM_KEYS,
  TOUCH_EXIT_INTENT,
} from './page-context';

/** Page context on web (D444 Phase 4, docs/PLACEMENTS_WEBSITE_LAYER.md 1), in a real DOM (jsdom). */
describe('page context', () => {
  let tracker: PageContextTracker;
  afterEach(() => {
    tracker?.destroy();
    (window as any).dataLayer = undefined;
    (window as any).shop = undefined;
    history.replaceState(null, '', '/products/shoes?utm_source=mail#reviews');
  });

  it('pins the wire values (the backend pins the same list)', () => {
    expect(PAGE_URL_OPERATORS).toEqual(['equals', 'contains', 'matches']);
    expect(PAGE_VARIABLE_SOURCES).toEqual(['page', 'data_layer', 'utm_session', 'utm_first_touch']);
    expect(PAGE_UTM_KEYS).toEqual(['source', 'medium', 'campaign', 'term', 'content']);
    expect(PAGE_VARIABLE_OPERATORS).toEqual(['equals', 'not_equals', 'contains', 'exists', 'not_exists', 'gt', 'lt']);
    expect(PAGE_TRIGGER_TYPES).toEqual(['page_view', 'exit_intent', 'scroll_depth', 'time_on_page']);
    expect(PAGE_CONTEXT_CAPABILITY).toBe('page_context');
  });

  it('the URL is origin + path, never the query string or the fragment', () => {
    expect(currentPageUrl()).toBe('https://shop.example/products/shoes');
    tracker = new PageContextTracker();
    expect(tracker.current().url).toBe('https://shop.example/products/shoes');
  });

  it('reads only the allow-listed globals and dataLayer keys, latest push wins', () => {
    (window as any).shop = { page: { type: 'product' }, secretToken: 'x' };
    (window as any).dataLayer = [{ pageType: 'home', email: 'a@b.c' }, { event: 'x' }, { pageType: 'product', ecommerce: { value: 120 } }];
    tracker = new PageContextTracker({ pageVariables: ['shop.page.type'], dataLayerVariables: ['pageType', 'ecommerce.value'] });
    tracker.setPageVariables({ category: 'shoes', nested: { a: 1 } as any, 'bad key': 1 });
    const c = tracker.current();
    expect(c.pageVariables).toEqual({ category: 'shoes', 'shop.page.type': 'product' });
    expect(c.dataLayer).toEqual({ pageType: 'product', 'ecommerce.value': 120 });
    expect(JSON.stringify(c)).not.toMatch(/secretToken|a@b\.c/);
  });

  it('a single-page-app route change is a page change; the query string alone is not', () => {
    tracker = new PageContextTracker();
    tracker.start();
    const seen: any[] = [];
    tracker.onSignal((s) => s.type === 'page_change' && seen.push(s.url));
    history.pushState(null, '', '/products/shoes?color=red');
    history.pushState(null, '', '/cart');
    history.replaceState(null, '', '/checkout/pay');
    expect(seen).toEqual(['https://shop.example/cart', 'https://shop.example/checkout/pay']);
  });

  it('destroy restores history.pushState', () => {
    const original = history.pushState;
    tracker = new PageContextTracker();
    tracker.start();
    expect(history.pushState).not.toBe(original);
    tracker.destroy();
    expect(history.pushState).toBe(original);
  });

  it('exit intent: the pointer leaving through the top, once per page', () => {
    tracker = new PageContextTracker();
    tracker.start();
    const seen: string[] = [];
    tracker.onSignal((s) => seen.push(s.type));
    const leave = (clientY: number) => document.dispatchEvent(new MouseEvent('mouseout', { clientY, relatedTarget: null }));
    leave(300);
    leave(-2);
    leave(-2);
    expect(seen.filter((t) => t === 'exit_intent')).toHaveLength(1);
    history.pushState(null, '', '/next');
    leave(0);
    expect(seen.filter((t) => t === 'exit_intent')).toHaveLength(2);
  });

  describe('exit intent on a touch device: a fast scroll up after reading down', () => {
    const C = TOUCH_EXIT_INTENT;
    let now = 1_000_000;
    let touch = true;
    const queries: string[] = [];
    beforeEach(() => {
      now = 1_000_000;
      touch = true;
      queries.length = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      (window as any).matchMedia = (q: string) => {
        queries.push(q);
        return {
          media: q,
          get matches() {
            return touch;
          },
        };
      };
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 5000 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      (window as any).scrollY = 0;
    });
    afterEach(() => {
      jest.restoreAllMocks();
      delete (window as any).matchMedia;
      (window as any).scrollY = 0;
    });
    /** Scroll to y after `ms` milliseconds. */
    const scrollTo = (y: number, ms = 100) => {
      now += ms;
      (window as any).scrollY = y;
      window.dispatchEvent(new Event('scroll'));
    };
    const exits = (seen: string[]) => seen.filter((t) => t === 'exit_intent').length;
    const started = () => {
      tracker = new PageContextTracker();
      tracker.start();
      const seen: string[] = [];
      tracker.onSignal((s) => seen.push(s.type));
      return seen;
    };

    it('pins the thresholds', () => {
      expect(C).toEqual({ armPercent: 25, armPx: 400, upPx: 120, windowMs: 300, minMs: 3000, sampleMs: 50 });
    });

    it('asks for a primary input without hover that is coarse', () => {
      started();
      expect(queries).toEqual(['(hover: none) and (pointer: coarse)']);
    });

    it('fires on a fast scroll up after scrolling down, once per page view', () => {
      const seen = started();
      now += 5000;
      scrollTo(600);
      scrollTo(1200);
      scrollTo(1150, 100);
      expect(exits(seen)).toBe(0); // 50 px up: still reading
      scrollTo(1000, 100); // 200 px up within 200 ms
      expect(exits(seen)).toBe(1);
      expect(tracker.progress().exitIntent).toBe(true);
      scrollTo(2000, 400);
      scrollTo(1500, 100);
      expect(exits(seen)).toBe(1);
      // A route change is a new page view: armed again from scratch.
      history.pushState(null, '', '/next');
      expect(tracker.progress().exitIntent).toBe(false);
      now += 5000;
      scrollTo(1200);
      scrollTo(900, 100);
      expect(exits(seen)).toBe(2);
    });

    it('does not fire on a slow scroll up', () => {
      const seen = started();
      now += 5000;
      scrollTo(1500);
      for (let y = 1450; y >= 500; y -= 50) scrollTo(y, 200); // 50 px per 200 ms
      expect(exits(seen)).toBe(0);
    });

    it('does not fire on a fast scroll up near the top of the page', () => {
      const seen = started();
      now += 5000;
      scrollTo(350); // under 400 px and under 25% of the page
      scrollTo(100, 100);
      expect(exits(seen)).toBe(0);
    });

    it('arms at 25% of a short page even under 400 px', () => {
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1400 });
      const seen = started();
      now += 5000;
      scrollTo(300); // 50% of 600 px scrollable
      scrollTo(150, 100);
      expect(exits(seen)).toBe(1);
    });

    it('does not fire in the first seconds after the page view starts', () => {
      const seen = started();
      scrollTo(1500, 500);
      scrollTo(1000, 100); // 600 ms after start
      expect(exits(seen)).toBe(0);
      now += C.minMs;
      scrollTo(1500, 100);
      scrollTo(1000, 100);
      expect(exits(seen)).toBe(1);
    });

    it('desktop (a fine pointer with hover): a fast scroll up is not exit intent, the pointer rule is unchanged', () => {
      touch = false;
      const seen = started();
      now += 5000;
      scrollTo(1500);
      scrollTo(1000, 100);
      expect(exits(seen)).toBe(0);
      document.dispatchEvent(new MouseEvent('mouseout', { clientY: -1, relatedTarget: null }));
      expect(exits(seen)).toBe(1);
    });

    it('a browser without matchMedia keeps the desktop rule only', () => {
      delete (window as any).matchMedia;
      const seen = started();
      now += 5000;
      scrollTo(1500);
      scrollTo(1000, 100);
      expect(exits(seen)).toBe(0);
    });

    it('destroy removes the scroll listener', () => {
      const add = jest.spyOn(window, 'addEventListener');
      const remove = jest.spyOn(window, 'removeEventListener');
      const seen = started();
      const scrollFns = add.mock.calls.filter((c) => c[0] === 'scroll').map((c) => c[1]);
      expect(scrollFns).toHaveLength(1);
      expect(add.mock.calls.find((c) => c[0] === 'scroll')?.[2]).toEqual({ passive: true });
      tracker.destroy();
      expect(remove.mock.calls.some((c) => c[0] === 'scroll' && c[1] === scrollFns[0])).toBe(true);
      now += 5000;
      scrollTo(1500);
      scrollTo(1000, 100);
      expect(exits(seen)).toBe(0);
    });
  });

  it('scroll depth is the maximum percent reached, reset by a route change', () => {
    tracker = new PageContextTracker();
    tracker.start();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    (window as any).scrollY = 1000;
    window.dispatchEvent(new Event('scroll'));
    expect(tracker.progress().scrollPercent).toBe(50);
    (window as any).scrollY = 200;
    window.dispatchEvent(new Event('scroll'));
    expect(tracker.progress().scrollPercent).toBe(50);
    history.pushState(null, '', '/other');
    expect(tracker.progress().scrollPercent).toBe(0);
  });

  it('time on page counts visible time only', () => {
    jest.useFakeTimers();
    try {
      tracker = new PageContextTracker();
      tracker.start();
      jest.advanceTimersByTime(3000);
      expect(tracker.progress().seconds).toBe(3);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(5000);
      expect(tracker.progress().seconds).toBe(3);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(2000);
      expect(tracker.progress().seconds).toBe(5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pageTriggerMet per trigger type', () => {
    const p = { scrollPercent: 60, seconds: 31 };
    expect(pageTriggerMet({ type: 'page_view' }, { type: 'page_change', url: null }, p)).toBe(true);
    expect(pageTriggerMet({ type: 'scroll_depth', value: 50 }, { type: 'scroll_depth', percent: 60 }, p)).toBe(true);
    expect(pageTriggerMet({ type: 'scroll_depth', value: 75 }, { type: 'scroll_depth', percent: 60 }, p)).toBe(false);
    expect(pageTriggerMet({ type: 'time_on_page', value: 30 }, { type: 'time_on_page', seconds: 31 }, p)).toBe(true);
    expect(pageTriggerMet({ type: 'exit_intent' }, { type: 'exit_intent' }, p)).toBe(true);
    expect(pageTriggerMet({ type: 'event' }, { type: 'exit_intent' }, p)).toBe(false);
  });

  it('the matcher agrees with the backend on the shared cases', () => {
    expect(pathPatternMatches('/products/*', '/products/shoes')).toBe(true);
    expect(pathPatternMatches('/products/*', '/products/shoes/red')).toBe(false);
    expect(pathPatternMatches('/**/checkout', '/en/store/checkout')).toBe(true);
    const ctx = { url: 'https://s.example/products/a', pageVariables: { pageType: 'product' }, dataLayer: { 'ecommerce.value': 80 } };
    const pt = {
      urls: { include: [{ op: 'matches', value: '/products/**' }], exclude: [{ op: 'contains', value: 'gift' }] },
      variables: [
        { source: 'page', key: 'pageType', op: 'equals', value: 'Product' },
        { source: 'data_layer', key: 'ecommerce.value', op: 'gt', value: 50 },
      ],
    };
    expect(pageTargetingMatches(pt, ctx)).toBe(true);
    expect(pageTargetingMatches(pt, { ...ctx, url: null })).toBe(false);
    expect(pageTargetingMatches({ urls: { include: [{ op: 'regex', value: '.*' }] } }, ctx)).toBe(false);
    expect(pageTargetingMatches(undefined, { ...ctx, url: null })).toBe(true);
  });

  describe('UTM (follow-up 2026-11-21)', () => {
    it('reports the recorded session and first-touch UTM as five fields, never the query string', () => {
      tracker = new PageContextTracker();
      tracker.setUtmSource(() => ({
        current: { utm_source: 'mail', utm_medium: 'email', referrer: 'https://x.example', landing_page: 'https://shop.example/?utm_source=mail' },
        firstTouch: { utm_source: 'google', utm_campaign: 'brand' },
      }));
      const ctx = tracker.current();
      expect(ctx.url).toBe('https://shop.example/products/shoes');
      expect(ctx.utm).toEqual({ session: { source: 'mail', medium: 'email' }, firstTouch: { source: 'google', campaign: 'brand' } });
      expect(JSON.stringify(ctx)).not.toContain('?');
    });

    it('no UTM (or capture off) = no utm key', () => {
      tracker = new PageContextTracker();
      expect(tracker.current().utm).toBeUndefined();
      tracker.setUtmSource(() => null);
      expect(tracker.current().utm).toBeUndefined();
    });

    it('matches like the server: session and first touch apart, an unknown source never', () => {
      const ctx = { url: 'https://shop.example/a', pageVariables: {}, dataLayer: {}, utm: { session: { source: 'Mail' }, firstTouch: { source: 'google' } } };
      const rule = (source: string, key: string, op: string, value?: any) => ({ variables: [{ source, key, op, value }] });
      expect(pageTargetingMatches(rule('utm_session', 'source', 'equals', 'mail'), ctx)).toBe(true);
      expect(pageTargetingMatches(rule('utm_first_touch', 'source', 'equals', 'mail'), ctx)).toBe(false);
      expect(pageTargetingMatches(rule('utm_session', 'campaign', 'not_exists'), ctx)).toBe(true);
      expect(pageTargetingMatches(rule('utm_session', 'source', 'equals', 'mail'), { ...ctx, utm: undefined })).toBe(false);
      expect(pageTargetingMatches(rule('cookies', 'source', 'exists'), ctx)).toBe(false);
    });
  });
});
