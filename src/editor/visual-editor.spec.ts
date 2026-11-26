/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://shop.example/products/shoes?joryio_editor=1"}
 */
import { VisualEditor, robustSelector, operationsFor, cssEscape, revealOption, shortText, EDITOR_MESSAGES, EDITOR_SESSION_MESSAGES } from './visual-editor';
import { editorApi } from './index';
import { EDITOR_GLOBAL, EDITOR_API_VERSION } from '../core/editor-gate';
import { EDITOR_STRINGS } from './editor-strings';
import { isPlainFallback, liquidParts, previewParts, previewText, quoted, setVarFallback, slugify, varFallback, variableTag } from './editor-model';
import { serialize } from './liquid-field';

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
/** Typing: a field's value, or the pill box's text (jsdom has no editing, so the box's content is set). */
const type = (el: HTMLElement, value: string) => {
  if (el.tagName === 'DIV') el.textContent = value;
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
/** The New text field's value: the textarea's, or the pill box's Liquid. */
const textValue = () => {
  const el = $('text')!;
  return el.tagName === 'DIV' ? serialize(el) : (el as HTMLTextAreaElement).value;
};
const picks = () => posted.map((p) => p.msg).filter((m) => m.type === EDITOR_MESSAGES.PICK);
/** The New text field's variable pills. */
const pills = () => Array.from(editor!.root!.querySelectorAll('[data-j="text"] [data-liquid]')) as HTMLElement[];
/** A pill's own fallback: click the pill, type in its popover. */
const setPillFallback = (i: number, value: string) => {
  click(pills()[i]);
  type($('fallback')!, value);
};

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
    expect(textValue()).toBe('Picked for you, {{ user.firstName }}');
    expect(h2.textContent).toBe('Picked for you, Lior'); // live, with the sample value
    setPillFallback(0, 'friend');
    expect(textValue()).toBe('Picked for you, {{ user.firstName | default: "friend" }}');
    expect($('save')!.textContent).toBe('Save · Change text');
    click($('save')!);
    expect(picks().at(-1)).toEqual({
      type: EDITOR_MESSAGES.PICK,
      id: expect.stringMatching(/^e[a-z0-9]{8}$/),
      selector: 'body > main > section:nth-of-type(1) > h2',
      operation: 'replace_text',
      value: 'Picked for you, {{ user.firstName | default: "friend" }}',
      device: 'all',
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
    expect(textValue()).toBe('Hi');
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
    expect(varFallback('{{ user.firstName }}')).toBeNull();
    expect(varFallback("{{user.firstName|default:'x'}}")).toBe('x');
    expect(setVarFallback('{{ user.custom.city | default: "x" }}', 'you')).toBe('{{ user.custom.city | default: "you" }}');
    expect(setVarFallback('{{ user.custom.city | default: "x" }}', '  ')).toBe('{{ user.custom.city }}');
    expect(previewText('Hi {{ user.firstName | default: "you" }}', { 'user.firstName': 'Lior' })).toBe('Hi Lior');
    expect(previewText('Hi {{ user.firstName | default: "you" }}', {})).toBe('Hi you');
    expect(previewText('Hi {{ user.custom.city }}', {})).toBe('Hi [city]');
    expect(slugify('  After Blog!! ')).toBe('after_blog');
  });
});

describe('a variable with no sample value and no fallback is a placeholder pill in the live preview', () => {
  const pillsIn = (el: Element) => Array.from(el.querySelectorAll('joryio-editor-preview[data-joryio-editor="var"]')) as HTMLElement[];

  it('the pill shows the field name inside its own shadow root, never as page text', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }, { name: 'city', custom: true }] });
    const h2 = document.querySelector('h2')!;
    ed.select(h2);
    type($('text')!, 'Hi');
    click($$('chip')[1]);
    expect(textValue()).toBe('Hi {{ user.custom.city }}');
    const pills = pillsIn(h2);
    expect(pills).toHaveLength(1);
    expect(pills[0].shadowRoot!.querySelector('.v')!.textContent).toBe('city');
    expect(pills[0].shadowRoot!.querySelector('.v')!.getAttribute('dir')).toBe('auto');
    expect(pills[0].getAttribute('style')).toContain('display:inline !important');
    expect(pills[0].getAttribute('style')).toContain('unicode-bidi:isolate');
    // Not page text: the element's own text has no name and no brackets.
    expect(h2.textContent).toBe('Hi ');
    expect(h2.textContent).not.toContain('[city]');
    // A custom element, so the site's :nth-of-type selectors (and the editor's own) do not move.
    expect(h2.querySelectorAll('span')).toHaveLength(0);
    expect(robustSelector(document.querySelectorAll('section')[1])).toBe('body > main > section:nth-of-type(2)');
    // The saved edit is unchanged Liquid; cancel / stop restore the page.
    click($('save')!);
    expect(picks().at(-1).value).toBe('Hi {{ user.custom.city }}');
    ed.stop();
    expect(document.querySelector('joryio-editor-preview')).toBeNull();
    expect(h2.textContent).toBe('One');
  });

  it('with a sample value the value shows, with only a fallback the fallback (no pill)', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, sample: { 'user.firstName': 'Lior' } });
    const [one, two] = Array.from(document.querySelectorAll('h2'));
    ed.pick(one, 'section:nth-of-type(1) h2', 'replace_text', 'Hi {{ user.firstName }}');
    ed.pick(two, 'section:nth-of-type(2) h2', 'replace_text', 'Hi {{ user.lastName | default: "friend" }}');
    expect(one.textContent).toBe('Hi Lior');
    expect(two.textContent).toBe('Hi friend');
    expect(pillsIn(document.body)).toHaveLength(0);
  });

  it('a right-to-left page: the pill is its own bidi island', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, dir: 'rtl' });
    const p = document.querySelector('p')!;
    p.setAttribute('dir', 'rtl');
    ed.pick(p, 'section:nth-of-type(2) > p:nth-of-type(1)', 'replace_text', 'שלום {{ user.firstName }}!');
    expect(p.textContent).toBe('שלום !');
    const pill = pillsIn(p)[0];
    expect(pill.previousSibling!.textContent).toBe('שלום ');
    expect(pill.nextSibling!.textContent).toBe('!');
    expect(pill.getAttribute('style')).toContain('unicode-bidi:isolate');
    expect(pill.shadowRoot!.querySelector('.v')!.getAttribute('dir')).toBe('auto');
  });

  it('a click on a pill selects the element it is in and never reaches the site', () => {
    const ed = started();
    const a = document.querySelector('a')!;
    ed.pick(a, 'main > a', 'replace_text', 'Go {{ user.firstName }}');
    const pill = pillsIn(a)[0];
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    pill.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect($('title')!.textContent).toBe('Link "Link"');
  });

  it('the visitor runtime is unchanged: no pill code reaches the core bundle', () => {
    const fs = require('fs');
    const path = require('path');
    const core = fs.readdirSync(path.join(__dirname, '../core')).filter((f: string) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    for (const f of core) {
      const src = fs.readFileSync(path.join(__dirname, '../core', f), 'utf8');
      expect(src).not.toMatch(/previewParts|PREVIEW_VAR_HOST_STYLE|from '\.\.\/editor/);
    }
  });
});

