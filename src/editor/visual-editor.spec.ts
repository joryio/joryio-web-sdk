/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?joryio_editor=1"}
 */
import { VisualEditor, robustSelector, operationsFor, cssEscape, EDITOR_MESSAGES } from './visual-editor';
import { editorApi } from './index';
import { EDITOR_GLOBAL, EDITOR_API_VERSION } from '../core/editor-gate';

/**
 * The point-and-click picker (D444 Phase 4, docs/PLACEMENTS_WEBSITE_LAYER.md 3),
 * the body of the lazily loaded joryio-editor.min.js: origin-checked
 * postMessage with the dashboard the core's handshake verified
 * (editor-gate.spec.ts), and the selector it computes.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const DASHBOARD = 'https://app-eu1.joryio.com';
let posted: Array<{ msg: any; origin: string }>;
let opener: any;

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <section><h2>One</h2></section>
      <section><h2>Two</h2><p>a</p><p>b <span>c</span></p></section>
      <div id="hero"><img src="https://cdn.example/a.png"></div>
      <button data-testid="buy">Buy</button>
      <div id="react-12345">generated</div>
      <a href="/x">Link</a>
    </main>`;
  posted = [];
  opener = { postMessage: (msg: any, origin: string) => posted.push({ msg, origin }) };
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
});

const deliver = async (data: any, origin: string, source: any = opener) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('the editor bundle', () => {
  it('registers one global with the contract version, and does nothing until started', () => {
    expect((window as any)[EDITOR_GLOBAL]).toBe(editorApi);
    expect(editorApi.version).toBe(EDITOR_API_VERSION);
    expect(posted).toEqual([]);
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
  });

  it('start shows the picker and tells the verified dashboard origin only', () => {
    const session = editorApi.start({ dashboardOrigin: DASHBOARD, opener, logger, onStop: () => undefined });
    expect(posted).toEqual([{ msg: { type: EDITOR_MESSAGES.ACTIVE, url: 'https://shop.example/products/shoes' }, origin: DASHBOARD }]);
    expect(document.querySelector('[data-joryio-editor="panel"]')).not.toBeNull();
    session.stop();
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
  });

  it('a pick is posted to the dashboard origin only; a bad value is refused in the panel', async () => {
    const stopped = jest.fn();
    const ed = new VisualEditor(DASHBOARD, opener, logger, stopped);
    ed.start();
    const a = document.querySelector('a')!;
    expect(ed.pick(a, 'main > a', 'replace_link', 'javascript:alert(1)')).toBe(false);
    expect(ed.pick(a, 'main > a', 'replace_link', 'https://shop.example/sale')).toBe(true);
    expect(posted.at(-1)).toEqual({
      msg: { type: EDITOR_MESSAGES.PICK, selector: 'main > a', operation: 'replace_link', value: 'https://shop.example/sale', tag: 'a', text: 'Link' },
      origin: DASHBOARD,
    });
    // Clicking the page selects instead of following the link.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-joryio-editor="panel"]')!.textContent).toContain('main > a');
    // Close from the dashboard, only from its origin and its window.
    await deliver({ type: EDITOR_MESSAGES.CLOSE }, 'https://evil.example');
    await deliver({ type: EDITOR_MESSAGES.CLOSE }, DASHBOARD, {});
    expect(ed.isActive()).toBe(true);
    await deliver({ type: EDITOR_MESSAGES.CLOSE }, DASHBOARD);
    expect(ed.isActive()).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toEqual({ msg: { type: EDITOR_MESSAGES.CLOSED }, origin: DASHBOARD });
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
  });
});

describe('robustSelector', () => {
  const sel = (q: string) => robustSelector(document.querySelector(q)!);
  it('prefers a stable id, then a naming data attribute', () => {
    expect(sel('#hero')).toBe('#hero');
    expect(sel('[data-testid=buy]')).toBe('button[data-testid="buy"]');
  });
  it('skips a generated id and falls back to a stable path that finds only this element', () => {
    expect(sel('#react-12345')).toBe('body > main > div:nth-of-type(2)');
    expect(sel('#hero img')).toBe('#hero > img');
    const s = sel('section:nth-of-type(2) p:nth-of-type(2) span')!;
    expect(s).toBe('body > main > section:nth-of-type(2) > p:nth-of-type(2) > span');
    expect(document.querySelectorAll(s)).toHaveLength(1);
  });
  it('escapes an id it uses', () => {
    expect(cssEscape('1a b')).toBe('\\31 a\\ b');
  });
  it('offers the operations that fit', () => {
    expect(operationsFor(document.querySelector('img')!)).toEqual(['replace_image', 'hide', 'insert_placement']);
    expect(operationsFor(document.querySelector('a')!)).toEqual(['replace_text', 'replace_link', 'hide', 'insert_placement']);
  });
});
