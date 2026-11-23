/**
 * The on-site Web personalization editor (BACKLOG D444 Phase 4,
 * docs/PLACEMENTS_WEBSITE_LAYER.md 3) - the body of `joryio-editor.min.js`.
 * Design: design_handoff_web_personalization, screens 1-3 (1.4.0-beta.6).
 *
 * The handshake lives in the core bundle (src/core/editor-gate.ts): this
 * file is loaded, and this class constructed, only once the server vouched
 * for the editor token, with the dashboard origin the token names. From then
 * on it accepts messages only from that origin and that opener window, and
 * posts only to them.
 *
 * What it does on the page:
 * - All of its UI is in ONE shadow root (a closed one, on a host with
 *   `all: initial`): the site's CSS cannot restyle it, its CSS cannot reach
 *   the site. The previews it puts in the page (a content slot, a "hidden for
 *   this audience" note) are custom elements with their own shadow roots,
 *   never a `div`, so they do not shift the site's `:nth-of-type` selectors.
 * - Hover shows a dashed outline with a label ("Heading · h1"); a click
 *   selects (the click never reaches the site); arrow up / down or the
 *   buttons and the breadcrumb ("Page › Main › Heading") move to the element
 *   around it or the first one inside it.
 * - A light side panel: the element, how many elements its selector matches,
 *   "What do you want to do?" (Change text, Change link, Change image, Hide
 *   it, Add content slot), ONE field set per action, a collapsible CSS
 *   selector, Cancel / Save. The New text field shows variables as the
 *   same pills (liquid-field.ts) and stores unchanged Liquid. Selecting an
 *   element that already has an edit opens that edit.
 * - Every edit shows live on the page while editing (the draft too); the
 *   text with the dashboard's sample values for its variables, else their
 *   fallbacks, else a placeholder pill with the field name (a custom element
 *   with its own shadow root, never page text). Text is set with textContent, addresses must be http(s), the
 *   original nodes come back on undo - nothing is ever parsed as HTML.
 * - A dock: campaign · variant · page, the hint, "N edits" (a click jumps to
 *   that edit), Undo, "Save & return to Joryio".
 *
 * Messages (constants: EDITOR_MESSAGES in the core, EDITOR_SESSION_MESSAGES
 * here; the dashboard's copy is packages/frontend/src/lib/web-experience.ts):
 *
 *   editor -> dashboard
 *     joryio:editor-active  { url }                       the editor is up
 *     joryio:editor-pick    { id, selector, operation, value?, placementKey?, position?, tag, text }
 *                           a saved edit; `id` is the edit's id - an id the
 *                           dashboard already has REPLACES that edit
 *     joryio:editor-remove  { id }                        undo of a new edit
 *     joryio:editor-done    {}                            "Save & return to Joryio"
 *     joryio:editor-open-slot { placementKey, campaignId? }
 *                           "Create content for this slot" (no campaignId) or
 *                           a campaign of the slot (its id): the dashboard
 *                           opens that campaign, or a new Placement campaign
 *                           for the slot; sent only to a dashboard that set
 *                           `openSlot` in its context
 *     joryio:editor-closed  {}                            the editor stopped
 *
 *   dashboard -> editor
 *     joryio:editor-context { campaignName?, variantName?, edits?, focusId?,
 *                             attributes?: [{ key, label?, group? } | { name, custom? }],
 *                             placements?: [{ key, name?, campaigns?: [{ id, name, status, statusLabel? }] }],
 *                             openSlot?: true,
 *                             sample?: { "user.firstName": "Lior", ... },
 *                             strings?: { <EDITOR_STRINGS key>: text }, dir?: 'ltr' | 'rtl' }
 *                           the variant's edits (shown live and in "N edits"),
 *                           the words in the marketer's language; enables Undo.
 *                           `campaigns` per placement (1.4.0-beta.7): the
 *                           campaigns that fill that slot, shown on a saved
 *                           slot edit ("In this slot: ..."); `openSlot`: the
 *                           dashboard handles joryio:editor-open-slot. An
 *                           editor before beta.7 ignores both.
 *     joryio:editor-focus   { id }                        jump to that edit
 *     joryio:editor-close   {}                            stop
 *
 * A dashboard that sends no context still works as before this redesign:
 * every save is a pick, the dock counts this session's edits, and Undo stays
 * off (that dashboard would not hear a remove).
 */
import type { Logger } from '../utils/logger';
import { isSafeSelector, isSafeEditUrl, trustedEdit, type PageEditOperation, type PageEditPosition, type PageEditWire } from '../core/page-edits';
import { EDITOR_MESSAGES } from '../core/editor-gate';
import { EDITOR_STRINGS, fill, mergeStrings, type EditorStringKey, type EditorStrings } from './editor-strings';
import { VAR_PATH, kindKey, newEditId, pathTag, previewParts, slugify } from './editor-model';
import { EDITOR_CSS, HOST_STYLE, PREVIEW_CSS, PREVIEW_HOST_STYLE, PREVIEW_VAR_HOST_STYLE, h, icon, type IconName } from './editor-ui';
import { liquidField } from './liquid-field';

export { EDITOR_MESSAGES };

export const EDITOR_SESSION_MESSAGES = {
  CONTEXT: 'joryio:editor-context',
  FOCUS: 'joryio:editor-focus',
  REMOVE: 'joryio:editor-remove',
  DONE: 'joryio:editor-done',
  OPEN_SLOT: 'joryio:editor-open-slot',
} as const;

/** Attributes that name an element on purpose, most stable first. */
const NAMING_ATTRIBUTES = ['data-joryio-id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name'];
const PLACEMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TEXT = 2000;
const MAX_EDITS = 100;
const PREVIEW_TAG = 'joryio-editor-preview';
const OURS = '[data-joryio-editor]';
const HELP_DISMISSED_KEY = 'jry_editor_help_dismissed';

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

const isOurs = (el: Element | null): boolean => !!el && !!el.closest(OURS);
const VAR_PILL = 'var';

/** The page element an event on the page is about: a variable pill in the preview stands for the element it is in. */
function pageTarget(t: EventTarget | null): Element | null {
  let el = t instanceof Element ? t : null;
  if (el && el.getAttribute('data-joryio-editor') === VAR_PILL) el = el.parentElement;
  return el && !isOurs(el) && el !== document.body && el !== document.documentElement ? el : null;
}