describe('the New text field shows variables as pills, and stores the same Liquid', () => {
  const box = () => $('text')!;
  const pillEls = () => Array.from(box().querySelectorAll('[data-liquid]')) as HTMLElement[];
  // jsdom keeps no selection inside a shadow root; this stands in for Chromium's shadowRoot.getSelection().
  let range: Range | null = null;
  const select = (r: Range) => {
    range = r;
    (editor!.root as any).getSelection = () => ({ rangeCount: range ? 1 : 0, getRangeAt: () => range, removeAllRanges: () => (range = null), addRange: (x: Range) => (range = x) });
  };
  const caretAt = (node: Node, offset: number) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    select(r);
  };
  const open = async (ctx: Record<string, unknown> = {}) => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }, { name: 'city', custom: true }], ...ctx });
    ed.select(document.querySelector('h2')!);
    return ed;
  };

  it('an Insert chip puts an atomic pill in the field; the field emits the same string as before', async () => {
    await open();
    type(box(), 'Picked for you,');
    click($$('chip')[0]);
    expect(box().tagName).toBe('DIV');
    expect(box().getAttribute('contenteditable')).toBe('true');
    const [p] = pillEls();
    expect(p.textContent).toBe('firstName');
    expect(p.getAttribute('contenteditable')).toBe('false');
    expect(p.getAttribute('data-liquid')).toBe('{{ user.firstName }}');
    expect(textValue()).toBe('Picked for you, {{ user.firstName }}');
    setPillFallback(0, 'friend');
    expect(textValue()).toBe('Picked for you, {{ user.firstName | default: "friend" }}');
    expect(pillEls()).toHaveLength(1);
    expect(pillEls()[0].textContent).toBe('firstName · friend');
    click($('save')!);
    expect(picks().at(-1).value).toBe('Picked for you, {{ user.firstName | default: "friend" }}');
  });

  it('a chip inserts at the caret', async () => {
    await open();
    type(box(), 'Hello there');
    caretAt(box().firstChild!, 5);
    click($$('chip')[1]);
    expect(textValue()).toBe('Hello {{ user.custom.city }} there');
    expect(pillEls()).toHaveLength(1);
  });

  it('Backspace after a pill (and Delete before one) removes the whole pill', async () => {
    await open();
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    box().appendChild(document.createTextNode('!'));
    box().dispatchEvent(new Event('input'));
    expect(textValue()).toBe('Hi {{ user.firstName }}!');
    caretAt(box().lastChild!, 0); // between the pill and "!"
    const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    box().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pillEls()).toHaveLength(0);
    expect(textValue()).toBe('Hi !');
    // Delete, with the caret right before a pill.
    click($$('chip')[0]);
    caretAt(box(), Array.from(box().childNodes).indexOf(pillEls()[0]));
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    expect(pillEls()).toHaveLength(0);
    // Enter adds no line or markup.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    box().dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('copy puts the Liquid on the clipboard; paste is plain text and its Liquid becomes pills', async () => {
    await open();
    type(box(), 'Hi');
    click($$('chip')[0]);
    const r = document.createRange();
    r.selectNodeContents(box());
    select(r);
    const data: Record<string, string> = {};
    const copy = Object.assign(new Event('copy', { cancelable: true }), { clipboardData: { setData: (k: string, v: string) => (data[k] = v), getData: () => '' } });
    box().dispatchEvent(copy);
    expect(data['text/plain']).toBe('Hi {{ user.firstName }}');
    caretAt(box(), box().childNodes.length);
    const paste = Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: () => ' and {{ user.custom.city | default: "you" }}' } });
    box().dispatchEvent(paste);
    expect(textValue()).toBe('Hi {{ user.firstName }} and {{ user.custom.city | default: "you" }}');
    expect(pillEls().map((p) => p.textContent)).toEqual(['firstName', 'city · you']);
  });

  it('"Liquid code" shows the raw text; editing it redraws the pills, byte for byte', async () => {
    await open();
    expect($('liquid')).toBeNull();
    click($('liquid-toggle')!);
    const liquid = 'Hi {{user.firstName|default:\'x\'}}, from {{ user.custom.city }}!';
    type($('liquid')!, liquid);
    expect(pillEls().map((p) => p.textContent)).toEqual(['firstName · x', 'city']);
    expect(textValue()).toBe(liquid);
    // A new variable has no fallback of its own: the other pill's stays on that pill.
    click($$('chip')[0]);
    expect(($('liquid') as HTMLTextAreaElement).value).toBe(`${liquid} {{ user.firstName }}`);
    click($('save')!);
    expect(picks().at(-1).value).toBe(`${liquid} {{ user.firstName }}`);
  });

  it('Liquid a pill cannot show keeps the field raw text with a note, and nothing is lost', async () => {
    await open();
    click($('liquid-toggle')!);
    for (const raw of ['{% if user.vip %}VIP{% endif %} hi', 'Hi {{ user.firstName | upcase }}', 'Hi {{ "x" }}']) {
      type($('liquid')!, raw);
      expect(box().tagName).toBe('TEXTAREA');
      expect(textValue()).toBe(raw);
      expect($('raw-note')!.textContent).toContain('Shown as code');
    }
    type(box(), 'Hi {% if x %}y{% endif %}');
    click($('save')!);
    expect(picks().at(-1).value).toBe('Hi {% if x %}y{% endif %}');
    // Back to a simple text: pills again.
    const ed = editor!;
    ed.select(document.querySelectorAll('h2')[1]);
    expect($('liquid')).not.toBeNull(); // the Liquid code section stays open
    type($('liquid')!, 'Yo {{ user.firstName }}');
    expect(box().tagName).toBe('DIV');
    expect($('raw-note')).toBeNull();
  });

  it('right-to-left: the field follows the text direction, a pill is isolated', async () => {
    await open({ dir: 'rtl' });
    type(box(), 'שלום');
    click($$('chip')[0]);
    expect(editor!.root!.querySelector('.r')!.getAttribute('dir')).toBe('rtl');
    expect(box().getAttribute('dir')).toBe('auto');
    expect(pillEls()[0].getAttribute('dir')).toBe('auto'); // a Hebrew label reads right, isolated from the text around it
    expect(textValue()).toBe('שלום {{ user.firstName }}');
    expect((editor!.root!.querySelector('style')!.textContent || '')).toMatch(/\.vp\{[^}]*unicode-bidi:isolate/);
  });

  it('the model: parts, previews and the raw fallback', () => {
    expect(liquidParts('Hi {{ user.firstName }}!')).toEqual(['Hi ', { name: 'firstName', path: 'user.firstName', src: '{{ user.firstName }}' }, '!']);
    expect(liquidParts('{{ user.custom.city | default: "x" }}')).toEqual([{ name: 'city', path: 'user.custom.city', src: '{{ user.custom.city | default: "x" }}' }]);
    expect(liquidParts('{% if a %}b{% endif %}')).toBeNull();
    expect(liquidParts('{{ user.a | upcase }}')).toBeNull();
    expect(liquidParts('a }} b')).toBeNull();
    expect(previewParts('Hi {{ user.firstName }} {{ user.a | default: "x" }}', {})).toEqual(['Hi ', { name: 'firstName', path: 'user.firstName', src: '{{ user.firstName }}' }, ' x']);
  });
});

