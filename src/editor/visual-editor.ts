/**
 * The point-and-click picker (BACKLOG D444 Phase 4,
 * docs/PLACEMENTS_WEBSITE_LAYER.md 3) - the body of `joryio-editor.min.js`.
 *
 * The handshake lives in the core bundle (src/core/editor-gate.ts): this
 * file is loaded, and this class constructed, only once the server vouched
 * for the editor token, with the dashboard origin the token names. From then
 * on it accepts messages only from that origin and that opener window, and
 * posts only to them. It lets the person point at an element, computes a
 * robust selector, offers the operations that fit, and posts
 * `joryio:editor-pick` back.
 *
 * It reads the page the person already sees and writes nothing to it but its
 * own highlight and panel (built from text nodes, never HTML). No free-form
 * DOM editing: a pick is a selector + one of the five page-edit operations.
 */
import type { Logger } from '../utils/logger';
import { isSafeSelector, isSafeEditUrl, type PageEditOperation } from '../core/page-edits';
import { EDITOR_MESSAGES } from '../core/editor-gate';

export { EDITOR_MESSAGES };

/** Attributes that name an element on purpose, most stable first. */
const NAMING_ATTRIBUTES = ['data-joryio-id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name'];
const PLACEMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;

/** CSS.escape, for browsers (and test DOMs) without it. */
export function cssEscape(value: string): string {
  const css = (globalThis as any).CSS;
  if (css && typeof css.escape === 'function') return css.escape(value);
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const code = value.charCodeAt(i);
    if (code === 0) out += '\uFFFD';
    else if (/[0-9]/.test(ch) && (i === 0 || (i === 1 && value[0] === '-'))) out += `\\${code.toString(16)} `;
    else if (/[A-Za-z0-9_-]/.test(ch) || code >= 0x80) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

const unique = (doc: Document, selector: string, el: Element): boolean => {
  try {
    const hits = doc.querySelectorAll(selector);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
};

/** An id that looks generated (long digit runs, framework hashes) changes between builds; skip it. */
const stableId = (id: string) => !!id && id.length <= 64 && !/\d{4,}/.test(id) && !/^(ember|react|radix|headlessui|mui)[-_:]/i.test(id) && !/:/.test(id);

/**
 * A selector that finds this element and only it, preferring what the site
 * named on purpose: an id, then a naming data attribute, then a path of
 * tag + nth-of-type from the nearest named ancestor (or the body).
 */
export function robustSelector(el: Element): string | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const named = (node: Element): string | null => {
    if (stableId(node.id)) {
      const s = `#${cssEscape(node.id)}`;
      if (unique(doc, s, node)) return s;
    }
    for (const attr of NAMING_ATTRIBUTES) {
      const v = node.getAttribute(attr);
      if (!v || v.length > 100) continue;
      const s = `${node.tagName.toLowerCase()}[${attr}="${v.replace(/["\\]/g, '\\$&')}"]`;
      if (unique(doc, s, node)) return s;
    }
    return null;
  };
  const own = named(el);
  if (own) return isSafeSelector(own) ? own : null;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== doc.body && node !== doc.documentElement) {
    const anchor = parts.length ? named(node) : null;
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    node = parent;
    if (node === doc.body) parts.unshift('body');
  }
  const selector = parts.join(' > ');
  return selector && isSafeSelector(selector) && unique(doc, selector, el) ? selector : null;
}

/** The operations that fit an element: an image can change its picture, a link its address. */
export function operationsFor(el: Element): PageEditOperation[] {
  const ops: PageEditOperation[] = [];
  if (el.tagName !== 'IMG' && (el.textContent || '').trim()) ops.push('replace_text');
  if (el.tagName === 'IMG') ops.push('replace_image');
  if (el.tagName === 'A') ops.push('replace_link');
  ops.push('hide', 'insert_placement');
  return ops;
}

export interface EditorPick {
  type: typeof EDITOR_MESSAGES.PICK;
  selector: string;
  operation: PageEditOperation;
  value?: string;
  placementKey?: string;
  position?: 'before' | 'after' | 'prepend' | 'append';
  tag: string;
  text: string;
}

export class VisualEditor {
  private listeners: Array<() => void> = [];
  private highlight: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private selected: Element | null = null;
  private active = false;

  constructor(
    private dashboardOrigin: string,
    private opener: Window,
    private logger: Logger,
    private onStop: () => void = () => undefined,
  ) {}

