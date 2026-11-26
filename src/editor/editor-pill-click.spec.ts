/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/?joryio_editor=1"}
 */
import { VisualEditor, EDITOR_MESSAGES, EDITOR_SESSION_MESSAGES } from './visual-editor';
import { serialize } from './liquid-field';

/**
 * The beta.7 report "a click on the page pill removed the variable",
 * reproduced in the conditions of the store: a WordPress block-theme heading,
 * Hebrew text before the pill, the edit from the dashboard context or typed
 * in the editor, one or two clicks, on the pill or on the heading around it.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const DASHBOARD = 'https://app-eu1.joryio.com';
let posted: any[];
let opener: any;
let editor: VisualEditor | null = null;
const SEL = 'h1.wp-block-heading';

beforeEach(() => {
  document.documentElement.setAttribute('dir', 'rtl');
  document.body.innerHTML = `
    <div class="wp-site-blocks"><main class="wp-block-group is-layout-constrained">
      <h1 class="wp-block-heading has-text-align-center has-x-large-font-size" style="font-style:normal;font-weight:700">שלום עולם</h1>
      <p>טקסט</p>
    </main></div>`;
  posted = [];
  opener = { postMessage: (msg: any) => posted.push(msg), focus: jest.fn() };
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
});
afterEach(() => {
  editor?.stop();
  editor = null;
});

const deliver = async (data: any) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin: DASHBOARD, source: opener }));
  await new Promise((r) => setTimeout(r, 0));
};
const $ = (j: string) => editor!.root!.querySelector(`[data-j="${j}"]`) as HTMLElement | null;
const $$ = (j: string) => Array.from(editor!.root!.querySelectorAll(`[data-j="${j}"]`)) as HTMLElement[];
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
const textValue = () => serialize($('text')!);
const h1 = () => document.querySelector('h1')!;
const pagePill = () => h1().querySelector('[data-joryio-editor="var"]') as HTMLElement;
const start = async (ctx: Record<string, unknown>) => {
  editor = new VisualEditor(DASHBOARD, opener, logger);
  editor.start();
  await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, dir: 'rtl', attributes: [{ key: 'user.firstName', label: 'First Name', group: 'Profile' }], ...ctx });
};
const VALUE = 'היי {{ user.firstName }}';

describe('page pill click (beta.7 report, store conditions)', () => {
  it('a dashboard edit, panel closed: one click on the pill', async () => {
    await start({ edits: [{ id: 'e1', selector: SEL, operation: 'replace_text', value: VALUE }] });
    click(pagePill());
    expect(textValue()).toBe(VALUE);
  });

  it('a dashboard edit: two clicks on the pill (the panel already open on it)', async () => {
    await start({ edits: [{ id: 'e1', selector: SEL, operation: 'replace_text', value: VALUE }] });
    click(pagePill());
    click(pagePill());
    expect(textValue()).toBe(VALUE);
  });

  it('a dashboard edit: a click on the heading next to the pill (its edge), then on the pill', async () => {
    await start({ edits: [{ id: 'e1', selector: SEL, operation: 'replace_text', value: VALUE }] });
    click(h1());
    click(pagePill());
    expect(textValue()).toBe(VALUE);
  });

  it('an unsaved draft typed in the editor: a click on its page pill', async () => {
    await start({});
    click(h1());
    const field = $('text')!;
    field.textContent = 'היי';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click($$('chip')[0]);
    expect(textValue()).toBe(VALUE);
    click(pagePill());
    expect(textValue()).toBe(VALUE);
    expect(posted.filter((m) => m.type === EDITOR_MESSAGES.PICK)).toEqual([]);
  });

  it('a dashboard edit changed in the panel (not saved yet): a click on its page pill', async () => {
    await start({ edits: [{ id: 'e1', selector: SEL, operation: 'replace_text', value: VALUE }] });
    click(pagePill());
    const field = $('text')!;
    field.insertBefore(document.createTextNode('!'), field.firstChild);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    click(pagePill());
    expect(textValue()).toBe(`!${VALUE}`);
  });
});

describe('Insert picker details (beta.7 report)', () => {
  it('old-shape fields mixed with the catalog get their own heading ("Profile" / "Custom fields"), never the last group of the catalog', async () => {
    await start({
      attributes: [
        { key: 'user.firstName', label: 'First Name', group: 'פרופיל' },
        { key: 'user.lastName', label: 'Last Name', group: 'פרופיל' },
        { key: 'user.email', label: 'Email', group: 'פרופיל' },
        { key: 'user.custom.city', label: 'City', group: 'שדות מותאמים' },
        { name: 'phone' },
        { name: 'tier', custom: true },
      ],
      strings: { groupProfile: 'פרופיל בסיסי', groupCustom: 'שדות נוספים' },
    });
    click(h1());
    click($('more')!);
    const rows = Array.from($('var-list')!.children).map((c) => c.textContent);
    expect(rows.slice(-4)).toEqual(['פרופיל בסיסי', 'phoneuser.phone', 'שדות נוספים', 'tieruser.custom.tier']);
  });

  it('"More" and the fallback "Done" use the UI font, not the code font of the field chips', async () => {
    await start({ attributes: [1, 2, 3, 4, 5].map((i) => ({ key: `user.custom.f${i}`, label: `f${i}`, group: 'x' })) });
    click(h1());
    expect($('more')!.className).toBe('vc ui');
    click($$('chip')[0]);
    click(editor!.root!.querySelector('[data-j="text"] [data-liquid]')!);
    expect($('fallback-done')!.className).toBe('vc ui');
    expect(editor!.root!.querySelector('style')!.textContent).toContain('.vc.ui{font-family:Inter');
  });
});
