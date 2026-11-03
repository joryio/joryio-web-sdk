import { InAppMessagingManager, IN_APP_DISPLAY_DWELL_MS } from './inapp';
import { installFakeDocument, uninstallFakeDocument, installFetch, RecordedRequest } from './test-harness';

/**
 * A message counts as displayed only once someone could have seen it
 * (IN_APP_DISPLAY_DWELL_MS, BACKLOG D320).
 *
 * Prod 2026-11-02/03: an immediate-trigger modal on a WooCommerce store was
 * mounted during a sign-in redirect and again during a logout - served and
 * "displayed" in the same second, seen at most as a flash. Both counted, the
 * 2-per-7-days cap was spent, and the tester never saw the message.
 *
 * The rules pinned here:
 *  - nothing is mounted into a page that is unloading, and nothing before the
 *    page has loaded and gone idle;
 *  - `in_app.displayed` is reported, and the local frequency cap consumed,
 *    only after the message has been visible for the dwell;
 *  - hidden / unloading before the dwell: no report, no cap - eligible again;
 *  - a click or a dismiss by the person before the dwell counts as seen:
 *    displayed first, then the click / dismiss;
 *  - any other removal before the dwell reports nothing.
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

const campaign = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'c1',
    name: 'QA modal',
    type: 'modal',
    triggers: [{ type: 'immediate' }],
    frequencyCap: { maxImpressions: 2, timeWindow: '7d' },
    content: {
      kind: 'native',
      title: 'Hi',
      body: 'Body',
      buttons: [{ id: 'cta', text: 'Go', action: 'url', url: 'https://example.com/x' }],
    },
    ...extra,
  }) as any;

let calls: RecordedRequest[] = [];
let mounted: any[] = [];
let windowListeners: Map<string, Array<() => void>>;
let documentListeners: Map<string, Array<() => void>>;
let doc: any;
let managers: InAppMessagingManager[] = [];

const fire = (map: Map<string, Array<() => void>>, type: string) => (map.get(type) || []).slice().forEach((fn) => fn());
const fireWindow = (type: string) => fire(windowListeners, type);
const setHidden = (hidden: boolean) => {
  doc.visibilityState = hidden ? 'hidden' : 'visible';
  doc.hidden = hidden;
  fire(documentListeners, 'visibilitychange');
};

const tracks = () => calls.filter((c) => c.path.endsWith('/v1/in-app/track')).map((c) => c.body);
const kinds = () =>
  tracks().map((t) => (t.displayedAt ? 'displayed' : t.clicked ? 'clicked' : t.dismissedAt ? 'dismissed' : 'other'));
const container = () => mounted.find((el) => el.id === 'joryio-inapp-c1');
const capUsed = (m: InAppMessagingManager) => ((m as any).impressionTimestamps.get('c1') || []).length;

function findByClass(el: any, cls: string): any {
  if (!el) return null;
  if (String(el.className || '').split(' ').includes(cls)) return el;
  for (const child of el.children || []) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

/** displayCampaign waits for the page to settle (an idle tick): let the fake clock run it. */
async function show(m: InAppMessagingManager): Promise<void> {
  const shown = m.displayCampaign(campaign());
  await jest.advanceTimersByTimeAsync(60);
  await shown;
}

function make(readyState = 'complete') {
  windowListeners = new Map();
  documentListeners = new Map();
  const listen = (map: Map<string, Array<() => void>>) => (type: string, fn: () => void) => {
    map.set(type, [...(map.get(type) || []), fn]);
  };
  const unlisten = (map: Map<string, Array<() => void>>) => (type: string, fn: () => void) => {
    map.set(type, (map.get(type) || []).filter((f) => f !== fn));
  };
  (globalThis as any).window = {
    open: jest.fn(),
    addEventListener: listen(windowListeners),
    removeEventListener: unlisten(windowListeners),
  };
  (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
  doc = (globalThis as any).document;
  doc.readyState = readyState;
  doc.visibilityState = 'visible';
  doc.addEventListener = listen(documentListeners);
  doc.removeEventListener = unlisten(documentListeners);
  const m = new InAppMessagingManager(
    'https://api.example/api',
    'jry_sdk_test',
    identity,
    session,
    logger,
    null,
    { closeButton: true, backdropClose: true },
    undefined,
    null,
    {},
  );
  (m as any).campaigns.set('c1', campaign());
  managers.push(m);
  return m;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  calls = installFetch(() => ({ status: 200, body: { success: true } }));
  ({ mounted } = installFakeDocument());
});
afterEach(() => {
  managers.forEach((m) => m.destroy());
  managers = [];
  jest.useRealTimers();
  uninstallFakeDocument();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).navigator;
});