describe('selecting an element that already has an edit opens that edit', () => {
  it('edit, select another element, select it again: its value, "Was:" the original, Save updates the same edit', () => {
    const ed = started();
    const h2 = document.querySelector('h2')!;
    ed.select(h2);
    type($('text')!, 'One 123');
    click($('save')!);
    const id = picks().at(-1).id;
    expect(h2.textContent).toBe('One 123');
    ed.select(document.querySelector('p')!);
    click($('cancel')!);
    h2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(textValue()).toBe('One 123');
    expect($('fields')!.textContent).toContain('Was: "One"');
    expect($('title')!.textContent).toBe('Heading "One"');
    type($('text')!, 'One 456');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ id, value: 'One 456', text: 'One' });
    expect(ed.editList()).toHaveLength(1);
  });

  it('arrow up / down onto an edited element opens its edit', () => {
    const ed = started();
    const h2 = document.querySelectorAll('h2')[1];
    ed.select(h2);
    type($('text')!, 'Two!');
    click($('save')!);
    ed.select(document.querySelectorAll('section')[1]);
    expect($('action-text')!.getAttribute('aria-checked')).toBe('true');
    key('ArrowDown');
    expect(textValue()).toBe('Two!');
    expect($('fields')!.textContent).toContain('Was: "Two"');
  });

  it('an edit from the dashboard opens on a click, with its fallback, and saves under its id', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'e1', selector: 'section:nth-of-type(1) h2', operation: 'replace_text', value: 'Hi {{ user.firstName | default: "you" }}' }] });
    const h2 = document.querySelector('h2')!;
    expect(h2.textContent).toBe('Hi you');
    ed.select(h2);
    expect(textValue()).toBe('Hi {{ user.firstName | default: "you" }}');
    expect(pills()[0].textContent).toBe('firstName · you');
    expect($('fields')!.textContent).toContain('Was: "One"');
    setPillFallback(0, 'there');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ id: 'e1', value: 'Hi {{ user.firstName | default: "there" }}' });
    expect(ed.editList()).toHaveLength(1);
  });

  it('an element with several edits opens the latest; its tiles switch between them, a new kind is a new edit', () => {
    const ed = started();
    const btn = document.querySelector('[data-testid=buy]') as HTMLElement;
    ed.select(btn);
    type($('text')!, 'Buy now');
    click($('save')!);
    const textId = picks().at(-1).id;
    ed.select(btn);
    click($('action-slot')!);
    type($('slot-name')!, 'promo');
    click($('save')!);
    const slotId = picks().at(-1).id;
    expect(slotId).not.toBe(textId);
    expect(ed.editList()).toHaveLength(2); // the text edit was kept
    ed.select(btn);
    expect($('action-slot')!.getAttribute('aria-checked')).toBe('true');
    expect(($('slot-name') as HTMLInputElement).value).toBe('promo');
    expect($('action-text')!.hasAttribute('data-e')).toBe(true);
    expect($('action-hide')!.hasAttribute('data-e')).toBe(false);
    click($('action-text')!);
    expect(textValue()).toBe('Buy now');
    type($('text')!, 'Buy today');
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ id: textId, operation: 'replace_text', value: 'Buy today', text: 'Buy' });
    expect(ed.editList().map((e) => e.id)).toEqual([textId, slotId]);
  });
});

