/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes"}
 */
import { parseShowWhen, ShowWhenMoments, SHOW_WHEN_KINDS } from './show-when';
import { PageContextTracker, type PageContext, type PageSignal } from './page-context';
import { PlacementManager, PLACEMENT_BATCH_WINDOW_MS } from './placements';
import { PageEditManager, pageEditsStorageKeys } from './page-edits';
import { IN_APP_DISPLAY_DWELL_MS } from './inapp';
import * as entry from '../index';

/**
 * Show when (BACKLOG D465): placement items and page edits held until their
 * moment in the page view - visible seconds, scroll depth, exit intent, or an
 * event tracked in this visit - then revealed, and held again on a new page.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1' } as any;
let sessionId = 's-1';
const session = { getSessionId: () => sessionId } as any;

/** A page tracker whose progress the test sets; signals are sent by hand. */
class FakePage {
  ctx: PageContext = { url: 'https://shop.example/products/shoes', pageVariables: {}, dataLayer: {} };
  p = { scrollPercent: 0, seconds: 0, exitIntent: false };
  cbs = new Set<(s: PageSignal) => void>();
  current() {
    return this.ctx;
  }
  progress() {
    return this.p;
  }
  onSignal(cb: (s: PageSignal) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(s: PageSignal) {
    this.cbs.forEach((cb) => cb(s));
  }
  tick(seconds: number) {
    this.p = { ...this.p, seconds };
    this.emit({ type: 'time_on_page', seconds });
  }
  go(path: string) {
    this.ctx = { ...this.ctx, url: `https://shop.example${path}` };
    this.p = { scrollPercent: 0, seconds: 0, exitIntent: false };
    this.emit({ type: 'page_change', url: this.ctx.url });
  }
}

type Rec = { path: string; body: any };
let calls: Rec[];
let respond: (path: string, body: any) => any;
const tracks = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track')).map((c) => c.body);
const serves = () => calls.filter((c) => c.path.endsWith('/v1/in-app/placements'));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  sessionId = 's-1';
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = '<div id="spot"></div><h1 class="title">Welcome</h1><p class="promo">Promo</p>';
  calls = [];
  respond = () => ({ success: true });
  (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path.includes('/site-settings')) throw new Error('offline');
    const data = respond(path, body);
    return { ok: true, status: 200, json: async () => data };
  });
});
afterEach(() => jest.useRealTimers());

describe('show when: names and the normalizer', () => {
  it('pins the shared names and wire values, exported from the package', () => {
    expect(SHOW_WHEN_KINDS).toEqual(['load', 'seconds', 'scroll', 'exit', 'event']);
    expect(entry.SHOW_WHEN_KINDS).toBe(SHOW_WHEN_KINDS);
    // No capability: placements and page edits exist only in 1.4.0 betas (owner decision).
    expect((entry as any).SHOW_WHEN_CAPABILITY).toBeUndefined();
  });

  it('absent = load; an unknown kind or an invalid value is never shown (null), never "load"', () => {
    expect(parseShowWhen(undefined)).toEqual({ kind: 'load' });
    expect(parseShowWhen({ kind: 'seconds', seconds: 5, extra: 1 })).toEqual({ kind: 'seconds', seconds: 5 });
    expect(parseShowWhen({ kind: 'scroll', percent: 50 })).toEqual({ kind: 'scroll', percent: 50 });
    expect(parseShowWhen({ kind: 'exit' })).toEqual({ kind: 'exit' });
    expect(parseShowWhen({ kind: 'event', event: ' Added to cart ' })).toEqual({ kind: 'event', event: 'Added to cart' });
    for (const bad of [{ kind: 'hover' }, { kind: 'seconds', seconds: 0 }, { kind: 'seconds', seconds: 3601 }, { kind: 'seconds', seconds: 1.5 }, { kind: 'scroll', percent: 101 }, { kind: 'event', event: '' }, { kind: 'event', event: 'x'.repeat(256) }, 'load', 7]) {
      expect(parseShowWhen(bad)).toBeNull();
    }
  });
});