/** The page's elements a selector finds - never the editor's own. */
function pageMatches(selector: string): Element[] {
  if (!isSafeSelector(selector)) return [];
  try {
    return Array.from(document.querySelectorAll(selector)).filter((e) => !isOurs(e));
  } catch {
    return [];
  }
}

const unique = (doc: Document, selector: string, el: Element): boolean => {
  try {
    const hits = Array.from(doc.querySelectorAll(selector)).filter((e) => !isOurs(e));
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
  /** The edit's id: new edits get a fresh one, an edit opened from the list keeps its own. */
  id: string;
  selector: string;
  operation: PageEditOperation;
  value?: string;
  placementKey?: string;
  position?: PageEditPosition;
  tag: string;
  text: string;
}

type Action = 'text' | 'link' | 'image' | 'hide' | 'slot';
const ACTIONS: Action[] = ['text', 'link', 'image', 'hide', 'slot'];
const OPERATION_OF: Record<Action, PageEditOperation> = { text: 'replace_text', link: 'replace_link', image: 'replace_image', hide: 'hide', slot: 'insert_placement' };
const ACTION_OF: Record<PageEditOperation, Action> = { replace_text: 'text', replace_link: 'link', replace_image: 'image', hide: 'hide', insert_placement: 'slot' };
const ACTION_LABEL: Record<Action, EditorStringKey> = { text: 'actText', link: 'actLink', image: 'actImage', hide: 'actHide', slot: 'actSlot' };
const ACTION_ICON: Record<Action, IconName> = { text: 'text', link: 'link', image: 'image', hide: 'hide', slot: 'slot' };
const POSITIONS: Array<[PageEditPosition, EditorStringKey]> = [
  ['before', 'posBefore'],
  ['after', 'posAfter'],
  ['replace', 'posReplace'],
  ['prepend', 'posPrepend'],
  ['append', 'posAppend'],
];

interface Draft {
  action: Action;
  text: string;
  url: string;
  slotName: string;
  position: PageEditPosition;
  selector: string;
  /** The edit being changed (opened from the list or the dashboard), null for a new one. */
  editingId: string | null;
  /** A new draft shows on the page only once something was changed (its untouched text would flatten the element's markup). */
  touched: boolean;
}

interface Var {
  path: string;
  label: string;
  group: string;
}

/** The chips shown before "More…": these when the catalog has them, else its first ones. */
const COMMON_VARS = ['user.firstName', 'user.lastName', 'user.email', 'user.custom.city'];
const CHIPS = 4;

interface EditorContext {
  campaignName: string;
  variantName: string;
  /** The personalization catalog: Liquid path, label, group ('' for the old `{ name, custom }` shape). */
  attributes: Var[];
  placements: Array<{ key: string; name: string; campaigns: SlotCampaign[] }>;
  sample: Record<string, string>;
  /** The dashboard handles joryio:editor-open-slot: the slot's campaigns and "Create content for this slot" show. */
  openSlot: boolean;
}

/** A campaign that fills a slot, as the dashboard sent it. */
interface SlotCampaign {
  id: string;
  name: string;
  /** The wire status (`draft`, `active`, ...), and the dashboard's word for it. */
  status: string;
  statusLabel: string;
}
const CAMPAIGN_ID = /^[A-Za-z0-9_-]{1,64}$/;

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const shortText = (el: Element | null): string => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

export class VisualEditor {
  private listeners: Array<() => void> = [];
  private active = false;
  private host: HTMLElement | null = null;
  /** Kept for tests: the shadow root is closed to the page. */
  root: ShadowRoot | null = null;
  private wrap: HTMLElement | null = null;
  private hoverBox: HTMLElement | null = null;
  private selBox: HTMLElement | null = null;
  private dock: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private help: HTMLElement | null = null;
  private hovered: Element | null = null;
  private selected: Element | null = null;
  private draft: Draft | null = null;
  private showCss = false;
  private showLiquid = false;
  /** Closes an open overlay of the panel (the variable picker) on Esc; true when it closed one. */
  private closeOverlay: (() => boolean) | null = null;
  private popOpen = false;
  private edits: PageEditWire[] = [];
  private history: Array<{ id: string; before: PageEditWire | null }> = [];
  /** The dashboard sent a context: it understands remove (Undo) and replace-by-id. */
  private synced = false;
  private t: EditorStrings = { ...EDITOR_STRINGS };
  private dir: 'ltr' | 'rtl' = 'ltr';
  private ctx: EditorContext = { campaignName: '', variantName: '', attributes: [], placements: [], sample: {}, openSlot: false };
  private previewUndo: Array<() => void> = [];
  /** The page's own text / address of an element before any preview, for "Was:". */
  private originals = new WeakMap<Element, { text: string; href: string | null; src: string | null }>();

  constructor(
    private dashboardOrigin: string,
    private opener: Window,
    private logger: Logger,
    private onStop: () => void = () => undefined,
  ) {}

  /** The token was vouched for by the server: show the editor. */
  start(): void {
    if (this.active) return;
    this.active = true;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (!data || typeof data.type !== 'string') return;
      if (e.origin !== this.dashboardOrigin || e.source !== this.opener) return;
      if (data.type === EDITOR_MESSAGES.CLOSE) this.stop();
      else if (data.type === EDITOR_SESSION_MESSAGES.CONTEXT) this.applyContext(data as Record<string, unknown>);
      else if (data.type === EDITOR_SESSION_MESSAGES.FOCUS) this.focusEdit((data as { id?: unknown }).id);
    };
    window.addEventListener('message', onMessage);
    this.listeners.push(() => window.removeEventListener('message', onMessage));
    this.activate();
  }

  isActive(): boolean {
    return this.active;
  }

  /** The edits this editor knows of (the dashboard's, then this session's), in order. */
  editList(): PageEditWire[] {
    return this.edits.slice();
  }

  stop(): void {
    if (!this.active) return;
    this.send({ type: EDITOR_MESSAGES.CLOSED });
    this.active = false;
    for (const off of this.listeners.splice(0)) off();
    this.clearPreview();
    this.host?.remove();
    this.host = this.root = this.wrap = this.hoverBox = this.selBox = this.dock = this.panel = this.help = null;
    this.selected = this.hovered = null;
    this.draft = null;
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

  // ── setup ────────────────────────────────────────────────────────────────

  private activate(): void {
    const doc = document;
    const host = doc.createElement('joryio-editor');
    host.setAttribute('data-joryio-editor', 'root');
    host.setAttribute('style', HOST_STYLE);
    const root = host.attachShadow({ mode: 'closed' });
    root.appendChild(h('style', null, EDITOR_CSS));
    const wrap = h('div', { class: 'r', dir: this.dir });
    this.hoverBox = h('div', { class: 'box', 'data-j': 'hover' });
    this.selBox = h('div', { class: 'box sel', 'data-j': 'selected' });
    wrap.append(this.hoverBox, this.selBox);
    root.appendChild(wrap);
    doc.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.wrap = wrap;

    const onMove = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (isOurs(t) && t!.getAttribute('data-joryio-editor') !== VAR_PILL) return;
      this.hovered = pageTarget(t);
      this.place(this.hoverBox, this.hovered === this.selected ? null : this.hovered, true);
    };
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-joryio-editor="root"]')) return;
      // A click on the page - a preview of ours included - never reaches the site.
      e.preventDefault();
      e.stopPropagation();
      const el = pageTarget(e.target);
      if (el) this.select(el);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.closeOverlay && this.closeOverlay()) return;
        if (this.popOpen) this.togglePop(false);
        else if (this.panel) this.cancel();
        else this.stop();
        return;
      }
      if (isOurs(e.target instanceof Element ? e.target : null)) return; // typing in the panel
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const from = this.selected || this.hovered;
        if (!from) return;
        e.preventDefault();
        e.stopPropagation();
        this.move(e.key === 'ArrowUp' ? 'up' : 'down', from);
      }
    };
    const onScroll = () => {
      this.place(this.hoverBox, this.hovered === this.selected ? null : this.hovered, true);
      this.place(this.selBox, this.selected);
    };
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    this.listeners.push(
      () => doc.removeEventListener('mousemove', onMove, true),
      () => doc.removeEventListener('click', onClick, true),
      () => doc.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('scroll', onScroll, true),
      () => window.removeEventListener('resize', onScroll),
    );
    this.renderDock();
    this.renderHelp();
    this.send({ type: EDITOR_MESSAGES.ACTIVE, url: `${location.origin}${location.pathname}` });
  }

  /** The dashboard's context: words, campaign, the variant's edits (validated like the runtime does). */
  private applyContext(data: Record<string, unknown>): void {
    this.synced = true;
    this.t = mergeStrings(data.strings);
    this.dir = data.dir === 'rtl' ? 'rtl' : 'ltr';
    this.wrap?.setAttribute('dir', this.dir);
    const list = <T>(v: unknown, map: (x: any) => T | null, max: number): T[] =>
      (Array.isArray(v) ? v : [])
        .map(map)
        .filter((x): x is T => x !== null)
        .slice(0, max);
    this.ctx = {
      campaignName: clip(data.campaignName, 120),
      variantName: clip(data.variantName, 60),
      // Both shapes: the catalog's { key, label, group } and the older { name, custom }.
      attributes: list(
        data.attributes,
        (a): Var | null =>
          !a
            ? null
            : typeof a.key === 'string' && VAR_PATH.test(a.key)
              ? { path: a.key, label: clip(a.label, 60) || a.key.split('.').pop()!, group: clip(a.group, 40) }
              : typeof a.name === 'string' && ATTRIBUTE_NAME.test(a.name)
                ? { path: `user.${a.custom === true ? 'custom.' : ''}${a.name}`, label: a.name, group: '' }
                : null,
        400,
      ),
      placements: list(
        data.placements,
        (p) =>
          p && typeof p.key === 'string' && PLACEMENT_KEY_PATTERN.test(p.key)
            ? {
                key: p.key,
                name: clip(p.name, 80),
                campaigns: list(
                  p.campaigns,
                  (c): SlotCampaign | null =>
                    c && typeof c.id === 'string' && CAMPAIGN_ID.test(c.id) ? { id: c.id, name: clip(c.name, 120) || c.id, status: clip(c.status, 30), statusLabel: clip(c.statusLabel, 40) } : null,
                  10,
                ),
              }
            : null,
        200,
      ),
      sample: {},
      openSlot: data.openSlot === true,
    };
    if (data.sample && typeof data.sample === 'object') {
      for (const [k, v] of Object.entries(data.sample as Record<string, unknown>).slice(0, 100)) {
        if (/^user\.[A-Za-z0-9_.]{1,80}$/.test(k) && typeof v === 'string') this.ctx.sample[k] = v.slice(0, 200);
      }
    }
    if (Array.isArray(data.edits)) {
      this.edits = list(data.edits, (e) => trustedEdit(e), MAX_EDITS).map((e) => {
        const { personalized: _p, ...rest } = e;
        return rest;
      });
      this.history = [];
    }
    this.renderPreview();
    this.renderDock();
    this.renderHelp();
    if (this.draft) this.renderPanel();
    if (typeof data.focusId === 'string') this.focusEdit(data.focusId);
  }

  // ── selection ────────────────────────────────────────────────────────────

  /** Outline an element (hover: dashed + label; selected: solid). */
  private place(box: HTMLElement | null, el: Element | null, withLabel = false): void {
    if (!box) return;
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', top: `${r.top - 2}px`, left: `${r.left - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    box.textContent = '';
    const label = `${this.t[kindKey(el.tagName)]} · ${el.tagName.toLowerCase()}`;
    box.appendChild(h('span', { class: 'chip', 'data-j': 'label' }, withLabel ? `${label} - ${this.t.clickToEdit}` : label));
  }

  private move(dir: 'up' | 'down', from: Element): void {
    const next = dir === 'up' ? from.parentElement : Array.from(from.children).filter((c) => !isOurs(c))[0] || null;
    if (!next || next === document.body || next === document.documentElement) return;
    this.select(next);
  }

  /** The edits on an element (its selector finds it, or is the selector the editor would make for it), oldest first. */
  private editsOn(el: Element | null): PageEditWire[] {
    if (!el) return [];
    const own = robustSelector(el);
    return this.edits.filter((e) => e.selector === own || pageMatches(e.selector).indexOf(el) >= 0);
  }

  /**
   * The element is chosen: open the panel on it. An element that already
   * has an edit (this session's or the dashboard's) opens that edit - the
   * most recent one - like jumping to it from the list: its value, its
   * fallback, and Save updates the same edit.
   */
  select(el: Element, edit?: PageEditWire): void {
    if (!this.active) return;
    edit = edit || this.editsOn(el).pop();
    this.selected = el;
    this.hovered = null;
    this.place(this.hoverBox, null);
    this.place(this.selBox, el);
    this.popOpen = false;
    const selector = edit ? edit.selector : robustSelector(el) || '';
    this.showCss = !selector;
    this.draft = edit ? this.draftOf(edit) : this.newDraft(el, selector);
    this.renderPanel();
    this.renderDock();
    this.renderHelp();
    this.renderPreview();
  }

  private enabled(action: Action, el: Element | null): boolean {
    if (!el) return true;
    if (action === 'text') return el.tagName !== 'IMG' && !!this.orig(el).text;
    if (action === 'link') return el.tagName === 'A';
    if (action === 'image') return el.tagName === 'IMG';
    return true;
  }

  private newDraft(el: Element, selector: string): Draft {
    const o = this.orig(el);
    const action: Action = el.tagName === 'IMG' ? 'image' : this.enabled('text', el) ? 'text' : el.tagName === 'A' ? 'link' : 'hide';
    return { action, text: o.text.slice(0, MAX_TEXT), url: (action === 'image' ? o.src : o.href) || '', slotName: '', position: 'after', selector, editingId: null, touched: false };
  }

  private draftOf(e: PageEditWire): Draft {
    const action = ACTION_OF[e.operation];
    return {
      action,
      text: e.operation === 'replace_text' ? e.value || '' : '',
      url: action === 'link' || action === 'image' ? e.value || '' : '',
      slotName: e.placementKey || '',
      position: e.position || 'after',
      selector: e.selector,
      editingId: e.id,
      touched: true,
    };
  }

  /** The element as the page had it, before any preview of this editor. */
  private orig(el: Element): { text: string; href: string | null; src: string | null } {
    return this.originals.get(el) || { text: shortText(el), href: el.getAttribute('href'), src: el.getAttribute('src') };
  }

  /** Jump to an edit: from the dock's list, or the dashboard ("Edit on site"). */
  focusEdit(id: unknown): boolean {
    const edit = this.edits.filter((e) => e.id === id)[0];
    if (!edit || !this.active) return false;
    const el = pageMatches(edit.selector)[0] || null;
    if (el) {
      try {
        el.scrollIntoView({ block: 'center' });
      } catch {
        /* old browsers */
      }
      this.select(el, edit);
    } else {
      this.selected = null;
      this.place(this.selBox, null);
      this.draft = this.draftOf(edit);
      this.showCss = true;
      this.renderPanel();
      this.renderDock();
      this.renderHelp();
      this.renderPreview();
    }
    return true;
  }

  // ── the edit ─────────────────────────────────────────────────────────────

  /** The draft as an edit, or null while a field is not valid yet. */
  private draftEdit(d: Draft): PageEditWire | null {
    const base = { id: d.editingId || '', selector: d.selector.trim() };
    if (!isSafeSelector(base.selector)) return null;
    const operation = OPERATION_OF[d.action];
    if (d.action === 'hide') return { ...base, operation };
    if (d.action === 'text') return d.text.trim() && d.text.length <= MAX_TEXT ? { ...base, operation, value: d.text } : null;
    if (d.action === 'link' || d.action === 'image') return isSafeEditUrl(d.url) ? { ...base, operation, value: d.url.trim() } : null;
    const key = slugify(d.slotName);
    return PLACEMENT_KEY_PATTERN.test(key) ? { ...base, operation, placementKey: key, position: d.position } : null;
  }

  private save(): void {
    const d = this.draft;
    const edit = d && this.draftEdit(d);
    if (!d || !edit) return;
    const el = this.selected || pageMatches(edit.selector)[0] || null;
    const id = d.editingId || newEditId();
    if (!this.pick(el, edit.selector, edit.operation, edit.value ?? edit.placementKey ?? '', { id, position: edit.position })) return;
    // A saved slot stays open on its edit, with its campaigns or "Create content for this slot".
    if (edit.operation === 'insert_placement' && this.ctx.openSlot) this.focusEdit(id);
  }

  /** "Create content for this slot" or one of its campaigns: the dashboard opens it, in its own tab. */
  openSlot(placementKey: string, campaignId?: string): boolean {
    if (!this.ctx.openSlot || !PLACEMENT_KEY_PATTERN.test(placementKey)) return false;
    this.send({ type: EDITOR_SESSION_MESSAGES.OPEN_SLOT, placementKey, ...(campaignId ? { campaignId } : {}) });
    try {
      this.opener.focus();
    } catch {
      /* not allowed */
    }
    return true;
  }

  /**
   * Validate like the server does, post the edit to the dashboard, keep it
   * in the list (and on the page). `value` is the text, the address or the
   * slot name (made a placement key).
   */
  pick(el: Element | null, selector: string, operation: PageEditOperation, value: string, opts: { id?: string; position?: PageEditPosition } = {}): boolean {
    const id = opts.id || newEditId();
    const tag = el ? el.tagName.toLowerCase() : '';
    const text = el ? this.orig(el).text.slice(0, 200) : '';
    let edit: PageEditWire | null = null;
    if (isSafeSelector(selector)) {
      const base = { id, selector: selector.trim() };
      if (operation === 'hide') edit = { ...base, operation };
      else if (operation === 'replace_text') edit = (value || text) && (value || text).length <= MAX_TEXT ? { ...base, operation, value: value || text } : null;
      else if (operation === 'replace_image' || operation === 'replace_link') edit = isSafeEditUrl(value) ? { ...base, operation, value: value.trim() } : null;
      else if (operation === 'insert_placement') {
        const key = slugify(value);
        edit = PLACEMENT_KEY_PATTERN.test(key) ? { ...base, operation, placementKey: key, position: opts.position || 'after' } : null;
      }
    }
    if (!edit) return false;
    const msg: EditorPick = { type: EDITOR_MESSAGES.PICK, ...edit, tag, text } as EditorPick;
    this.send(msg as unknown as Record<string, unknown>);
    const at = this.edits.map((e) => e.id).indexOf(id);
    this.history.push({ id, before: at >= 0 ? this.edits[at] : null });
    if (at >= 0) this.edits[at] = edit;
    else this.edits.push(edit);
    this.closePanel();
    return true;
  }

  private cancel(): void {
    this.closePanel();
  }

  private closePanel(): void {
    this.draft = null;
    this.selected = null;
    this.panel?.remove();
    this.panel = null;
    this.wrap?.classList.remove('open');
    this.place(this.selBox, null);
    this.renderPreview();
    this.renderDock();
    this.renderHelp();
  }

  /** Undo the last saved edit: a new one is removed, a changed one goes back to what it was. */
  undo(): boolean {
    if (!this.synced) return false;
    const last = this.history.pop();
    if (!last) return false;
    const at = this.edits.map((e) => e.id).indexOf(last.id);
    if (last.before) {
      if (at >= 0) this.edits[at] = last.before;
      const b = last.before;
      this.send({ type: EDITOR_MESSAGES.PICK, ...b, tag: '', text: '' });
    } else {
      if (at >= 0) this.edits.splice(at, 1);
      this.send({ type: EDITOR_SESSION_MESSAGES.REMOVE, id: last.id });
    }
    if (this.draft) this.closePanel();
    else {
      this.renderPreview();
      this.renderDock();
    }
    return true;
  }

  /** "Save & return to Joryio": every edit is already with the dashboard; say so, stop, go back. */
  done(): void {
    this.send({ type: EDITOR_SESSION_MESSAGES.DONE });
    this.stop();
    try {
      this.opener.focus();
    } catch {
      /* not allowed */
    }
    try {
      window.close();
    } catch {
      /* not a tab the dashboard opened */
    }
  }

  // ── live preview ─────────────────────────────────────────────────────────

  private clearPreview(): void {
    for (const off of this.previewUndo.splice(0).reverse()) {
      try {
        off();
      } catch {
        /* the element went away */
      }
    }
  }

  /** Every edit, and the draft in place of the edit it changes, applied to the page. */
  private renderPreview(): void {
    this.clearPreview();
    if (!this.active) return;
    const d = this.draft;
    const draft = d ? this.draftEdit(d) : null;
    const shown: PageEditWire[] = [];
    for (const e of this.edits) shown.push(d && d.editingId === e.id ? draft || e : e);
    if (d && !d.editingId && draft && d.touched) shown.push(draft);
    for (const e of shown) for (const el of pageMatches(e.selector).slice(0, 50)) this.applyPreview(e, el);
    if (this.selected) this.place(this.selBox, this.selected);
  }

  private previewNode(build: (root: ShadowRoot) => void, style = PREVIEW_HOST_STYLE, kind = 'preview'): HTMLElement {
    const n = document.createElement(PREVIEW_TAG);
    n.setAttribute('data-joryio-editor', kind);
    n.setAttribute('style', style);
    const root = n.attachShadow({ mode: 'open' });
    root.appendChild(h('style', null, PREVIEW_CSS));
    build(root);
    return n;
  }

  private applyPreview(e: PageEditWire, el: Element): void {
    if (!this.originals.has(el)) this.originals.set(el, { text: shortText(el), href: el.getAttribute('href'), src: el.getAttribute('src') });
    const undo = this.previewUndo;
    const attr = (name: string, value: string | null) => {
      const before = el.getAttribute(name);
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
      undo.push(() => (before === null ? el.removeAttribute(name) : el.setAttribute(name, before)));
    };
    const hide = () => {
      const s = (el as HTMLElement).style;
      if (!s) return;
      const display = s.getPropertyValue('display');
      const priority = s.getPropertyPriority('display');
      s.setProperty('display', 'none', 'important');
      undo.push(() => (display ? s.setProperty('display', display, priority) : s.removeProperty('display')));
    };
    const insert = (n: Node, where: PageEditPosition) => {
      const parent = el.parentNode;
      if (where === 'before' && parent) parent.insertBefore(n, el);
      else if ((where === 'after' || where === 'replace') && parent) parent.insertBefore(n, el.nextSibling);
      else if (where === 'prepend') el.insertBefore(n, el.firstChild);
      else el.appendChild(n);
      undo.push(() => n.parentNode && n.parentNode.removeChild(n));
    };
    switch (e.operation) {
      case 'replace_text': {
        const kids = Array.from(el.childNodes);
        el.textContent = '';
        // A variable with neither a sample value nor a fallback is a pill, in its own shadow root.
        for (const p of previewParts(e.value || '', this.ctx.sample)) el.appendChild(typeof p === 'string' ? document.createTextNode(p) : this.previewNode((r) => r.appendChild(h('span', { class: 'v', dir: 'auto' }, this.labelOf(p.path) || p.name)), PREVIEW_VAR_HOST_STYLE, VAR_PILL));
        undo.push(() => {
          el.textContent = '';
          for (const k of kids) el.appendChild(k);
        });
        break;
      }
      case 'replace_link':
        attr('href', e.value || null);
        break;
      case 'replace_image':
        attr('srcset', null);
        attr('src', e.value || null);
        break;
      case 'hide': {
        const what = `${this.t[kindKey(el.tagName)]} "${this.orig(el).text.slice(0, 40)}"`;
        insert(this.previewNode((r) => r.appendChild(h('div', { class: 'x' }, `${this.t.hiddenFor}: ${what}`))), 'after');
        hide();
        break;
      }
      case 'insert_placement': {
        const where = e.position || 'after';
        insert(
          this.previewNode((r) => r.appendChild(h('div', { class: 's' }, h('b', null, `${this.t.slotPreview} · `), h('code', null, e.placementKey || ''), h('div', null, this.t.slotHelp)))),
          where,
        );
        if (where === 'replace') hide();
        break;
      }
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private renderHelp(): void {
    this.help?.remove();
    this.help = null;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HELP_DISMISSED_KEY) === '1';
    } catch {
      /* storage blocked: show it */
    }
    if (dismissed || this.draft || !this.wrap) return;
    const t = this.t;
    const row = (k: string, v: string) => h('div', { class: 'row' }, h('span', { class: 'kbd' }, k), v);
    const close = h('button', { class: 'x', type: 'button', 'aria-label': t.dismiss, title: t.dismiss, 'data-j': 'help-dismiss' }, icon('close', 13));
    close.addEventListener('click', () => {
      // persisted: localStorage of this site's origin, in the marketer's browser - the card is a one-time tip.
      try {
        localStorage.setItem(HELP_DISMISSED_KEY, '1');
      } catch {
        /* storage blocked: hidden for this session only */
      }
      this.help?.remove();
      this.help = null;
    });
    this.help = h('div', { class: 'help', 'data-j': 'help', role: 'note' }, close, h('h3', null, t.helpTitle), row('↑', t.helpUp), row('↓', t.helpDown), row(t.helpClickKey, t.helpClick));
    this.wrap.appendChild(this.help);
  }

  /** A variable's label from the catalog. */
  private labelOf(path: string): string | undefined {
    const v = this.ctx.attributes.filter((a) => a.path === path)[0];
    return v && v.label;
  }

  private editTitle(e: PageEditWire): string {
    const el = pageMatches(e.selector)[0];
    const kind = this.t[el ? kindKey(el.tagName) : kindKey(e.selector, true)];
    return `${this.t[ACTION_LABEL[ACTION_OF[e.operation]]]} · ${kind}`;
  }

  private togglePop(open: boolean): void {
    this.popOpen = open;
    this.renderDock();
  }

  private renderDock(): void {
    if (!this.wrap) return;
    const t = this.t;
    this.dock?.remove();
    const n = this.edits.length;
    const sub = [this.ctx.variantName ? fill(t.variant, { name: this.ctx.variantName }) : '', location.pathname || '/'].filter(Boolean).join(' · ');
    const countBtn = h('button', { class: 'db', type: 'button', 'aria-expanded': String(this.popOpen), 'data-j': 'edits' }, n === 1 ? t.editsOne : fill(t.editsMany, { n }), icon(this.popOpen ? 'down' : 'up', 11));
    countBtn.addEventListener('click', () => this.togglePop(!this.popOpen));
    const canUndo = this.synced && this.history.length > 0;
    const undoBtn = h('button', { class: 'ib', type: 'button', 'aria-label': t.undo, title: this.synced ? t.undo : t.undoOffline, disabled: !canUndo, 'data-j': 'undo' }, icon('undo', 14));
    undoBtn.addEventListener('click', () => this.undo());
    const doneBtn = h('button', { class: 'go', type: 'button', 'data-j': 'done' }, t.saveReturn);
    doneBtn.addEventListener('click', () => this.done());
    const dock = h(
      'div',
      { class: 'dock', 'data-j': 'dock', role: 'toolbar', 'aria-label': t.title },
      h('span', { class: 'logo', 'aria-hidden': 'true' }, 'J'),
      h('span', { class: 'name', 'data-j': 'campaign' }, this.ctx.campaignName || t.title),
      h('span', { class: 'sub' }, `· ${sub}`),
      h('span', { class: 'sep' }),
      h('span', { class: 'hint', 'data-j': 'hint' }, icon('cursor', 13), this.draft ? t.hintEditing : t.hintPoint),
      h('span', { class: 'sep' }),
      countBtn,
      undoBtn,
      doneBtn,
    );
    if (this.popOpen) {
      const pop = h('div', { class: 'pop', 'data-j': 'edit-list', role: 'menu' });
      if (!n) pop.appendChild(h('div', { class: 'empty' }, t.noEdits));
      this.edits.forEach((e, i) => {
        const b = h('button', { class: 'e', type: 'button', role: 'menuitem', 'data-j': 'edit-item', 'data-edit-id': e.id }, h('span', { class: 'num' }, String(i + 1)), this.editTitle(e));
        b.addEventListener('click', () => this.focusEdit(e.id));
        pop.appendChild(b);
      });
      dock.appendChild(pop);
    }
    this.dock = dock;
    this.wrap.appendChild(dock);
  }

  private renderPanel(): void {
    const d = this.draft;
    if (!d || !this.wrap) return;
    const t = this.t;
    const el = this.selected;
    this.panel?.remove();
    this.wrap.classList.add('open');

    // Header: breadcrumb (+ up / down), the element, its matches.
    const crumbs = h('div', { class: 'crumbs', 'data-j': 'crumbs' });
    if (el) {
      const chain: Element[] = [];
      for (let n: Element | null = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
      const shown = chain.slice(-3);
      const crumb = (label: string, target: Element | null, cur: boolean) => {
        const b = h('button', { class: cur ? 'crumb cur' : 'crumb', type: 'button', 'data-j': 'crumb', 'aria-current': cur ? 'true' : undefined, disabled: !target }, label);
        if (target && !cur) b.addEventListener('click', () => this.select(target));
        return b;
      };
      crumbs.appendChild(crumb(t.page, null, false));
      for (const n of shown) crumbs.append(icon('chevron', 9), crumb(t[kindKey(n.tagName)], n, n === el));
      const up = h('button', { type: 'button', 'aria-label': t.up, title: t.up, 'data-j': 'up', disabled: !el.parentElement || el.parentElement === document.body }, icon('up', 12));
      up.addEventListener('click', () => this.move('up', el));
      const down = h('button', { type: 'button', 'aria-label': t.down, title: t.down, 'data-j': 'down', disabled: !Array.from(el.children).some((c) => !isOurs(c)) }, icon('down', 12));
      down.addEventListener('click', () => this.move('down', el));
      crumbs.appendChild(h('span', { class: 'nav' }, up, down));
    }
    const kind = t[el ? kindKey(el.tagName) : kindKey(d.selector, true)];
    const snippet = el ? (el.tagName === 'IMG' ? el.getAttribute('alt') || '' : this.orig(el).text) : '';
    const title = h('div', { class: 'title', 'data-j': 'title' }, snippet ? `${kind} "${snippet.slice(0, 40)}"` : kind);
    const pill = h('span', { class: 'pill', 'data-j': 'matches' });
    const header = h('div', { class: 'hd' }, crumbs, h('div', { class: 'tr' }, title, pill));

    // Body: action tiles, the action's fields, the CSS selector.
    const tiles = h('div', { class: 'tiles', role: 'radiogroup', 'aria-label': t.whatToDo });
    const mine = this.editsOn(el);
    for (const a of ACTIONS) {
      const on = d.action === a;
      const enabled = on || this.enabled(a, el);
      const off = !enabled ? (a === 'link' ? t.notLink : a === 'image' ? t.notImage : t.noText) : '';
      // The element's own edit of this kind, if it has one: the tile opens it (an element can carry several edits).
      const own = mine.filter((e) => ACTION_OF[e.operation] === a).pop();
      const b = h('button', { class: a === 'slot' ? 'tile slot' : 'tile', type: 'button', role: 'radio', 'aria-checked': String(on), disabled: !enabled, 'data-e': !!own, 'data-j': `action-${a}` }, icon(ACTION_ICON[a]), h('span', null, h('b', null, t[ACTION_LABEL[a]]), off ? h('small', null, off) : null));
      b.addEventListener('click', () => {
        if (!this.draft || this.draft.action === a) return;
        if (own) this.draft = this.draftOf(own);
        else {
          // Another kind of change: a new edit next to the one open (that one stays as it is).
          if (el && this.draft.editingId) this.draft = this.newDraft(el, this.draft.selector);
          this.draft.action = a;
          this.draft.touched = true;
          if ((a === 'link' || a === 'image') && el) this.draft.url = (a === 'image' ? this.orig(el).src : this.orig(el).href) || '';
        }
        this.renderPanel();
        this.renderPreview();
      });
      tiles.appendChild(b);
    }
    const fields = h('div', { 'data-j': 'fields' });
    const saveBtn = h('button', { class: 'save', type: 'button', 'data-j': 'save' });
    const refresh = () => {
      const valid = !!this.draftEdit(d);
      saveBtn.disabled = !valid;
      saveBtn.textContent = fill(t.save, { action: t[ACTION_LABEL[d.action]] });
      const n = pageMatches(d.selector).length;
      pill.className = `pill ${n === 1 ? 'ok' : n > 1 ? 'many' : 'none'}`;
      pill.textContent = n === 1 ? t.matchOne : n > 1 ? fill(t.matchMany, { n }) : t.matchNone;
    };
    const changed = () => {
      d.touched = true;
      refresh();
      this.renderPreview();
    };
    this.renderFields(fields, d, el, changed);

    const cssToggle = h('button', { class: 'css', type: 'button', 'aria-expanded': String(this.showCss), 'data-j': 'css-toggle' }, icon('code', 13), t.css, icon(this.showCss ? 'up' : 'down', 10));
    cssToggle.addEventListener('click', () => {
      this.showCss = !this.showCss;
      this.renderPanel();
    });
    const body = h('div', { class: 'bd' }, h('span', { class: 'lbl' }, t.whatToDo), tiles, fields, cssToggle);
    if (this.showCss) {
      const input = h('input', { class: 'mono', dir: 'ltr', 'aria-label': t.css, spellcheck: 'false', 'data-j': 'selector' });
      input.value = d.selector;
      const note = h('div', { class: 'help2' });
      const sync = () => {
        const ok = isSafeSelector(d.selector);
        note.className = ok ? 'help2' : 'err';
        note.textContent = !d.selector.trim() ? t.noSelector : ok ? fill(t.cssHelp, { n: pageMatches(d.selector).length }) : t.cssBad;
      };
      input.addEventListener('input', () => {
        d.selector = input.value;
        sync();
        changed();
      });
      sync();
      body.append(h('div', { class: 'mt' }, input, note));
    }

    const cancel = h('button', { class: 'cancel', type: 'button', 'data-j': 'cancel' }, t.cancel);
    cancel.addEventListener('click', () => this.cancel());
    saveBtn.addEventListener('click', () => this.save());
    const panel = h('aside', { class: 'panel', 'data-j': 'panel', role: 'dialog', 'aria-label': t.whatToDo }, header, body, h('div', { class: 'ft' }, cancel, saveBtn));
    refresh();
    this.panel = panel;
    this.wrap.appendChild(panel);
  }

  /** One field set per action. Typing updates the draft and the page, never re-renders the field typed in. */
  private renderFields(box: HTMLElement, d: Draft, el: Element | null, changed: () => void): void {
    const t = this.t;
    box.textContent = '';
    this.closeOverlay = null;
    const was = (v: string | null) => (v ? h('span', { class: 'was', title: v }, fill(t.was, { value: v.slice(0, 60) })) : null);
    if (d.action === 'text') {
      let code: HTMLTextAreaElement | null = null;
      const textChanged = (v: string) => {
        d.text = v;
        if (code && code !== this.root?.activeElement) code.value = v;
        changed();
      };
      // Each pill has its own "If <field> is missing" (a click on it): the `| default:` of that variable only.
      const field = liquidField({
        label: t.newText,
        rawNote: t.rawNote,
        root: this.root,
        onChange: textChanged,
        labelOf: (p) => this.labelOf(p),
        fallback: { title: t.fallbackFor, help: t.fallbackHelp, bad: t.fallbackBad, done: t.fallbackDone },
      });
      field.set(d.text);
      const add = (v: Var) => field.insert(pathTag(v.path));
      const vars: Var[] = this.ctx.attributes.length ? this.ctx.attributes : ['firstName', 'lastName'].map((n) => ({ path: `user.${n}`, label: n, group: '' }));
      const common = COMMON_VARS.map((p) => vars.filter((v) => v.path === p)[0]).filter(Boolean);
      const shown = common.concat(vars.filter((v) => common.indexOf(v) < 0)).slice(0, CHIPS);
      const chips = h('div', { class: 'chips', 'data-j': 'chips' }, h('span', null, t.insert));
      const picker = h('div', { class: 'pk', 'data-j': 'var-picker', hidden: true });
      for (const v of shown) {
        const c = h('button', { class: 'vc', type: 'button', title: v.path, 'data-j': 'chip' }, v.label);
        c.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays in the text
        c.addEventListener('click', () => add(v));
        chips.appendChild(c);
      }
      if (vars.length > shown.length) {
        // "More…": the whole catalog, searchable, by group; ↑ ↓ Enter in the search box, Esc closes.
        const more = h('button', { class: 'vc', type: 'button', 'aria-expanded': 'false', 'data-j': 'more' }, t.more);
        const search = h('input', { dir: 'auto', 'aria-label': t.search, placeholder: t.search, 'data-j': 'var-search', role: 'combobox', 'aria-expanded': 'true' });
        const listEl = h('div', { role: 'listbox', 'aria-label': t.insert, 'data-j': 'var-list' });
        picker.append(search, listEl);
        let hits: Var[] = [];
        let at = 0;
        const close = () => {
          if (picker.hidden) return false;
          picker.hidden = true;
          more.setAttribute('aria-expanded', 'false');
          return true;
        };
        const pick = (v: Var | undefined) => {
          if (!v) return;
          close();
          add(v);
        };
        const draw = () => {
          const q = search.value.trim().toLowerCase();
          hits = vars.filter((v) => !q || `${v.label} ${v.path} ${v.group}`.toLowerCase().indexOf(q) >= 0).slice(0, 200);
          at = Math.min(at, Math.max(hits.length - 1, 0));
          listEl.textContent = '';
          if (!hits.length) listEl.appendChild(h('div', { class: 'g' }, t.noMatch));
          let group: string | null = null;
          hits.forEach((v, i) => {
            if (v.group !== group) {
              group = v.group;
              if (group) listEl.appendChild(h('div', { class: 'g', role: 'presentation' }, group));
            }
            const o = h('div', { class: 'o', role: 'option', id: `jv${i}`, 'aria-selected': String(i === at), 'data-j': 'var-option' }, h('span', { dir: 'auto' }, v.label), h('code', { dir: 'ltr' }, v.path));
            o.addEventListener('mousedown', (e) => e.preventDefault());
            o.addEventListener('click', () => pick(v));
            listEl.appendChild(o);
          });
          search.setAttribute('aria-activedescendant', hits.length ? `jv${at}` : '');
        };
        search.addEventListener('input', () => {
          at = 0;
          draw();
        });
        search.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            at = (at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(hits.length, 1);
            draw();
            const o = listEl.querySelector('[aria-selected="true"]') as HTMLElement | null;
            if (o && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(hits[at]);
          }
        });
        more.addEventListener('mousedown', (e) => e.preventDefault());
        more.addEventListener('click', () => {
          if (close()) return;
          picker.hidden = false;
          more.setAttribute('aria-expanded', 'true');
          search.value = '';
          at = 0;
          draw();
          search.focus();
        });
        this.closeOverlay = () => field.closePop() || close();
        chips.appendChild(more);
      }
      // "Liquid code": the stored text itself, for developers; editing it redraws the pills.
      const toggle = h('button', { class: 'css', type: 'button', 'aria-expanded': String(this.showLiquid), 'data-j': 'liquid-toggle' }, icon('code', 13), t.liquid, icon(this.showLiquid ? 'up' : 'down', 10));
      toggle.addEventListener('click', () => {
        this.showLiquid = !this.showLiquid;
        this.renderPanel();
      });
      if (!this.closeOverlay) this.closeOverlay = () => field.closePop();
      box.append(h('div', { class: 'fr' }, h('label', { class: 'lbl' }, t.newText), was(el ? this.orig(el).text : null)), field.el, chips, picker, toggle);
      if (this.showLiquid) {
        const ta = h('textarea', { class: 'mono', rows: '3', dir: 'ltr', spellcheck: 'false', 'aria-label': t.liquid, 'data-j': 'liquid' });
        ta.value = d.text;
        ta.addEventListener('input', () => {
          field.set(ta.value);
          textChanged(ta.value);
        });
        code = ta;
        box.appendChild(h('div', { class: 'mt' }, ta));
      }
    } else if (d.action === 'link' || d.action === 'image') {
      const input = h('input', { type: 'url', dir: 'ltr', inputmode: 'url', placeholder: 'https://', 'data-j': 'url', 'aria-label': d.action === 'link' ? t.newLink : t.newImage });
      input.value = d.url;
      const err = h('div', { class: 'err' });
      const check = () => (err.textContent = d.url.trim() && !isSafeEditUrl(d.url) ? t.urlBad : '');
      input.addEventListener('input', () => {
        d.url = input.value;
        check();
        changed();
      });
      check();
      const before = el ? (d.action === 'image' ? this.orig(el).src : this.orig(el).href) : null;
      box.append(h('div', { class: 'fr' }, h('label', { class: 'lbl' }, d.action === 'link' ? t.newLink : t.newImage), was(before)), input, err);
    } else if (d.action === 'hide') {
      const kind = t[el ? kindKey(el.tagName) : kindKey(d.selector, true)].toLowerCase();
      box.appendChild(h('div', { class: 'note', 'data-j': 'hide-note' }, fill(t.hideNote, { kind })));
    } else {
      const input = h('input', { class: 'slotin', dir: 'auto', 'data-j': 'slot-name', 'aria-label': t.slotName, maxlength: '80' });
      input.value = d.slotName;
      const saved = h('span', { class: 'key', 'data-j': 'slot-key' });
      const help = h('div', { class: 'help2' });
      const sync = () => {
        const key = slugify(d.slotName);
        saved.textContent = key || '-';
        help.textContent = '';
        help.append(`${t.savedAs} `, saved, key ? '' : ` · ${t.slotEmpty}`);
      };
      input.addEventListener('input', () => {
        d.slotName = input.value;
        sync();
        changed();
      });
      sync();
      box.append(h('label', { class: 'lbl' }, t.slotName), input, help);
      if (this.ctx.placements.length) {
        const chips = h('div', { class: 'chips', 'data-j': 'placements' });
        for (const p of this.ctx.placements.slice(0, 12)) {
          const c = h('button', { class: 'vc', type: 'button', title: p.name || p.key, 'data-j': 'placement' }, p.key);
          c.addEventListener('click', () => {
            d.slotName = p.key;
            input.value = p.key;
            sync();
            changed();
          });
          chips.appendChild(c);
        }
        box.appendChild(chips);
      }
      box.appendChild(h('div', { class: 'help2' }, t.slotHelp));
      const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t.where, 'data-j': 'positions' });
      for (const [pos, label] of POSITIONS) {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(d.position === pos), 'data-j': `pos-${pos}` }, t[label]);
        b.addEventListener('click', () => {
          d.position = pos;
          for (const x of Array.from(seg.children)) x.setAttribute('aria-checked', String(x === b));
          changed();
        });
        seg.appendChild(b);
      }
      box.append(h('div', { class: 'mt' }, h('span', { class: 'lbl' }, t.where), seg));
      // A saved slot: what fills it, from the dashboard (the key as saved, not as being typed).
      const savedEdit = this.ctx.openSlot && d.editingId ? this.edits.filter((e) => e.id === d.editingId)[0] : undefined;
      const key = savedEdit && savedEdit.placementKey;
      if (key) {
        const camps = (this.ctx.placements.filter((p) => p.key === key)[0] || { campaigns: [] as SlotCampaign[] }).campaigns;
        const sec = h('div', { class: 'mt slotc', 'data-j': 'slot-content' });
        const link = (label: string, j: string, id?: string) => {
          const b = h('button', { class: 'lnk', type: 'button', 'data-j': j }, label);
          b.addEventListener('click', () => this.openSlot(key, id));
          return b;
        };
        if (!camps.length) sec.appendChild(link(t.slotCreate, 'slot-create'));
        else {
          sec.appendChild(h('span', { class: 'lbl' }, t.slotIn));
          for (const c of camps) sec.appendChild(link(c.statusLabel || c.status ? `${c.name} (${c.statusLabel || c.status})` : c.name, 'slot-campaign', c.id));
          sec.appendChild(link(t.slotAddAnother, 'slot-add'));
        }
        box.appendChild(sec);
      }
    }
  }
}