describe('the personalization catalog: a few chips, and "More…" for the rest', () => {
  const catalog = [
    { key: 'user.firstName', label: 'First name', group: 'Profile' },
    { key: 'user.lastName', label: 'Last name', group: 'Profile' },
    { key: 'user.email', label: 'Email', group: 'Profile' },
    { key: 'user.custom.city', label: 'City', group: 'Custom attributes' },
    { key: 'user.custom.loyalty_tier', label: 'Loyalty tier', group: 'Custom attributes' },
    { key: 'user.custom.bad key', label: 'bad key', group: 'x' },
    { key: 'user.custom.favorite_color', label: 'צבע אהוב', group: 'Custom attributes' },
  ];
  const open = async (attributes: unknown[], dir = 'ltr') => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes, dir });
    ed.select(document.querySelector('h2')!);
    type($('text')!, 'Hi');
    return ed;
  };
  const keydown = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('the older { name, custom } shape still works, with no More button for a short list', async () => {
    await open([{ name: 'firstName' }, { name: 'city', custom: true }]);
    expect($$('chip').map((c) => c.textContent)).toEqual(['firstName', 'city']);
    expect($('more')).toBeNull();
    click($$('chip')[1]);
    expect(textValue()).toBe('Hi {{ user.custom.city }}');
  });

  it('the catalog shape: the common fields as chips (labels), the rest grouped and searchable', async () => {
    await open(catalog);
    expect($$('chip').map((c) => c.textContent)).toEqual(['First name', 'Last name', 'Email', 'City']);
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
    click($('more')!);
    expect(($('var-picker') as HTMLElement).hidden).toBe(false);
    expect($('more')!.getAttribute('aria-expanded')).toBe('true');
    const list = $('var-list')!;
    expect(Array.from(list.children).map((c) => c.textContent)).toEqual([
      'Profile',
      'First nameuser.firstName',
      'Last nameuser.lastName',
      'Emailuser.email',
      'Custom attributes',
      'Cityuser.custom.city',
      'Loyalty tieruser.custom.loyalty_tier',
      'צבע אהובuser.custom.favorite_color',
    ]); // the invalid key was dropped
    type($('var-search')!, 'loyal');
    expect($$('var-option').map((o) => o.textContent)).toEqual(['Loyalty tieruser.custom.loyalty_tier']);
    type($('var-search')!, 'zzz');
    expect($('var-list')!.textContent).toBe('No matching fields');
  });

  it('inserting from the picker gives the same Liquid as a chip, as a pill with the label', async () => {
    await open(catalog);
    click($$('chip')[3]);
    const viaChip = textValue();
    type($('text')!, 'Hi');
    click($('more')!);
    type($('var-search')!, 'city');
    click($$('var-option')[0]);
    expect(textValue()).toBe(viaChip);
    expect(textValue()).toBe('Hi {{ user.custom.city }}');
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
    expect($('text')!.querySelector('[data-liquid]')!.textContent).toBe('City');
    // The page preview's pill shows the label too.
    const pill = document.querySelector('h2 joryio-editor-preview') as HTMLElement;
    expect(pill.shadowRoot!.querySelector('.v')!.textContent).toBe('City');
  });

  it('the keyboard: down / up move, Enter inserts, Esc closes the picker and not the panel; RTL', async () => {
    await open(catalog, 'rtl');
    click($('more')!);
    const search = $('var-search')!;
    keydown(search, 'ArrowDown');
    keydown(search, 'ArrowDown');
    expect($$('var-option')[2].getAttribute('aria-selected')).toBe('true');
    expect(search.getAttribute('aria-activedescendant')).toBe('jv2');
    keydown(search, 'ArrowUp');
    keydown(search, 'Enter');
    expect(textValue()).toBe('Hi {{ user.lastName }}');
    click($('more')!);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
    expect($('panel')).not.toBeNull();
    // RTL: the labels follow their own direction, the paths stay left-to-right.
    click($('more')!);
    const opt = $$('var-option').filter((o) => o.textContent!.startsWith('צבע'))[0];
    expect(opt.querySelector('span')!.getAttribute('dir')).toBe('auto');
    expect(opt.querySelector('code')!.getAttribute('dir')).toBe('ltr');
    expect(editor!.root!.querySelector('.r')!.getAttribute('dir')).toBe('rtl');
  });
});