describe('show when: the moments (the page tracker clock)', () => {
  it('seconds count visible time only; a hidden tab pauses them; a route change restarts them', () => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const page = new PageContextTracker();
    const moments = new ShowWhenMoments(page, () => sessionId, 'jry_sdk');
    const changes = jest.fn();
    moments.onChange(changes);
    page.start();
    const sw = { kind: 'seconds' as const, seconds: 5 };
    jest.advanceTimersByTime(3000);
    expect(moments.met(sw)).toBe(false);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(60_000); // hidden: does not count
    expect(moments.met(sw)).toBe(false);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(2000);
    expect(moments.met(sw)).toBe(true);
    expect(changes).toHaveBeenCalled();
    history.pushState({}, '', '/cart');
    expect(moments.met(sw)).toBe(false);
    page.destroy();
    moments.destroy();
  });

  it('scroll depth and exit intent, like the scroll_depth and exit_intent triggers', () => {
    const page = new PageContextTracker();
    const moments = new ShowWhenMoments(page, () => sessionId, 'jry_sdk');
    page.start();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 400 });
    window.dispatchEvent(new Event('scroll'));
    expect(moments.met({ kind: 'scroll', percent: 50 })).toBe(false);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 600 });
    window.dispatchEvent(new Event('scroll'));
    expect(moments.met({ kind: 'scroll', percent: 50 })).toBe(true);
    expect(moments.met({ kind: 'exit' })).toBe(false);
    document.dispatchEvent(new MouseEvent('mouseout', { clientY: 0, relatedTarget: null }));
    expect(moments.met({ kind: 'exit' })).toBe(true);
    page.destroy();
    moments.destroy();
  });

  it('event: any event of this visit, kept across page loads of the session, empty for a new session', () => {
    const moments = new ShowWhenMoments(null, () => sessionId, 'jry_sdk');
    const sw = { kind: 'event' as const, event: 'Added to cart' };
    expect(moments.met(sw)).toBe(false);
    moments.noteEvent('Added to cart');
    expect(moments.met(sw)).toBe(true);
    // The next page load of the same session (a new instance) knows it.
    expect(new ShowWhenMoments(null, () => sessionId, 'jry_sdk').met(sw)).toBe(true);
    // Another workspace on the origin does not.
    expect(new ShowWhenMoments(null, () => sessionId, 'jry_other').met(sw)).toBe(false);
    sessionId = 's-2';
    expect(moments.met(sw)).toBe(false);
    expect(moments.met(null)).toBe(false);
    expect(moments.met({ kind: 'load' })).toBe(true);
  });
});

// ── placements ─────────────────────────────────────────────────────────────

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  deliveryToken: `tok-${id}`,
  kind: 'native',
  data: {},
  content: { kind: 'native', title: `Title ${id}` },
  ...extra,
});

function placements(page: FakePage, answer: () => any, opts: { moments?: boolean } = {}) {
  respond = (path) => (path.endsWith('/v1/in-app/placements') ? { success: true, placements: { home_hero: { placementKey: 'home_hero', ttlSeconds: 300, ...answer() } } } : { success: true });
  const m = new PlacementManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => 'granted', allowHtml: () => false });
  m.setPageContext(page as any);
  const moments = new ShowWhenMoments(page, () => sessionId, 'jry_sdk');
  if (opts.moments !== false) m.setShowWhen(moments);
  return { m, moments };
}
const get = async (m: PlacementManager) => {
  const p = m.getPlacements(['home_hero']);
  await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
  return (await p).home_hero;
};
const drawn = () => document.querySelector('#spot .joryio-placement-title')?.textContent ?? null;

