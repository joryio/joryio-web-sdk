/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?joryio_editor=1"}
 */
import { VisualEditor, robustSelector, operationsFor, cssEscape, EDITOR_MESSAGES, EDITOR_SESSION_MESSAGES } from './visual-editor';
import { editorApi } from './index';
import { EDITOR_GLOBAL, EDITOR_API_VERSION } from '../core/editor-gate';
import { EDITOR_STRINGS } from './editor-strings';
import { previewText, setTextFallback, slugify, textFallback, variableTag } from './editor-model';

/**
 * The on-site Web personalization editor (D444 Phase 4, design handoff
 * screens 1-3, 1.4.0-beta.6), the body of the lazily loaded
 * joryio-editor.min.js: origin-checked postMessage with the dashboard the
 * core's handshake verified (editor-gate.spec.ts), a shadow-root UI, the
 * selection and its parent / child moves, one operation per action, live
 * preview, undo and jump-to-edit.
 */
const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const DASHBOARD = 'https://app-eu1.joryio.com';
let posted: Array<{ msg: any; origin: string }>;
let opener: any;
let editor: VisualEditor | null = null;

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <section><h2>One</h2></section>
      <section><h2>Two</h2><p>a</p><p>b <span>c</span></p></section>
      <div id="hero"><img src="https://cdn.example/a.png" srcset="https://cdn.example/a2.png 2x" alt="Hero"></div>
      <button data-testid="buy">Buy</button>
      <div id="react-12345">generated</div>
      <a href="/x">Link</a>
    </main>`;
  posted = [];
  opener = { postMessage: (msg: any, origin: string) => posted.push({ msg, origin }), focus: jest.fn() };
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});

afterEach(() => {
  editor?.stop();
  editor = null;
});

const deliver = async (data: any, origin: string = DASHBOARD, source: any = opener) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  await new Promise((r) => setTimeout(r, 0));
};
const started = () => {
  editor = new VisualEditor(DASHBOARD, opener, logger);
  editor.start();
  return editor;
};
const $ = (j: string) => editor!.root!.querySelector(`[data-j="${j}"]`) as HTMLElement | null;
const $$ = (j: string) => Array.from(editor!.root!.querySelectorAll(`[data-j="${j}"]`)) as HTMLElement[];
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
const type = (el: HTMLElement, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const picks = () => posted.map((p) => p.msg).filter((m) => m.type === EDITOR_MESSAGES.PICK);

describe('the editor bundle', () => {
  it('registers one global with the contract version, and does nothing until started', () => {
    expect((window as any)[EDITOR_GLOBAL]).toBe(editorApi);
    expect(editorApi.version).toBe(EDITOR_API_VERSION);
    expect(posted).toEqual([]);
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
  });

  it('start shows the editor and tells the verified dashboard origin only; stop removes every trace', () => {
    const session = editorApi.start({ dashboardOrigin: DASHBOARD, opener, logger, onStop: () => undefined });
    expect(posted).toEqual([{ msg: { type: EDITOR_MESSAGES.ACTIVE, url: 'https://shop.example/products/shoes' }, origin: DASHBOARD }]);
    expect(document.querySelector('[data-joryio-editor="root"]')).not.toBeNull();
    session.stop();
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
    expect(posted.at(-1)).toEqual({ msg: { type: EDITOR_MESSAGES.CLOSED }, origin: DASHBOARD });
  });
});

describe('shadow root isolation', () => {
  it('the UI lives in a closed shadow root on an all:initial host: the site cannot select or restyle it, its CSS stays inside', () => {
    const siteStyle = document.createElement('style');
    siteStyle.textContent = 'button { display: none !important } .dock { color: red }';
    document.head.appendChild(siteStyle);
    const ed = started();
    const host = document.querySelector('[data-joryio-editor="root"]') as HTMLElement;
    expect(host.shadowRoot).toBeNull(); // closed: the page gets no handle
    expect(host.getAttribute('style')).toContain('all:initial !important');
    // The editor's own buttons are not in the page's DOM: no site selector reaches them.
    expect(document.querySelectorAll('button')).toHaveLength(1);
    expect(document.querySelector('.dock')).toBeNull();
    expect(ed.root!.querySelector('.dock')).not.toBeNull();
    // Its stylesheet is inside the shadow root, not in the document.
    expect(Array.from(document.querySelectorAll('style')).some((s) => (s.textContent || '').includes('.panel{'))).toBe(false);
    expect((ed.root!.querySelector('style')!.textContent || '').includes('.panel{')).toBe(true);
    siteStyle.remove();
  });

  it('a preview in the page is a custom element with its own shadow root, so the site\'s :nth-of-type selectors do not move', () => {
    const ed = started();
    ed.select(document.querySelector('section:nth-of-type(1) h2')!);
    click($('action-slot')!);
    type($('slot-name')!, 'after one');
    const preview = document.querySelector('joryio-editor-preview') as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.shadowRoot!.textContent).toContain('after_one');
    expect(robustSelector(document.querySelectorAll('section')[1])).toBe('body > main > section:nth-of-type(2)');
  });
});

describe('selection', () => {
  it('hover shows the label chip, a click selects (and never reaches the site), the panel names the element and its matches', () => {
    const ed = started();
    const h2 = document.querySelector('section:nth-of-type(2) h2')!;
    h2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect($('hover')!.style.display).toBe('block');
    expect($('hover')!.textContent).toBe('Heading · h2 - click to edit');
    const siteHandler = jest.fn();
    h2.addEventListener('click', siteHandler);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    h2.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(siteHandler).not.toHaveBeenCalled();
    expect($('selected')!.textContent).toBe('Heading · h2');
    expect($('title')!.textContent).toBe('Heading "Two"');
    expect($('matches')!.textContent).toBe('1 match on page');
    expect($('hint')!.textContent).toBe('Editing · changes show live');
    expect(ed.isActive()).toBe(true);
  });

  it('arrow up selects the element around it, arrow down the first element inside it; the breadcrumb and the buttons do the same', () => {
    const ed = started();
    const span = document.querySelector('span')!;
    ed.select(span);
    expect($$('crumb').map((b) => b.textContent)).toEqual(['Page', 'Section', 'Text', 'Text']);
    key('ArrowUp');
    expect($('title')!.textContent).toBe('Text "b c"');
    key('ArrowUp');
    expect($('title')!.textContent).toBe('Section "Twoab c"');
    // Selecting is not editing: the page keeps its markup until a field changes.
    expect(document.querySelectorAll('section')[1].children).toHaveLength(3);
    key('ArrowDown');
    expect($('title')!.textContent).toBe('Heading "Two"');
    click($('up')!);
    expect($('title')!.textContent).toBe('Section "Twoab c"');
    click($('down')!);
    expect($('title')!.textContent).toBe('Heading "Two"');
    // Breadcrumb: Page > Main > Section > Heading; "Main" selects <main>.
    expect($$('crumb').map((b) => b.textContent)).toEqual(['Page', 'Main', 'Section', 'Heading']);
    click($$('crumb')[1]);
    expect($('title')!.textContent!.startsWith('Main')).toBe(true);
    // Up stops below <body>.
    expect(($('up') as HTMLButtonElement).disabled).toBe(true);
  });

  it('arrows typed in the panel stay in the panel; Esc closes the panel, then the editor', () => {
    const ed = started();
    ed.select(document.querySelector('h2')!);
    const area = $('text')!;
    const host = document.querySelector('[data-joryio-editor="root"]')!;
    key('ArrowUp', host);
    expect($('title')!.textContent).toBe('Heading "One"');
    key('Escape');
    expect($('panel')).toBeNull();
    expect(area.isConnected).toBe(false);
    key('Escape');
    expect(ed.isActive()).toBe(false);
  });

  it('only the actions that fit are offered: Change link disabled with "Not a link", Change image only for an image', () => {
    const ed = started();
    ed.select(document.querySelector('h2')!);
    expect(($('action-link') as HTMLButtonElement).disabled).toBe(true);
    expect($('action-link')!.textContent).toContain('Not a link');
    expect(($('action-image') as HTMLButtonElement).disabled).toBe(true);
    expect(($('action-text') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    ed.select(document.querySelector('img')!);
    expect(($('action-image') as HTMLButtonElement).disabled).toBe(false);
    expect(($('action-image') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect(($('action-text') as HTMLButtonElement).disabled).toBe(true);
    ed.select(document.querySelector('a')!);
    expect(($('action-link') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('each action emits its operation', () => {
  it('Change text: one field, variables from the dashboard, the fallback as | default:, live on the page', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }, { name: 'city', custom: true }, { name: 'bad name!' }], sample: { 'user.firstName': 'Lior' } });
    const h2 = document.querySelector('h2')!;
    ed.select(h2);
    expect($$('chip').map((c) => c.textContent)).toEqual(['firstName', 'city']);
    expect($('fields')!.textContent).toContain('Was: "One"');
    type($('text')!, 'Picked for you,');
    click($$('chip')[0]);
    expect(($('text') as HTMLTextAreaElement).value).toBe('Picked for you, {{ user.firstName }}');
    expect(h2.textContent).toBe('Picked for you, Lior'); // live, with the sample value
    type($('fallback')!, 'friend');
    expect(($('text') as HTMLTextAreaElement).value).toBe('Picked for you, {{ user.firstName | default: "friend" }}');
    expect($('save')!.textContent).toBe('Save · Change text');
    click($('save')!);
    expect(picks().at(-1)).toEqual({
      type: EDITOR_MESSAGES.PICK,
      id: expect.stringMatching(/^e[a-z0-9]{8}$/),
      selector: 'body > main > section:nth-of-type(1) > h2',
      operation: 'replace_text',
      value: 'Picked for you, {{ user.firstName | default: "friend" }}',
      tag: 'h2',
      text: 'One',
    });
    expect($('panel')).toBeNull();
    expect(h2.textContent).toBe('Picked for you, Lior'); // stays on the page
    expect($('edits')!.textContent).toBe('1 edit');
  });

  it('Change link: an http(s) address only', () => {
    const ed = started();
    ed.select(document.querySelector('a')!);
    click($('action-link')!);
    type($('url')!, 'javascript:alert(1)');
    expect(($('save') as HTMLButtonElement).disabled).toBe(true);
    expect($('fields')!.textContent).toContain('Enter an address starting with https://');
    type($('url')!, 'https://shop.example/sale');
    expect(document.querySelector('a')!.getAttribute('href')).toBe('https://shop.example/sale');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: 'body > main > a', operation: 'replace_link', value: 'https://shop.example/sale', tag: 'a', text: 'Link' });
  });

  it('Change image: operation replace_image, the srcset steps aside in the preview and comes back on cancel', () => {
    const ed = started();
    const img = document.querySelector('img')!;
    ed.select(img);
    type($('url')!, 'https://cdn.example/b.png');
    expect(img.getAttribute('src')).toBe('https://cdn.example/b.png');
    expect(img.hasAttribute('srcset')).toBe(false);
    click($('cancel')!);
    expect(img.getAttribute('src')).toBe('https://cdn.example/a.png');
    expect(img.getAttribute('srcset')).toBe('https://cdn.example/a2.png 2x');
    ed.select(img);
    type($('url')!, 'https://cdn.example/b.png');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: '#hero > img', operation: 'replace_image', value: 'https://cdn.example/b.png', tag: 'img' });
  });

  it('Hide it: the element is hidden, a "Hidden for this audience" note takes its place', () => {
    const ed = started();
    const btn = document.querySelector('[data-testid=buy]') as HTMLElement;
    ed.select(btn);
    click($('action-hide')!);
    expect($('hide-note')!.textContent).toContain('The button is removed');
    expect(btn.style.getPropertyValue('display')).toBe('none');
    expect((document.querySelector('joryio-editor-preview') as HTMLElement).shadowRoot!.textContent).toContain('Hidden for this audience: Button "Buy"');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: 'button[data-testid="buy"]', operation: 'hide' });
    expect(picks().at(-1).value).toBeUndefined();
  });

  it('Add content slot: a typed name becomes the key (never refused), every position including "Instead of it" (replace)', () => {
    const ed = started();
    const hero = document.querySelector('#hero') as HTMLElement;
    ed.select(hero);
    click($('action-slot')!);
    expect(($('save') as HTMLButtonElement).disabled).toBe(true); // empty name
    type($('slot-name')!, 'After Blog!');
    expect($('slot-key')!.textContent).toBe('after_blog');
    expect($$('positions')[0].textContent).toBe('Above itBelow itInstead of itInside, at the startInside, at the end');
    click($('pos-replace')!);
    expect(hero.style.getPropertyValue('display')).toBe('none');
    expect(hero.nextElementSibling!.tagName).toBe('JORYIO-EDITOR-PREVIEW');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: '#hero', operation: 'insert_placement', placementKey: 'after_blog', position: 'replace', tag: 'div' });
    for (const pos of ['before', 'after', 'prepend', 'append'] as const) {
      ed.select(hero);
      click($('action-slot')!);
      type($('slot-name')!, 'promo');
      click($(`pos-${pos}`)!);
      click($('save')!);
      expect(picks().at(-1)).toMatchObject({ operation: 'insert_placement', placementKey: 'promo', position: pos });
    }
  });

  it('the CSS selector is editable: its match count, and a selector the page cannot use blocks the save', () => {
    const ed = started();
    ed.select(document.querySelector('h2')!);
    click($('css-toggle')!);
    type($('selector')!, 'h2');
    expect($('matches')!.textContent).toBe('Matches 2 - all will change');
    type($('selector')!, 'h3');
    expect($('matches')!.textContent).toBe('Not found');
    type($('selector')!, 'h2 {');
    expect(($('save') as HTMLButtonElement).disabled).toBe(true);
    type($('selector')!, 'section h2');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: 'section h2', operation: 'replace_text' });
  });

  it('pick validates like the server: a bad value is refused, nothing posted', () => {
    const ed = started();
    const a = document.querySelector('a')!;
    expect(ed.pick(a, 'main > a', 'replace_link', 'javascript:alert(1)')).toBe(false);
    expect(ed.pick(a, 'main > a {', 'hide', '')).toBe(false);
    expect(picks()).toEqual([]);
    expect(ed.pick(a, 'main > a', 'replace_link', 'https://shop.example/sale')).toBe(true);
    expect(picks()).toHaveLength(1);
  });
});

describe('undo', () => {
  it('without a dashboard context Undo stays off (an older dashboard would not hear a remove)', () => {
    const ed = started();
    ed.pick(document.querySelector('h2'), 'h2', 'hide', '');
    expect(($('undo') as HTMLButtonElement).disabled).toBe(true);
    expect(ed.undo()).toBe(false);
  });

  it('undo removes a new edit (remove message, page restored) and puts a changed one back (pick with its old value)', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'e1', selector: 'section:nth-of-type(1) h2', operation: 'replace_text', value: 'Hello' }] });
    const h2 = document.querySelector('h2')!;
    expect(h2.textContent).toBe('Hello'); // the dashboard's edits show live
    const btn = document.querySelector('[data-testid=buy]') as HTMLElement;
    ed.pick(btn, 'button[data-testid="buy"]', 'hide', '');
    expect(btn.style.display).toBe('none');
    expect($('edits')!.textContent).toBe('2 edits');
    click($('undo')!);
    expect(posted.at(-1)!.msg).toEqual({ type: EDITOR_SESSION_MESSAGES.REMOVE, id: picks().at(-1).id });
    expect(btn.style.display).toBe('');
    expect($('edits')!.textContent).toBe('1 edit');
    // Change the dashboard's edit, then undo: it goes back to "Hello" under the same id.
    ed.focusEdit('e1');
    type($('text')!, 'Bye');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ id: 'e1', value: 'Bye' });
    expect(h2.textContent).toBe('Bye');
    click($('undo')!);
    expect(picks().at(-1)).toMatchObject({ id: 'e1', operation: 'replace_text', value: 'Hello' });
    expect(h2.textContent).toBe('Hello');
    expect(($('undo') as HTMLButtonElement).disabled).toBe(true);
    ed.stop();
    expect(h2.textContent).toBe('One'); // the page as it was
  });
});

describe('jump to an edit', () => {
  const context = {
    type: EDITOR_SESSION_MESSAGES.CONTEXT,
    campaignName: 'test123',
    variantName: 'A',
    edits: [
      { id: 'e1', selector: 'section:nth-of-type(1) h2', operation: 'replace_text', value: 'Hi' },
      { id: 'e2', selector: '#hero', operation: 'insert_placement', placementKey: 'after_hero', position: 'replace' },
      { id: 'bad', selector: 'h2 {', operation: 'hide' },
    ],
  };

  it('the dashboard focuses an edit: the panel opens on its element with its action and values', async () => {
    const ed = started();
    await deliver({ ...context, focusId: 'e2' });
    expect(ed.editList().map((e) => e.id)).toEqual(['e1', 'e2']); // an untrusted edit is dropped
    expect($('campaign')!.textContent).toBe('test123');
    expect($('action-slot')!.getAttribute('aria-checked')).toBe('true');
    expect(($('slot-name') as HTMLInputElement).value).toBe('after_hero');
    expect($('pos-replace')!.getAttribute('aria-checked')).toBe('true');
    await deliver({ type: EDITOR_SESSION_MESSAGES.FOCUS, id: 'e1' });
    expect(($('text') as HTMLTextAreaElement).value).toBe('Hi');
    expect($('title')!.textContent).toBe('Heading "One"');
  });

  it('focus from another origin or window is ignored', async () => {
    started();
    await deliver(context);
    await deliver({ type: EDITOR_SESSION_MESSAGES.FOCUS, id: 'e1' }, 'https://evil.example');
    await deliver({ type: EDITOR_SESSION_MESSAGES.FOCUS, id: 'e1' }, DASHBOARD, {});
    expect($('panel')).toBeNull();
  });

  it('the dock lists the edits; a click on one jumps to it', async () => {
    started();
    await deliver(context);
    click($('edits')!);
    const items = $$('edit-item');
    expect(items.map((b) => b.textContent)).toEqual(['1Change text · Heading', '2Add content slot · Section']);
    click(items[1]);
    expect($('action-slot')!.getAttribute('aria-checked')).toBe('true');
  });

  it('an edit whose element is not on this page opens with "Not found" and its selector to fix', async () => {
    const ed = started();
    await deliver({ ...context, edits: [{ id: 'e9', selector: '.gone', operation: 'hide' }] });
    expect(ed.focusEdit('e9')).toBe(true);
    expect($('matches')!.textContent).toBe('Not found');
    expect(($('selector') as HTMLInputElement).value).toBe('.gone');
  });
});

describe('the dock and the words', () => {
  it('Save & return: tells the dashboard, stops, goes back to it', () => {
    const close = jest.spyOn(window, 'close').mockImplementation(() => undefined);
    const ed = started();
    click($('done')!);
    expect(posted.slice(-2).map((p) => p.msg.type)).toEqual([EDITOR_SESSION_MESSAGES.DONE, EDITOR_MESSAGES.CLOSED]);
    expect(ed.isActive()).toBe(false);
    expect(opener.focus).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });

  it('the dashboard\'s translations and direction replace the English (text only, unknown keys ignored)', async () => {
    started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, dir: 'rtl', strings: { saveReturn: 'שמירה וחזרה ל-Joryio', hintPoint: '<b>x</b>', nope: 'x' } });
    expect($('done')!.textContent).toBe('שמירה וחזרה ל-Joryio');
    expect($('hint')!.textContent).toBe('<b>x</b>'); // text, never HTML
    expect(editor!.root!.querySelector('.r')!.getAttribute('dir')).toBe('rtl');
  });

  it('no English UI text uses an em-dash', () => {
    expect(Object.values(EDITOR_STRINGS).filter((s) => s.includes('—'))).toEqual([]);
  });

  it('the tip card is dismissed for good (stored), not only hidden', () => {
    started();
    click($('help-dismiss')!);
    expect($('help')).toBeNull();
    editor!.stop();
    started();
    expect($('help')).toBeNull();
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

describe('the Liquid of a personalized text (the dashboard\'s format)', () => {
  it('variables, fallbacks and the preview', () => {
    expect(variableTag('firstName', false)).toBe('{{ user.firstName }}');
    expect(variableTag('city', true, 'there')).toBe('{{ user.custom.city | default: "there" }}');
    expect(textFallback('Hi')).toBeNull();
    expect(textFallback('Hi {{ user.firstName }}')).toBe('');
    expect(setTextFallback('Hi {{ user.firstName }}, {{ user.custom.city | default: "x" }}', 'you')).toBe('Hi {{ user.firstName | default: "you" }}, {{ user.custom.city | default: "you" }}');
    expect(previewText('Hi {{ user.firstName | default: "you" }}', { 'user.firstName': 'Lior' })).toBe('Hi Lior');
    expect(previewText('Hi {{ user.firstName | default: "you" }}', {})).toBe('Hi you');
    expect(previewText('Hi {{ user.custom.city }}', {})).toBe('Hi [city]');
    expect(slugify('  After Blog!! ')).toBe('after_blog');
  });
});