describe('each variable has its own fallback (a click on its pill)', () => {
  const open = async (ctx: Record<string, unknown> = {}) => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }, { name: 'city', custom: true }], ...ctx });
    ed.select(document.querySelector('h2')!);
    return ed;
  };

  it('the panel has no single "If a value is missing" field; a pill opens "If <field> is missing" for that variable only', async () => {
    await open();
    type($('text')!, 'Hi');
    expect($('fallback')).toBeNull();
    click($$('chip')[0]);
    click($$('chip')[1]);
    expect($('fallback')).toBeNull(); // nothing until a pill is clicked
    click(pills()[1]);
    expect($('fallback-pop')!.getAttribute('role')).toBe('dialog');
    expect($('fallback-pop')!.textContent).toContain('If city is missing');
    type($('fallback')!, 'your city');
    expect(textValue()).toBe('Hi {{ user.firstName }} {{ user.custom.city | default: "your city" }}');
    expect(pills().map((p) => p.textContent)).toEqual(['firstName', 'city · your city']);
  });

  it('two variables, two different fallbacks; the Liquid is the dashboard format', async () => {
    await open();
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    click($$('chip')[1]);
    setPillFallback(0, 'friend');
    setPillFallback(1, 'your town');
    expect(textValue()).toBe('Hi {{ user.firstName | default: "friend" }} {{ user.custom.city | default: "your town" }}');
    // Clearing one removes only that default.
    setPillFallback(0, '');
    expect(textValue()).toBe('Hi {{ user.firstName }} {{ user.custom.city | default: "your town" }}');
    click($('save')!);
    expect(picks().at(-1).value).toBe('Hi {{ user.firstName }} {{ user.custom.city | default: "your town" }}');
  });

  it('an existing edit loads each default on its own pill (the old single field wrote it on one variable)', async () => {
    const ed = started();
    const old = 'Hi {{ user.firstName | default: "you" }}, from {{ user.custom.city }}';
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'e1', selector: 'section:nth-of-type(1) h2', operation: 'replace_text', value: old }] });
    ed.select(document.querySelector('h2')!);
    expect(textValue()).toBe(old); // byte for byte
    expect(pills().map((p) => p.textContent)).toEqual(['firstName · you', 'city']);
    click(pills()[0]);
    expect(($('fallback') as HTMLInputElement).value).toBe('you');
  });

  it('quotes: "..." by default, \'...\' around a double quote, both kinds keep the text (apostrophe as U+2019)', async () => {
    expect(quoted('friend')).toBe('"friend"');
    expect(quoted('the "best"')).toBe("'the \"best\"'");
    expect(quoted('it\'s "ok"')).toBe('\'it’s "ok"\'');
    await open();
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    setPillFallback(0, 'my "friend"');
    expect(textValue()).toBe("Hi {{ user.firstName | default: 'my \"friend\"' }}");
    expect(pills()[0].textContent).toBe('firstName · my "friend"');
    // The pill box still reads it back as one pill.
    click($('liquid-toggle')!);
    expect(pills()).toHaveLength(1);
  });

  it('a fallback with Liquid in it is refused, the text keeps the last plain one', async () => {
    expect(isPlainFallback('friend')).toBe(true);
    expect(isPlainFallback('{{ user.x }}')).toBe(false);
    expect(isPlainFallback('{% if %}')).toBe(false);
    await open();
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    setPillFallback(0, 'pal');
    type($('fallback')!, 'pal {{ user.email }}');
    expect($('fallback-error')!.textContent).toBe('Plain text only - no Liquid here.');
    expect(textValue()).toBe('Hi {{ user.firstName | default: "pal" }}');
  });

  it('Esc closes the popover and not the panel; Enter closes it; Enter on a focused pill opens it', async () => {
    await open();
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    click(pills()[0]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect($('fallback-pop')).toBeNull();
    expect($('panel')).not.toBeNull();
    const p = pills()[0];
    expect(p.getAttribute('tabindex')).toBe('0');
    expect(p.getAttribute('role')).toBe('button');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect($('fallback-pop')).not.toBeNull();
    $('fallback')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect($('fallback-pop')).toBeNull();
  });

  it('RTL: the popover is in the panel flow, its input follows the text direction', async () => {
    await open({ dir: 'rtl', strings: { fallbackFor: 'אם {name} חסר' } });
    type($('text')!, 'שלום');
    click($$('chip')[0]);
    click(pills()[0]);
    expect($('fallback-pop')!.textContent).toContain('אם firstName חסר');
    expect($('fallback')!.getAttribute('dir')).toBe('auto');
    expect($('text-box')!.contains($('fallback-pop'))).toBe(true);
  });

  it('the live preview: each variable its own sample, else its own fallback, else the placeholder pill', async () => {
    expect(previewText('{{ user.firstName | default: "a" }} {{ user.lastName | default: "b" }} {{ user.custom.city }}', { 'user.firstName': 'Lior' })).toBe('Lior b [city]');
    await open({ sample: { 'user.firstName': 'Lior' } });
    const h2 = document.querySelector('h2')!;
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    click($$('chip')[1]);
    setPillFallback(1, 'there');
    expect(h2.textContent).toBe('Hi Lior there');
    setPillFallback(0, 'friend'); // a sample beats the fallback
    expect(h2.textContent).toBe('Hi Lior there');
    setPillFallback(1, '');
    expect(h2.textContent).toBe('Hi Lior '); // city: neither sample nor fallback - a pill (not page text)
    expect(h2.querySelectorAll('joryio-editor-preview[data-joryio-editor="var"]')).toHaveLength(1);
  });
});

