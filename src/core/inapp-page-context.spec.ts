import { InAppMessagingManager } from './inapp';
import { installFetch, RecordedRequest } from './test-harness';
import type { PageContext, PageSignal } from './page-context';

/**
 * Overlays and page context (D444 Phase 4, docs/PLACEMENTS_WEBSITE_LAYER.md 1):
 * page rules are checked on the device before every display, page triggers
 * fire held campaigns once per page, a route change re-checks, and the SDK
 * says `page_context` so the server sends such campaigns at all.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = {
  getUserId: () => null,
  getAnonymousId: () => 'anon-1',
  getAttributes: () => ({}),
  getAttribute: () => undefined,
  pending: { pending: () => ({}) },
} as any;
const session = { getSessionId: () => 's-1', getSessionInfo: () => ({ sessionStart: 0 }) } as any;

class FakePage {
  ctx: PageContext = { url: 'https://shop.example/', pageVariables: {}, dataLayer: {} };
  prog = { scrollPercent: 0, seconds: 0, exitIntent: false };
  cbs = new Set<(s: PageSignal) => void>();
  current() {
    return this.ctx;
  }
  progress() {
    return this.prog;
  }
  onSignal(cb: (s: PageSignal) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(s: PageSignal) {
    this.cbs.forEach((cb) => cb(s));
  }
  go(path: string) {
    this.ctx = { ...this.ctx, url: `https://shop.example${path}` };
    this.prog = { scrollPercent: 0, seconds: 0, exitIntent: false };
    this.emit({ type: 'page_change', url: this.ctx.url });
  }
}

const CHECKOUT = { urls: { include: [{ op: 'matches', value: '/checkout/**' }] } };
const campaign = (id: string, extra: Record<string, unknown>) =>
  ({ id, name: id, type: 'modal', triggers: [{ type: 'immediate' }], content: { kind: 'native', title: 'Hi', body: 'B' }, ...extra }) as any;

let calls: RecordedRequest[];
function make(page: FakePage | null, campaigns: any[]) {
  (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
  const m = new InAppMessagingManager('https://api.example/api', 'jry_sdk_test', identity, session, logger, null, {}, undefined, null, {});
  if (page) m.setPageContext(page as any);
  for (const c of campaigns) (m as any).campaigns.set(c.id, c);
  // What reached the display pipeline: claimed synchronously, before any await.
  const shown: string[] = [];
  const original = m.displayCampaign.bind(m);
  m.displayCampaign = async (c: any) => {
    const p = original(c).catch(() => undefined);
    if ((m as any).claimed.has(c.id)) shown.push(c.id);
    (m as any).claimed.delete(c.id);
    return p;
  };
  return { m, shown };
}

beforeEach(() => {
  calls = installFetch(() => ({ status: 200, body: { success: true, campaigns: [], eligible: false } }));
});

describe('overlays and page context', () => {
  it('a page-targeted campaign shows only on a page its rules allow, and on arriving at one', async () => {
    const page = new FakePage();
    const { m, shown } = make(page, [campaign('checkout', { pageTargeting: CHECKOUT }), campaign('plain', {})]);
    (m as any).processImmediateTriggers();
    expect(shown).toEqual(['plain']);
    page.go('/checkout/pay');
    expect(shown).toEqual(['plain', 'checkout']);
    m.destroy();
  });

  it('without a page tracker a page-targeted campaign never shows (fail closed)', () => {
    const { m, shown } = make(null, [campaign('checkout', { pageTargeting: CHECKOUT })]);
    (m as any).processImmediateTriggers();
    expect(shown).toEqual([]);
  });

  it('page triggers fire once per page', () => {
    const page = new FakePage();
    const { m, shown } = make(page, [
      campaign('exit', { triggers: [{ type: 'exit_intent' }] }),
      campaign('scroll', { triggers: [{ type: 'scroll_depth', value: 50 }] }),
      campaign('time', { triggers: [{ type: 'time_on_page', value: 30 }] }),
      campaign('view', { triggers: [{ type: 'page_view' }], pageTargeting: { urls: { include: [{ op: 'equals', value: '/sale' }] } } }),
    ]);
    page.emit({ type: 'exit_intent' });
    page.emit({ type: 'exit_intent' });
    page.prog.scrollPercent = 40;
    page.emit({ type: 'scroll_depth', percent: 40 });
    page.prog.scrollPercent = 55;
    page.emit({ type: 'scroll_depth', percent: 55 });
    page.prog.seconds = 31;
    page.emit({ type: 'time_on_page', seconds: 31 });
    expect(shown).toEqual(['exit', 'scroll', 'time']);
    page.go('/sale');
    expect(shown).toEqual(['exit', 'scroll', 'time', 'view']);
    page.emit({ type: 'exit_intent' });
    expect(shown.filter((x) => x === 'exit')).toHaveLength(2);
    m.destroy();
  });

  it('sync declares page_context; the re-check sends the page', async () => {
    const page = new FakePage();
    page.ctx = { url: 'https://shop.example/cart', pageVariables: { pageType: 'cart' }, dataLayer: {} };
    const { m } = make(page, []);
    await m.sync().catch(() => undefined);
    const sync = calls.find((c) => c.path.endsWith('/v1/in-app/sync'))!;
    expect(sync.body.capabilities).toContain('page_context');
    expect(sync.body.context).toBeUndefined(); // /sync is per session: the device decides per page
    await (m as any).resolveForDisplay(campaign('r', { reevaluateBeforeDisplay: true }));
    const resolve = calls.find((c) => c.path.endsWith('/v1/in-app/resolve'))!;
    expect(resolve.body.context).toEqual({ url: 'https://shop.example/cart', pageVariables: { pageType: 'cart' }, dataLayer: {} });
    expect(resolve.body.capabilities).toContain('page_context');
    m.destroy();
  });
});