describe('show when: placements', () => {
  it('sends no show_when capability', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [] }));
    await get(m);
    expect(serves()[0].body.capabilities).not.toContain('show_when');
    m.destroy();
  });

  it('holds a seconds item from the drawn spot AND the data API; at the moment re-draws and fires onPlacementsUpdated; impression only after', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'seconds', seconds: 5 } })] }));
    const updates: string[][] = [];
    m.onPlacementsUpdated((u) => updates.push(u.home_hero.items.map((i) => i.id)));
    m.insertPlacement('home_hero', document.getElementById('spot')!);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
    expect((await get(m)).items).toEqual([]);
    expect(drawn()).toBeNull();
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS * 2);
    expect(tracks()).toEqual([]); // held: no impression
    page.tick(4);
    expect(drawn()).toBeNull();
    page.tick(5);
    expect(drawn()).toBe('Title a');
    expect(updates.pop()).toEqual(['a']);
    expect((await get(m)).items.map((i) => i.id)).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS + 10);
    expect(tracks()).toEqual([expect.objectContaining({ action: 'displayed', campaignId: 'a', placementKey: 'home_hero' })]);
    // Revealed stays for the page view.
    page.tick(6);
    expect(drawn()).toBe('Title a');
    m.destroy();
  });

  it('a route change holds a revealed item again until the new page reaches its moment', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'scroll', percent: 50 } })] }));
    m.insertPlacement('home_hero', document.getElementById('spot')!);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
    page.p = { ...page.p, scrollPercent: 60 };
    page.emit({ type: 'scroll_depth', percent: 60 });
    expect(drawn()).toBe('Title a');
    page.go('/cart');
    expect(drawn()).toBeNull();
    page.p = { ...page.p, scrollPercent: 55 };
    page.emit({ type: 'scroll_depth', percent: 55 });
    expect(drawn()).toBe('Title a');
    m.destroy();
  });

  it('an unknown kind is never shown; exit intent reveals', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('x', { showWhen: { kind: 'hover' } }), item('b', { showWhen: { kind: 'exit' } })], maxItems: 2 }));
    m.insertPlacement('home_hero', document.getElementById('spot')!);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
    expect(drawn()).toBeNull();
    page.p = { ...page.p, exitIntent: true, seconds: 3600, scrollPercent: 100 };
    page.emit({ type: 'exit_intent' });
    expect((await get(m)).items.map((i) => i.id)).toEqual(['b']);
    m.destroy();
  });

  it('without the moments a held item is never shown (no moments wired)', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'seconds', seconds: 1 } }), item('b')] }), { moments: false });
    page.tick(100);
    expect((await get(m)).items.map((i) => i.id)).toEqual(['b']);
    m.destroy();
  });

  it('control answer: control_viewed only after the moment AND the spot is viewable; markDisplayed before is ignored', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ isControl: true, controlToken: 'ctl-1', items: [], showWhen: { kind: 'seconds', seconds: 10 } }));
    const updates: number[] = [];
    m.onPlacementsUpdated(() => updates.push(page.p.seconds));
    m.insertPlacement('home_hero', document.getElementById('spot')!);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS + IN_APP_DISPLAY_DWELL_MS * 2);
    const ctl = await get(m);
    ctl.markDisplayed();
    expect(tracks()).toEqual([]);
    page.tick(10);
    expect(updates).toContain(10); // the data API is told to call markDisplayed again
    expect(tracks()).toEqual([]); // the spot must be viewable after the moment (dwell)
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS + 10);
    expect(tracks()).toEqual([expect.objectContaining({ action: 'control_viewed', controlToken: 'ctl-1', placementKey: 'home_hero', anonymousId: 'anon-1', deviceType: 'web' })]);
    ctl.markDisplayed();
    expect(tracks()).toHaveLength(1);
    m.destroy();
  });

  it('deferredControls: once per token, after its own moment and once the spot was viewable in this page view', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({
      items: [item('a')],
      deferredControls: [
        { controlToken: 'dc-1', showWhen: { kind: 'seconds', seconds: 8 } },
        { controlToken: 'dc-bad', showWhen: { kind: 'hover' } },
      ],
    }));
    m.insertPlacement('home_hero', document.getElementById('spot')!);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS + IN_APP_DISPLAY_DWELL_MS + 10);
    expect(tracks().map((t) => t.action)).toEqual(['displayed']);
    page.tick(7);
    expect(tracks()).toHaveLength(1);
    page.tick(8);
    expect(tracks()[1]).toEqual(expect.objectContaining({ action: 'control_viewed', controlToken: 'dc-1', placementKey: 'home_hero', viewedAt: expect.any(String) }));
    page.tick(9);
    page.go('/other');
    page.tick(9);
    expect(tracks().filter((t) => t.action === 'control_viewed').map((t) => t.controlToken)).toEqual(['dc-1']);
    m.destroy();
  });

  it('deferredControls with kind load: reported as soon as the spot is viewable', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'seconds', seconds: 4 } })], deferredControls: [{ controlToken: 'dc-load', showWhen: { kind: 'load' } }] }));
    expect((await get(m)).items).toEqual([]);
    page.tick(4);
    const p = await get(m);
    expect(p.items.map((i) => i.id)).toEqual(['a']);
    p.items[0].markDisplayed();
    expect(tracks().map((t) => t.controlToken).filter(Boolean)).toEqual(['dc-load']);
    m.destroy();
  });

  it('an item with an explicit { kind: load } is shown at once', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'load' } })] }));
    expect((await get(m)).items.map((i) => i.id)).toEqual(['a']);
    m.destroy();
  });

  it('deferred control of a data-API placement: its moment, then any markDisplayed in this page view', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('a')], deferredControls: [{ controlToken: 'dc-2', showWhen: { kind: 'event', event: 'Signed up' } }] }));
    const p = await get(m);
    p.items[0].markDisplayed();
    expect(tracks().map((t) => t.action)).toEqual(['displayed']);
    const { moments } = { moments: (m as any).moments as ShowWhenMoments };
    moments.noteEvent('Signed up');
    expect(tracks().map((t) => t.controlToken).filter(Boolean)).toEqual(['dc-2']);
    m.destroy();
  });

  it('event kind: revealed locally when the event is tracked; recheckKeysFor names the key once per page view', async () => {
    const page = new FakePage();
    const { m, moments } = placements(page, () => ({ items: [item('a', { showWhen: { kind: 'event', event: 'Added to cart' } })], recheckOn: ['Viewed product'] }));
    expect((await get(m)).items).toEqual([]);
    expect(m.recheckKeysFor('Something else')).toEqual([]);
    expect(m.recheckKeysFor('Viewed product')).toEqual(['home_hero']);
    expect(m.recheckKeysFor('Viewed product')).toEqual([]);
    moments.noteEvent('Added to cart');
    expect(m.recheckKeysFor('Added to cart')).toEqual(['home_hero']);
    expect((await get(m)).items.map((i) => i.id)).toEqual(['a']);
    page.go('/next');
    expect(m.recheckKeysFor('Viewed product')).toEqual(['home_hero']);
    // The event of this visit is already there: shown on the new page at once.
    expect((await get(m)).items.map((i) => i.id)).toEqual(['a']);
    m.destroy();
  });

  it('recheck asks the server at once, inside the 30 s refresh limit', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [] }));
    await get(m);
    expect(serves()).toHaveLength(1);
    await m.refreshPlacements(['home_hero']); // inside the limit: deferred
    expect(serves()).toHaveLength(1);
    const ev = { name: 'Added to cart', eventId: 'evt-1', properties: { sku: 'a' } };
    const done = m.recheck(['home_hero'], ev);
    await jest.advanceTimersByTimeAsync(PLACEMENT_BATCH_WINDOW_MS);
    await done;
    expect(serves()).toHaveLength(2);
    expect(serves()[0].body.recheckEvent).toBeUndefined();
    // Only the re-check request carries the event.
    expect(serves()[1].body.recheckEvent).toEqual(ev);
    m.destroy();
  });

  it('legacy event triggers keep their event window, untouched', async () => {
    const page = new FakePage();
    const { m } = placements(page, () => ({ items: [item('t', { triggers: [{ type: 'event', event: 'Clicked' }], placementTriggerWindowSeconds: 60 })] }));
    expect((await get(m)).items).toEqual([]);
    m.onEventTracked('Clicked');
    expect((await get(m)).items.map((i) => i.id)).toEqual(['t']);
    m.destroy();
  });
});