  /** The token was vouched for by the server: show the picker. */
  start(): void {
    if (this.active) return;
    this.active = true;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (!data || typeof data.type !== 'string') return;
      if (e.origin !== this.dashboardOrigin || e.source !== this.opener) return;
      if (data.type === EDITOR_MESSAGES.CLOSE) this.stop();
    };
    window.addEventListener('message', onMessage);
    this.listeners.push(() => window.removeEventListener('message', onMessage));
    this.activate();
  }

  isActive(): boolean {
    return this.active;
  }

  stop(): void {
    if (!this.active) return;
    this.send({ type: EDITOR_MESSAGES.CLOSED });
    this.active = false;
    for (const off of this.listeners.splice(0)) off();
    this.highlight?.remove();
    this.panel?.remove();
    this.highlight = this.panel = null;
    this.selected = null;
    try {
      this.onStop();
    } catch (error) {
      this.logger.debug('Joryio editor stop callback failed', error);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.active) return;
    try {
      this.opener.postMessage(message, this.dashboardOrigin);
    } catch {
      /* the dashboard tab closed */
    }
  }

  private activate(): void {
    const doc = document;
    const highlight = doc.createElement('div');
    highlight.setAttribute('data-joryio-editor', 'highlight');
    highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #14b8a6;background:rgba(20,184,166,.12);border-radius:3px;display:none';
    const panel = doc.createElement('div');
    panel.setAttribute('data-joryio-editor', 'panel');
    panel.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:560px;margin:0 auto;background:#0f172a;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3)';
    panel.textContent = 'Joryio editor - click an element on the page. Esc to finish.';
    doc.body.appendChild(highlight);
    doc.body.appendChild(panel);
    this.highlight = highlight;
    this.panel = panel;
    const inEditor = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-joryio-editor]');
    const onMove = (e: MouseEvent) => {
      if (this.selected || inEditor(e.target)) return;
      this.outline(e.target instanceof Element ? e.target : null);
    };
    const onClick = (e: MouseEvent) => {
      if (inEditor(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target instanceof Element) this.select(e.target);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.selected ? this.unselect() : this.stop();
    };
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    this.listeners.push(
      () => doc.removeEventListener('mousemove', onMove, true),
      () => doc.removeEventListener('click', onClick, true),
      () => doc.removeEventListener('keydown', onKey, true),
    );
    this.send({ type: EDITOR_MESSAGES.ACTIVE, url: `${location.origin}${location.pathname}` });
  }

  private outline(el: Element | null): void {
    if (!this.highlight) return;
    if (!el || el === document.body || el === document.documentElement) {
      this.highlight.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(this.highlight.style, { display: 'block', top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  private unselect(): void {
    this.selected = null;
    if (this.panel) this.panel.textContent = 'Joryio editor - click an element on the page. Esc to finish.';
  }

  /** The element is chosen: its selector and the operations that fit it, as buttons. */
  select(el: Element): void {
    const selector = robustSelector(el);
    if (!this.panel) return;
    if (!selector) {
      this.panel.textContent = 'This element has no stable selector. Choose its parent or another element.';
      return;
    }
    this.selected = el;
    this.outline(el);
    const panel = this.panel;
    panel.textContent = '';
    const line = (text: string, mono = false) => {
      const p = document.createElement('div');
      p.textContent = text;
      if (mono) p.style.cssText = 'font-family:ui-monospace,monospace;font-size:12px;opacity:.8;word-break:break-all;margin:4px 0 8px';
      panel.appendChild(p);
    };
    line(`<${el.tagName.toLowerCase()}> ${(el.textContent || '').trim().slice(0, 60)}`);
    line(selector, true);
    const input = document.createElement('input');
    input.setAttribute('data-joryio-editor', 'value');
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:0;margin-bottom:8px;color:#0f172a';
    input.placeholder = 'New text, https:// address or placement key';
    panel.appendChild(input);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
    const labels: Record<PageEditOperation, string> = {
      replace_text: 'Replace text',
      replace_image: 'Replace image',
      replace_link: 'Replace link',
      hide: 'Hide',
      insert_placement: 'Insert placement after',
    };
    for (const op of operationsFor(el)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = labels[op];
      b.setAttribute('data-joryio-op', op);
      b.style.cssText = 'padding:6px 10px;border-radius:6px;border:0;background:#14b8a6;color:#fff;cursor:pointer';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pick(el, selector, op, input.value.trim());
      });
      row.appendChild(b);
    }
    panel.appendChild(row);
  }

  /** Validate like the server does, then hand the pick to the dashboard. */
  pick(el: Element, selector: string, operation: PageEditOperation, value: string): boolean {
    const base: EditorPick = { type: EDITOR_MESSAGES.PICK, selector, operation, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 200) };
    let msg: EditorPick | null = null;
    if (operation === 'hide') msg = base;
    else if (operation === 'replace_text') msg = value || base.text ? { ...base, value: (value || base.text).slice(0, 2000) } : null;
    else if (operation === 'replace_image' || operation === 'replace_link') msg = isSafeEditUrl(value) ? { ...base, value } : null;
    else if (operation === 'insert_placement') msg = PLACEMENT_KEY_PATTERN.test(value) ? { ...base, placementKey: value, position: 'after' } : null;
    if (!msg) {
      if (this.panel) {
        const warn = document.createElement('div');
        warn.style.cssText = 'margin-top:6px;color:#fca5a5';
        warn.textContent =
          operation === 'insert_placement' ? 'Enter a placement key (lowercase letters, digits, _).' : 'Enter an address starting with https:// (or http://).';
        this.panel.appendChild(warn);
      }
      return false;
    }
    this.send(msg as unknown as Record<string, unknown>);
    this.unselect();
    return true;
  }
}