describe('a saved content slot: its campaigns, or "Create content for this slot"', () => {
  const openSlots = () => posted.map((p) => p.msg).filter((m) => m.type === EDITOR_SESSION_MESSAGES.OPEN_SLOT);
  const addSlot = (ed: VisualEditor, name: string) => {
    ed.select(document.querySelector('#hero') as HTMLElement);
    click($('action-slot')!);
    type($('slot-name')!, name);
    click($('save')!);
  };

  it('a slot with no campaign: the button, and a click posts { placementKey } and focuses the dashboard', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, openSlot: true, placements: [{ key: 'home_hero', name: 'Home hero', campaigns: [] }] });
    addSlot(ed, 'After Blog');
    expect(picks().at(-1)).toMatchObject({ operation: 'insert_placement', placementKey: 'after_blog' });
    // The panel stays open on the saved slot.
    expect($('panel')).not.toBeNull();
    expect($('slot-create')!.textContent).toBe('Create content for this slot →');
    expect($('slot-campaign')).toBeNull();
    click($('slot-create')!);
    expect(openSlots()).toEqual([{ type: 'joryio:editor-open-slot', placementKey: 'after_blog' }]);
    expect(posted.at(-1)!.origin).toBe(DASHBOARD);
    expect(opener.focus).toHaveBeenCalled();
  });

  it('a slot with campaigns: "In this slot: <name> (status)", each opens its campaign; "+ Add another campaign"', async () => {
    const ed = started();
    await deliver({
      type: EDITOR_SESSION_MESSAGES.CONTEXT,
      openSlot: true,
      placements: [{ key: 'home_hero', campaigns: [{ id: 'c-1', name: 'Winter sale', status: 'active', statusLabel: 'Active' }, { id: 'c-2', name: 'Draft promo', status: 'draft' }, { id: 'bad id!', name: 'x', status: 'x' }] }],
    });
    addSlot(ed, 'home_hero');
    expect($('slot-content')!.textContent).toContain('In this slot:');
    expect($$('slot-campaign').map((b) => b.textContent)).toEqual(['Winter sale (Active)', 'Draft promo (draft)']);
    click($$('slot-campaign')[1]);
    click($('slot-add')!);
    expect(openSlots()).toEqual([
      { type: 'joryio:editor-open-slot', placementKey: 'home_hero', campaignId: 'c-2' },
      { type: 'joryio:editor-open-slot', placementKey: 'home_hero' },
    ]);
  });

  it('opening an existing slot edit shows the same; the key as saved, not as being typed', async () => {
    const ed = started();
    await deliver({
      type: EDITOR_SESSION_MESSAGES.CONTEXT,
      openSlot: true,
      edits: [{ id: 'e9', selector: '#hero', operation: 'insert_placement', placementKey: 'home_hero', position: 'after' }],
      placements: [{ key: 'home_hero', campaigns: [{ id: 'c-1', name: 'Winter sale', status: 'active' }] }],
    });
    ed.select(document.querySelector('#hero') as HTMLElement);
    expect($$('slot-campaign').map((b) => b.textContent)).toEqual(['Winter sale (active)']);
    type($('slot-name')!, 'other');
    click($$('slot-campaign')[0]);
    expect(openSlots().at(-1)).toEqual({ type: 'joryio:editor-open-slot', placementKey: 'home_hero', campaignId: 'c-1' });
  });

  it('a new, unsaved slot shows nothing yet', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, openSlot: true });
    ed.select(document.querySelector('#hero') as HTMLElement);
    click($('action-slot')!);
    type($('slot-name')!, 'promo');
    expect($('slot-content')).toBeNull();
  });

  it('the older context (beta.6 dashboard: placements without campaigns, no openSlot): the slot saves and closes as before, no shortcut', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, placements: [{ key: 'home_hero', name: 'Home hero' }] });
    expect($('slot-name')).toBeNull();
    ed.select(document.querySelector('#hero') as HTMLElement);
    click($('action-slot')!);
    expect($$('placement').map((c) => c.textContent)).toEqual(['home_hero']); // the chips still work
    click($$('placement')[0]);
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ placementKey: 'home_hero' });
    expect($('panel')).toBeNull();
    ed.select(document.querySelector('#hero') as HTMLElement);
    expect($('slot-content')).toBeNull();
    expect(ed.openSlot('home_hero')).toBe(false);
    expect(openSlots()).toEqual([]);
  });
});