// ── page edits ─────────────────────────────────────────────────────────────

const KEYS = pageEditsStorageKeys('jry_sdk');
const exp = (id: string, edits: any[], over: Record<string, unknown> = {}) => ({
  id, variantId: 'A', deliveryId: `d-${id}`, deliveryToken: `tok-${id}`, isControl: false, controlToken: null,
  selectors: edits.map((e) => e.selector), edits, ...over,
});

function pageEdits(page: FakePage, answer: () => any) {
  respond = (path) => (path.endsWith('/v1/in-app/page-edits') ? { success: true, ttlSeconds: 300, ...answer() } : { success: true });
  const m = new PageEditManager('https://api.example/api', 'jry_sdk', identity, session, logger, { consent: () => 'granted' });
  m.setPageContext(page as any);
  const moments = new ShowWhenMoments(page, () => sessionId, 'jry_sdk');
  m.setShowWhen(moments);
  return { m, moments };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await jest.advanceTimersByTimeAsync(0);
};
const editReqs = () => calls.filter((c) => c.path.endsWith('/v1/in-app/page-edits'));

describe('show when: page edits', () => {
  it('holds a seconds experience, keeps its selectors out of the anti-flicker memory, applies it at the moment', async () => {
    const page = new FakePage();
    const { m } = pageEdits(page, () => ({
      experiences: [
        exp('now', [{ id: 'e1', selector: 'h1.title', operation: 'replace_text', value: 'Hello' }]),
        exp('later', [{ id: 'e2', selector: '.promo', operation: 'replace_text', value: 'Late offer' }], { showWhen: { kind: 'seconds', seconds: 5 } }),
      ],
    }));
    m.start();
    await settle();
    expect(editReqs()[0].body.capabilities).not.toContain('show_when');
    expect(editReqs()[0].body.recheckEvent).toBeUndefined();
    expect(document.querySelector('h1.title')!.textContent).toBe('Hello');
    expect(document.querySelector('.promo')!.textContent).toBe('Promo');
    expect(tracks().map((t) => t.campaignId)).toEqual(['now']);
    const remembered = JSON.parse(localStorage.getItem(KEYS.selectors) || '{}');
    expect(remembered['https://shop.example/products/shoes']).toEqual(['h1.title']);
    page.tick(5);
    expect(document.querySelector('.promo')!.textContent).toBe('Late offer');
    expect(tracks().map((t) => t.campaignId)).toEqual(['now', 'later']);
    // A route change: the new page's answer, the moment restarts.
    page.go('/products/hats');
    await settle();
    expect(editReqs()).toHaveLength(2);
    expect(document.querySelector('.promo')!.textContent).toBe('Promo');
    page.tick(5);
    expect(document.querySelector('.promo')!.textContent).toBe('Late offer');
    m.destroy();
  });

  it('the anti-flicker rule never holds back a held experience remembered from the last answer', async () => {
    const page = new FakePage();
    const { m } = pageEdits(page, () => ({
      experiences: [exp('later', [{ id: 'e2', selector: '.promo', operation: 'hide' }], { showWhen: { kind: 'exit' } })],
    }));
    m.start();
    await settle();
    m.destroy();
    // The next view of the page: nothing remembered to hide, the cached held edit not applied.
    const again = pageEdits(page, () => ({ experiences: [] }));
    again.m.start();
    expect(document.getElementById('joryio-page-edits-anti-flicker')).toBeNull();
    expect((document.querySelector('.promo') as HTMLElement).style.display).toBe('');
    again.m.destroy();
  });

  it('an unknown kind is never applied', async () => {
    const page = new FakePage();
    const { m } = pageEdits(page, () => ({ experiences: [exp('x', [{ id: 'e', selector: '.promo', operation: 'hide' }], { showWhen: { kind: 'hover' } })] }));
    m.start();
    await settle();
    page.p = { scrollPercent: 100, seconds: 3600, exitIntent: true };
    page.emit({ type: 'exit_intent' });
    expect(m.appliedCount()).toBe(0);
    m.destroy();
  });

  it('control with showWhen: control_viewed at the moment, not before', async () => {
    const page = new FakePage();
    const { m } = pageEdits(page, () => ({
      experiences: [exp('c', [], { isControl: true, controlToken: 'ctl-e', selectors: ['.promo'], showWhen: { kind: 'scroll', percent: 30 } })],
    }));
    m.start();
    await settle();
    expect(tracks()).toEqual([]);
    page.p = { ...page.p, scrollPercent: 30 };
    page.emit({ type: 'scroll_depth', percent: 30 });
    expect(tracks()).toEqual([expect.objectContaining({ action: 'control_viewed', controlToken: 'ctl-e' })]);
    m.destroy();
  });

  it('recheckOn / an experience waiting on an event: claimRecheck once per page view, recheck asks again', async () => {
    const page = new FakePage();
    const { m, moments } = pageEdits(page, () => ({
      recheckOn: ['Added to cart'],
      experiences: [exp('ev', [{ id: 'e', selector: '.promo', operation: 'replace_text', value: 'Thanks' }], { showWhen: { kind: 'event', event: 'Signed up' } })],
    }));
    m.start();
    await settle();
    expect(m.claimRecheck('Other')).toBe(false);
    expect(m.claimRecheck('Added to cart')).toBe(true);
    expect(m.claimRecheck('Added to cart')).toBe(false);
    m.recheck({ name: 'Added to cart', eventId: 'evt-9', properties: {} });
    await settle();
    expect(editReqs()).toHaveLength(2);
    expect(editReqs()[1].body.recheckEvent).toEqual({ name: 'Added to cart', eventId: 'evt-9', properties: {} });
    expect(document.querySelector('.promo')!.textContent).toBe('Promo');
    moments.noteEvent('Signed up');
    expect(document.querySelector('.promo')!.textContent).toBe('Thanks');
    expect(m.claimRecheck('Signed up')).toBe(true);
    page.go('/x');
    await settle();
    expect(m.claimRecheck('Added to cart')).toBe(true);
    m.destroy();
  });

  it('a server-applied edit of an experience that now waits for a moment is undone, then applied at the moment', async () => {
    document.head.innerHTML = `<script type="application/json" id="joryio-server-page-edits">${JSON.stringify({
      v: 1,
      experiences: [{ id: 'srv', variantId: 'A', edits: [{ id: 'e', selector: 'h1.title', operation: 'replace_link', value: 'https://x.example/' }].map((e) => ({ ...e, selector: 'a.go' })) }],
    })}</script>`;
    document.body.innerHTML = '<a class="go" href="https://x.example/" data-joryio-applied="srv:e" data-joryio-orig=\'{"srv:e":{"href":"/orig"}}\'>Go</a>';
    const page = new FakePage();
    const { m } = pageEdits(page, () => ({
      experiences: [exp('srv', [{ id: 'e', selector: 'a.go', operation: 'replace_link', value: 'https://x.example/' }], { showWhen: { kind: 'seconds', seconds: 3 } })],
    }));
    m.start();
    await settle();
    expect(m.serverAppliedCount()).toBe(0);
    expect(document.querySelector('a.go')!.getAttribute('href')).toBe('/orig');
    page.tick(3);
    expect(document.querySelector('a.go')!.getAttribute('href')).toBe('https://x.example/');
    expect(tracks().map((t) => t.campaignId)).toEqual(['srv']);
    document.head.innerHTML = '';
    m.destroy();
  });
});