describe('IN_APP_DISPLAY_DWELL_MS', () => {
  it('is one second - the same name and value on every SDK', () => {
    expect(IN_APP_DISPLAY_DWELL_MS).toBe(1000);
  });
});

describe('the page settles before a message appears', () => {
  it('waits for `load` while the page is still loading', async () => {
    const m = make('loading');
    const shown = m.displayCampaign(campaign());
    await jest.advanceTimersByTimeAsync(500);
    expect(container()).toBeUndefined();
    doc.readyState = 'complete';
    fireWindow('load');
    await jest.advanceTimersByTimeAsync(100);
    await shown;
    expect(container()).toBeDefined();
  });

  it('unload before show: nothing appears, nothing is reported, and it stays eligible', async () => {
    const m = make('loading');
    const shown = m.displayCampaign(campaign());
    // The sign-in redirect starts before the page finished loading.
    fireWindow('beforeunload');
    fireWindow('load');
    await jest.advanceTimersByTimeAsync(5000);
    await shown;
    expect(container()).toBeUndefined();
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);

    // The page is still here after all (bfcache restore): shown normally.
    doc.readyState = 'complete';
    fireWindow('pageshow');
    await show(m);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS + 100);
    expect(container()).toBeDefined();
    expect(kinds()).toEqual(['displayed']);
  });

  it('a page that is already unloading never mounts the message', async () => {
    const m = make();
    fireWindow('pagehide');
    await show(m);
    await jest.advanceTimersByTimeAsync(3000);
    expect(container()).toBeUndefined();
    expect(tracks()).toEqual([]);
  });

  it('uses requestIdleCallback when the browser has it', async () => {
    const m = make();
    const idle = jest.fn((cb: () => void) => setTimeout(cb, 5));
    (globalThis as any).window.requestIdleCallback = idle;
    await show(m);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(container()).toBeDefined();
  });
});

describe('a message counts as displayed after the dwell, while visible', () => {
  it('visible for the dwell: displayed once, cap consumed once', async () => {
    const m = make();
    await show(m);
    expect(container()).toBeDefined();
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS - 50);
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(kinds()).toEqual(['displayed']);
    expect(capUsed(m)).toBe(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(kinds()).toEqual(['displayed']);
    expect(capUsed(m)).toBe(1);
  });

  it('hidden before the dwell: no displayed, cap not consumed; counted after a full dwell once visible again', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(500);
    setHidden(true);
    await jest.advanceTimersByTimeAsync(5000);
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);

    setHidden(false);
    // The dwell starts again from zero.
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS - 100);
    expect(tracks()).toEqual([]);
    await jest.advanceTimersByTimeAsync(200);
    expect(kinds()).toEqual(['displayed']);
    expect(capUsed(m)).toBe(1);
  });

  it('the page unloads during the dwell (logout link): no displayed, cap not consumed', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(300);
    fireWindow('beforeunload');
    fireWindow('pagehide');
    await jest.advanceTimersByTimeAsync(5000);
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);
  });

  it('a message removed by the SDK before the dwell (host dismiss, reset) reports nothing', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(300);
    await m.dismiss('c1'); // the host's dismissInAppMessage
    await jest.advanceTimersByTimeAsync(5000);
    expect(container()).toBeUndefined();
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);
  });

  it('a dismiss by the person before the dwell counts: displayed, then dismissed', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(300);
    findByClass(container(), 'joryio-inapp-close').on_click();
    await jest.advanceTimersByTimeAsync(10);
    expect(kinds()).toEqual(['displayed', 'dismissed']);
    expect(capUsed(m)).toBe(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(kinds()).toEqual(['displayed', 'dismissed']);
  });

  it('a click before the dwell counts: displayed, then clicked (and the button dismisses)', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(300);
    const row = findByClass(container(), 'joryio-inapp-buttons');
    row.children[0].on_click();
    await jest.advanceTimersByTimeAsync(10);
    expect(kinds()).toEqual(['displayed', 'clicked', 'dismissed']);
    expect(capUsed(m)).toBe(1);
  });

  it('the visitor changed before the dwell (identify): nothing is reported, not even a later close', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(300);
    m.invalidate();
    await jest.advanceTimersByTimeAsync(5000);
    findByClass(container(), 'joryio-inapp-close').on_click();
    await jest.advanceTimersByTimeAsync(10);
    expect(tracks()).toEqual([]);
    expect(capUsed(m)).toBe(0);
  });

  it('a confirmed message dismissed later reports dismissed once, displayed once', async () => {
    const m = make();
    await show(m);
    await jest.advanceTimersByTimeAsync(IN_APP_DISPLAY_DWELL_MS + 10);
    findByClass(container(), 'joryio-inapp-close').on_click();
    await jest.advanceTimersByTimeAsync(10);
    expect(kinds()).toEqual(['displayed', 'dismissed']);
  });
});