describe('Desktop / Mobile and per-device edits (1.4.0-beta.8)', () => {
  const h2 = () => document.querySelector('main > section:nth-of-type(1) > h2')!;
  /**
   * The frame's page as loaded: a same-origin document. jsdom gives an iframe
   * in a shadow root no browsing context (browsers do), so the test hands the
   * frame its document and window, then fires its load.
   */
  const loadFrame = (frame: HTMLIFrameElement, html: string) => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;
    Object.defineProperty(doc, 'URL', { configurable: true, value: 'https://shop.example/products/shoes?joryio_editor=frame' });
    const win = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => doc });
    Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => win });
    frame.dispatchEvent(new Event('load'));
    return doc;
  };
  const openMobile = (ed: VisualEditor, html = '<main><section><h2>Small one</h2></section><a href="/m">M</a></main>') => {
    ed.setView('mobile');
    const frame = $('frame') as HTMLIFrameElement;
    return { frame, doc: loadFrame(frame, html) };
  };

  it('the dock has the Desktop / Mobile toggle, Desktop on', () => {
    started();
    expect($('view-desktop')!.getAttribute('aria-checked')).toBe('true');
    expect($('view-mobile')!.getAttribute('aria-checked')).toBe('false');
    expect($('view-mobile')!.getAttribute('aria-label')).toBe('Mobile');
  });

  it('"Applies to" defaults to All devices; Mobile only is sent as device, badged in the list, and not previewed in Desktop', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT });
    ed.select(h2());
    expect($('device-all')!.getAttribute('aria-checked')).toBe('true');
    type($('text')!, 'Phones only');
    expect(h2().textContent).toBe('Phones only');
    click($('device-mobile')!);
    expect($('device-mobile')!.getAttribute('aria-checked')).toBe('true');
    expect(h2().textContent).toBe('One'); // a Mobile-only edit is not drawn in the Desktop view
    expect($('device-hidden')!.textContent).toBe(EDITOR_STRINGS.deviceHidden);
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ operation: 'replace_text', value: 'Phones only', device: 'mobile' });
    expect(ed.editList()[0]).toMatchObject({ device: 'mobile' });
    click($('edits')!);
    expect($$('device-badge').map((b) => b.textContent)).toEqual(['Mobile only']);
  });

  it('the context edits keep their device; the Desktop view previews All and Desktop-only, never Mobile-only', async () => {
    const ed = started();
    await deliver({
      type: EDITOR_SESSION_MESSAGES.CONTEXT,
      edits: [
        { id: 'd1', selector: 'main > section:nth-of-type(1) > h2', operation: 'replace_text', value: 'Big screens', device: 'desktop' },
        { id: 'm1', selector: 'main > section:nth-of-type(1) > h2', operation: 'replace_text', value: 'Small screens', device: 'mobile' },
        { id: 'x1', selector: 'a', operation: 'hide', device: 'tablet' },
      ],
    });
    expect(ed.editList().map((e) => [e.id, e.device])).toEqual([
      ['d1', 'desktop'],
      ['m1', 'mobile'],
    ]);
    expect(h2().textContent).toBe('Big screens');
    // Selecting the element opens the edit of this view (the desktop one), not the latest overall.
    ed.select(h2());
    expect($('device-desktop')!.getAttribute('aria-checked')).toBe('true');
    expect(textValue()).toBe('Big screens');
  });

  it('Undo of a device change sends the edit back with its old device, never without one', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'e1', selector: 'main > section:nth-of-type(1) > h2', operation: 'replace_text', value: 'Hello' }] });
    ed.select(h2());
    click($('device-mobile')!);
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ id: 'e1', device: 'mobile' });
    ed.undo();
    expect(picks().at(-1)).toMatchObject({ id: 'e1', value: 'Hello', device: 'all' });
  });

  it('Mobile: the page at phone width in a same-origin frame flagged for the inert SDK; the editor edits the frame', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'd1', selector: 'h2', operation: 'replace_text', value: 'Desktop words', device: 'desktop' }] });
    expect(document.querySelector('main > section > h2')!.textContent).toBe('Desktop words');
    const { frame, doc } = openMobile(ed);
    expect(ed.currentView()).toBe('mobile');
    expect($('view-mobile')!.getAttribute('aria-checked')).toBe('true');
    expect(new URL(frame.getAttribute('src')!).searchParams.get('joryio_editor')).toBe('frame');
    expect($('stage')).not.toBeNull();
    // The tab's own page is left as the site drew it; the desktop-only edit is not in the frame.
    expect(document.querySelector('main > section > h2')!.textContent).toBe('One');
    expect(doc.querySelector('h2')!.textContent).toBe('Small one');
    // A click in the frame selects there (and never reaches the site).
    const heading = doc.querySelector('h2')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    heading.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect($('panel')).not.toBeNull();
    // In Mobile view "Applies to" comes first.
    expect($('fields')!.parentElement!.firstElementChild!.getAttribute('data-j')).toBe('applies-to');
    type($('text')!, 'Tap here');
    expect(heading.textContent).toBe('Tap here'); // the live preview is in the frame
    click($('device-mobile')!);
    click($('save')!);
    expect(picks().at(-1)).toMatchObject({ selector: 'body > main > section > h2', value: 'Tap here', device: 'mobile' });
    expect(heading.textContent).toBe('Tap here');
    // Back to Desktop: the frame goes, the tab's page shows its desktop edit again, the mobile one does not.
    click($('view-desktop')!);
    expect($('frame')).toBeNull();
    expect(document.querySelector('main > section > h2')!.textContent).toBe('Desktop words');
  });

  it('a jump to a Mobile-only edit from the Desktop list opens the Mobile view on it', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'm1', selector: 'body > main > section > h2', operation: 'replace_text', value: 'Tiny', device: 'mobile' }] });
    expect(ed.focusEdit('m1')).toBe(true);
    expect(ed.currentView()).toBe('mobile');
    const doc = loadFrame($('frame') as HTMLIFrameElement, '<main><section><h2>Small one</h2></section></main>');
    expect(doc.querySelector('h2')!.textContent).toBe('Tiny');
    expect($('panel')).not.toBeNull();
    expect($('device-mobile')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a site that refuses to be framed: a note in place of the frame, nothing edited in the tab', async () => {
    const ed = started();
    ed.setView('mobile');
    const frame = $('frame') as HTMLIFrameElement;
    // The browser's own error page (X-Frame-Options / frame-ancestors): no readable document.
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null });
    frame.dispatchEvent(new Event('load'));
    expect($('frame-blocked')!.textContent).toBe(EDITOR_STRINGS.frameBlocked);
    click(document.querySelector('main > section > h2')!);
    expect($('panel')).toBeNull();
    click($('view-desktop')!);
    expect($('frame-blocked')).toBeNull();
  });

  it('stop in Mobile view removes the frame with every other trace', () => {
    const ed = started();
    openMobile(ed);
    ed.stop();
    editor = null;
    expect(document.querySelector('[data-joryio-editor]')).toBeNull();
  });
});

