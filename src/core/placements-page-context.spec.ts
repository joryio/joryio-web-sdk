import { PlacementManager, PLACEMENT_BATCH_WINDOW_MS } from './placements';
import { installFetch, RecordedRequest } from './test-harness';
import type { PageContext, PageSignal } from './page-context';

/**
 * Placements and page context (D444 Phase 4): the request names the page, and
 * a `pageScoped` answer is good for its page only - a route change drops it
 * and asks again at once, even inside the 30 s refresh limit.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1' } as any;
const session = { getSessionId: () => 's-1' } as any;

class FakePage {
  ctx: PageContext = { url: 'https://shop.example/sale', pageVariables: { pageType: 'sale' }, dataLayer: {} };
  cbs = new Set<(s: PageSignal) => void>();
  current() {
    return this.ctx;
  }
  progress() {
    return { scrollPercent: 0, seconds: 0, exitIntent: false };
  }
  onSignal(cb: (s: PageSignal) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  go(path: string) {
    this.ctx = { ...this.ctx, url: `https://shop.example${path}` };
    this.cbs.forEach((cb) => cb({ type: 'page_change', url: this.ctx.url }));
  }
}

let calls: RecordedRequest[];
let scoped = true;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  scoped = true;
  calls = installFetch((req) => ({
    status: 200,
    body: {
      success: true,
      placements: {
        home_hero: {
          placementKey: 'home_hero',
          items: [{ id: `for ${req.body.context.url}`, kind: 'data', data: { headline: 'x' } }],
          ...(scoped ? { pageScoped: true } : {}),
        },
      },
    },
  }));
});
afterEach(() => jest.useRealTimers());

function make(page: FakePage) {
  const m = new PlacementManager('https://api.example/api', 'jry_sdk_web_test', identity, session, logger, { consent: () => 'granted', allowHtml: () => false });
  m.setPageContext(page as any);
  return m;
}
const get = async (m: PlacementManager) => {
  const p = m.getPlacements(['home_hero']);
  await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
  return p;
};

describe('placements and page context', () => {
  it('the request carries the page and page_context', async () => {
    const m = make(new FakePage());
    await get(m);
    expect(calls[0].body.context).toEqual({ url: 'https://shop.example/sale', pageVariables: { pageType: 'sale' }, dataLayer: {}, screen: null });
    expect(calls[0].body.capabilities).toContain('page_context');
    m.destroy();
  });

  it('a page-scoped answer is asked again on another page at once, and cached on its own page', async () => {
    const page = new FakePage();
    const m = make(page);
    expect((await get(m)).home_hero.items[0].id).toBe('for https://shop.example/sale');
    await get(m);
    expect(calls).toHaveLength(1); // same page: cached
    page.go('/cart');
    expect((await get(m)).home_hero.items[0].id).toBe('for https://shop.example/cart');
    expect(calls).toHaveLength(2); // inside the 30 s window, still asked: a new page
    m.destroy();
  });

  it('an answer that is not page-scoped stays cached across pages', async () => {
    scoped = false;
    const page = new FakePage();
    const m = make(page);
    await get(m);
    page.go('/cart');
    expect((await get(m)).home_hero.items[0].id).toBe('for https://shop.example/sale');
    expect(calls).toHaveLength(1);
    m.destroy();
  });
});
