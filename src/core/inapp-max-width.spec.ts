import * as vm from 'vm';
import {
  InAppMessagingManager,
  IN_APP_DEFAULT_MAX_WIDTH,
  IN_APP_VIEWPORT_MARGIN,
  inAppFrameWidth,
  inAppMaxWidth,
} from './inapp';
import { installFakeDocument, uninstallFakeDocument } from './test-harness';

/**
 * Responsive HTML in-app messages (verified broken on a live store 2026-10-24).
 *
 * The frame of a modal / slide-up used to start narrow and take the width the
 * content reported, so inside it the author's `@media (max-width: 560px)` rule
 * always fired: a 680px two-column pop-up rendered as a 350px single column on
 * desktop. Now the HOST gives the frame min(maxWidth, viewport - 2 * margin)
 * before the document loads, and only the height follows the content.
 *
 * jsdom is not a dependency here and nothing in this harness lays out CSS, so
 * the media query itself is not evaluated. What is asserted is everything it
 * depends on: the frame has the width before the srcdoc loads, a reported
 * width never changes it, the reported height does, and the viewport is
 * followed.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = { getUserId: () => null, getAnonymousId: () => 'anon-1', getAttributes: () => ({}) } as any;
const session = { getSessionId: () => 's-1' } as any;

const html = (type: 'modal' | 'slideup' | 'banner' | 'fullscreen', maxWidth?: number) => ({
  id: `c-${type}`,
  name: 'Two columns',
  type,
  priority: 5,
  evaluationMode: 'session-start-only' as const,
  triggers: [],
  content: { kind: 'html' as const, html: '<div class="cols">x</div>', css: '@media (max-width:560px){.cols{display:block}}', ...(maxWidth ? { maxWidth } : {}) },
});

describe('inAppFrameWidth / inAppMaxWidth', () => {
  it('min(maxWidth, viewport - 16px each side)', () => {
    expect(IN_APP_VIEWPORT_MARGIN).toBe(16);
    expect(inAppFrameWidth(680, 1280)).toBe(680); // desktop: the author's width
    expect(inAppFrameWidth(600, 375)).toBe(343); // phone: the screen minus the margin
    expect(inAppFrameWidth(1200, 800)).toBe(768);
    expect(inAppFrameWidth(600, 10)).toBe(0);
  });

  it('the payload value wins; a payload without one falls back to the type default', () => {
    expect(IN_APP_DEFAULT_MAX_WIDTH).toEqual({ modal: 600, slideup: 400 });
    expect(inAppMaxWidth(html('modal', 680) as any)).toBe(680);
    expect(inAppMaxWidth(html('modal') as any)).toBe(600);
    expect(inAppMaxWidth(html('slideup') as any)).toBe(400);
  });

  it('banner, fullscreen and native content take none', () => {
    expect(inAppMaxWidth(html('banner', 680) as any)).toBeNull();
    expect(inAppMaxWidth(html('fullscreen', 680) as any)).toBeNull();
    expect(inAppMaxWidth({ type: 'modal', content: { kind: 'native', body: 'b' } } as any)).toBeNull();
  });
});

describe('the message frame', () => {
  let listeners: Record<string, Array<() => void>>;
  let win: any;
  beforeEach(() => {
    jest.useFakeTimers();
    installFakeDocument();
    listeners = {};
    win = {
      innerWidth: 1280,
      addEventListener: (t: string, fn: () => void) => (listeners[t] ||= []).push(fn),
      removeEventListener: (t: string, fn: () => void) => {
        listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
      },
    };
    (globalThis as any).window = win;
  });
  afterEach(() => {
    jest.useRealTimers();
    uninstallFakeDocument();
    delete (globalThis as any).window;
  });

  const show = (campaign: any) => {
    const m = new InAppMessagingManager('https://api.example', 'jry_sdk_test', identity, session, logger);
    m.setAllowHtmlJsInAppMessages(true);
    const message = { campaign, renderedHtml: campaign.content.html } as any;
    (m as any).displayedMessages.set(campaign.id, message);
    (m as any).display(message);
    const iframe = (m as any).iframes.get(campaign.id);
    return { m, iframe, bridge: win.__joryioInApp };
  };

  it('a modal frame has min(maxWidth, viewport - margin) BEFORE its document loads', () => {
    const { iframe } = show(html('modal', 680));
    expect(iframe.style.width).toBe('680px');
    expect(iframe.style.height).toBe('0');
    expect(iframe.srcdoc).toContain('.cols'); // the srcdoc is set with the width already in place
  });

  it('on a phone the frame is the screen minus the margin; the container cap is lifted', () => {
    win.innerWidth = 375;
    const { m, iframe } = show(html('modal'));
    expect(iframe.style.width).toBe('343px');
    const container = (globalThis as any).document.getElementById('joryio-inapp-c-modal');
    expect(container.style.maxWidth).toBe('none');
    m.destroy();
  });

  it('a slide-up defaults to 400px', () => {
    const { iframe } = show(html('slideup'));
    expect(iframe.style.width).toBe('400px');
  });

  it('banner and fullscreen keep 100% width', () => {
    expect(show(html('banner', 680)).iframe.style.width).toBe('100%');
    expect(show(html('fullscreen', 680)).iframe.style.width).toBe('100%');
  });

  it('setSize: the height follows the content, the reported width never changes the frame', () => {
    const { iframe, bridge } = show(html('modal', 680));
    bridge.setSize('c-modal', 350, 412.4);
    expect(iframe.style.height).toBe('413px');
    expect(iframe.style.width).toBe('680px');
  });

  it('follows the viewport (debounced) while open, and stops listening once closed', async () => {
    const { m, iframe } = show(html('modal', 680));
    expect(listeners.resize).toHaveLength(1);
    win.innerWidth = 500;
    listeners.resize[0]();
    expect(iframe.style.width).toBe('680px'); // not yet: debounced
    jest.advanceTimersByTime(100);
    expect(iframe.style.width).toBe('468px');
    await m.dismiss('c-modal');
    expect(listeners.resize).toHaveLength(0);
  });
});

describe('the srcdoc measures height at the given width', () => {
  const make = () => new InAppMessagingManager('https://api.example', 'jry_sdk_test', identity, session, logger);

  it('content-sized: no inline-block body (that is what let the frame stay narrow)', () => {
    const doc = (make() as any).buildSrcdoc('c', '<p>x</p>', '', 'modal') as string;
    expect(doc).not.toContain('display:inline-block');
    expect(doc).toContain('body{display:flow-root;}');
    expect((make() as any).buildSrcdoc('c', '<p>x</p>', '', 'banner')).not.toContain('flow-root');
  });

  const reported = (type: string) => {
    const doc = (make() as any).buildSrcdoc('c', '<p>x</p>', '', type) as string;
    const script = doc.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)![1];
    const setSize = jest.fn();
    // The frame is already 600px tall; the content is 180px. The root's
    // scrollHeight is never below the frame, the body's is the content.
    const document: any = {
      readyState: 'complete',
      documentElement: { className: '', scrollWidth: 680, scrollHeight: 600 },
      body: { scrollWidth: 680, scrollHeight: 180, getBoundingClientRect: () => ({ height: 179.5 }) },
      addEventListener() {},
    };
    const window: any = { innerWidth: 680, addEventListener() {} };
    window.parent = { innerWidth: 1280, __joryioInApp: { setSize } };
    vm.runInNewContext(script, { window, document });
    return setSize.mock.calls[0];
  };

  it('a modal reports the BODY height, so a message can shrink as well as grow', () => {
    expect(reported('modal')).toEqual(['c', 680, 180]);
  });

  it('a banner keeps the old measure', () => {
    expect(reported('banner')).toEqual(['c', 680, 600]);
  });
});