describe('popovers close on an outside press; the list never hides its first row (beta.7 report)', () => {
  const catalog = [
    { key: 'user.firstName', label: 'First name', group: 'Profile' },
    { key: 'user.lastName', label: 'Last name', group: 'Profile' },
    { key: 'user.email', label: 'Email', group: 'Profile' },
    { key: 'user.custom.city', label: 'City', group: 'Custom attributes' },
    { key: 'user.custom.loyalty_tier', label: 'Loyalty tier', group: 'Custom attributes' },
  ];
  const h2 = () => document.querySelector('main > section:nth-of-type(1) > h2')!;
  const press = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
  const open = async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: catalog });
    ed.select(h2());
    type($('text')!, 'Hi');
    click($('more')!);
    expect(($('var-picker') as HTMLElement).hidden).toBe(false);
    return ed;
  };

  it('"More…" closes on a press elsewhere in the panel, and stays open for a press inside it', async () => {
    await open();
    press($('var-search')!);
    expect(($('var-picker') as HTMLElement).hidden).toBe(false);
    press($('title')!);
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
    expect($('more')!.getAttribute('aria-expanded')).toBe('false');
    expect($('panel')).not.toBeNull();
  });

  it('a click on the page while it is open only closes it: nothing else is selected, the draft stays', async () => {
    const ed = await open();
    const other = document.querySelector('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    other.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // never reaches the site
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
    expect($('title')!.textContent).toContain('Heading');
    expect(textValue()).toBe('Hi');
    // The next click selects as usual.
    click(other);
    expect($('title')!.textContent).toContain('Link');
    expect(ed.isActive()).toBe(true);
  });

  it('focus leaving the picker closes it', async () => {
    await open();
    $('var-picker')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: $('text') }));
    expect(($('var-picker') as HTMLElement).hidden).toBe(true);
  });

  it('a pill fallback popover closes on a press outside it too', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }] });
    ed.select(h2());
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    click(pills()[0]);
    expect($('fallback-pop')).not.toBeNull();
    press($('fallback')!);
    expect($('fallback-pop')).not.toBeNull();
    press($('title')!);
    expect($('fallback-pop')).toBeNull();
  });

  it('the list opens at its top (the first group heading and row visible) and scrolls inside itself only', async () => {
    await open();
    const list = $('var-list')!;
    expect(list.scrollTop).toBe(0);
    expect(list.firstElementChild!.textContent).toBe('Profile');
    // Geometry jsdom does not lay out: rows 30px, a heading 20px, a 100px list scrolled to 70.
    const rows = Array.from(list.children) as HTMLElement[];
    let y = 0;
    for (const r of rows) {
      const hgt = r.getAttribute('role') === 'presentation' ? 20 : 30;
      Object.defineProperty(r, 'offsetTop', { configurable: true, value: y });
      Object.defineProperty(r, 'offsetHeight', { configurable: true, value: hgt });
      y += hgt;
    }
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
    list.scrollTop = 70;
    revealOption(list, rows[1]); // the first option: its heading comes back into view too
    expect(list.scrollTop).toBe(0);
    revealOption(list, rows[6]); // "Loyalty tier" (offset 160, 30 high): its bottom edge at the list's bottom
    expect(list.scrollTop).toBe(90);
  });
});

describe('a placeholder pill on the page (beta.7 report: a click on it removed the variable)', () => {
  const h2 = () => document.querySelector('main > section:nth-of-type(1) > h2')!;
  const pagePill = () => h2().querySelector('[data-joryio-editor="var"]') as HTMLElement;
  const clickPage = (el: Element) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  it('while its edit is open: the text keeps its Liquid, and the pill fallback popover opens', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }] });
    ed.select(h2());
    type($('text')!, 'היי');
    click($$('chip')[0]);
    expect(textValue()).toBe('היי {{ user.firstName }}');
    expect(pagePill().getAttribute('data-path')).toBe('user.firstName');
    expect(clickPage(pagePill()).defaultPrevented).toBe(true);
    expect(textValue()).toBe('היי {{ user.firstName }}');
    expect($('fallback-pop')).not.toBeNull();
    expect($('fallback-pop')!.textContent).toContain('If firstName is missing');
    expect(h2().querySelector('[data-joryio-editor="var"]')).not.toBeNull();
  });

  it('with the panel closed: it opens that element saved edit, unchanged, with the fallback popover', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, edits: [{ id: 'e1', selector: 'main > section:nth-of-type(1) > h2', operation: 'replace_text', value: 'Hi {{ user.firstName }}' }] });
    expect($('panel')).toBeNull();
    clickPage(pagePill());
    expect($('panel')).not.toBeNull();
    expect(textValue()).toBe('Hi {{ user.firstName }}');
    expect($('fallback-pop')).not.toBeNull();
    expect(ed.editList()[0].value).toBe('Hi {{ user.firstName }}');
    expect(picks()).toEqual([]);
  });

  it('a pill in the panel field opens its popover and never deletes it', async () => {
    const ed = started();
    await deliver({ type: EDITOR_SESSION_MESSAGES.CONTEXT, attributes: [{ name: 'firstName' }] });
    ed.select(h2());
    type($('text')!, 'Hi');
    click($$('chip')[0]);
    click(pills()[0]);
    expect($('fallback-pop')).not.toBeNull();
    expect(textValue()).toBe('Hi {{ user.firstName }}');
  });

  it('text read from the page never includes the editor previews in it', () => {
    const el = document.createElement('h3');
    el.appendChild(document.createTextNode('Hi '));
    const pill = document.createElement('joryio-editor-preview');
    pill.setAttribute('data-joryio-editor', 'var');
    pill.textContent = 'firstName';
    el.appendChild(pill);
    const note = document.createElement('joryio-editor-preview');
    note.setAttribute('data-joryio-editor', 'preview');
    note.textContent = 'Content slot';
    el.appendChild(note);
    expect(shortText(el)).toBe('Hi');
    expect(el.childNodes).toHaveLength(3); // the page itself is untouched
  });
});
