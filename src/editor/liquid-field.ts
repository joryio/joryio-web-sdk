/**
 * The "New text" field: the text with its variables as placeholder pills
 * (the same pill as the page preview), the stored value unchanged Liquid.
 *
 * - Pill mode (the text has only plain text, `{{ user.x }}` and
 *   `| default: "..."`): a contenteditable box; each variable is an atomic
 *   `contenteditable=false` pill carrying its exact Liquid, so the value
 *   round-trips byte for byte. Backspace / Delete next to a pill removes the
 *   whole pill, arrow keys step over it (the browser's own handling of a
 *   non-editable inline), copy and cut put the Liquid on the clipboard, paste
 *   is plain text only (Liquid in it becomes pills). Enter is ignored - a
 *   page text edit is one run of text.
 * - Raw mode (anything a pill cannot show: `{% if %}`, other filters): a
 *   textarea with the Liquid and a short note, so nothing is lost.
 *
 * - Each pill has its own fallback: a click on it (or Enter / Space on it)
 *   opens a small popover, "If <field> is missing" + one input, that writes
 *   `| default: "..."` on THAT variable only. A pill with a fallback shows it
 *   after its name ("firstName · friend"). The fallback is plain text - Liquid
 *   in it is refused. Esc, Enter or Done closes the popover.
 *
 * Inside the editor's closed shadow root the caret comes from the root's
 * own getSelection() where the browser has it (Chromium), else the
 * document's; with no caret in the box an Insert appends, as before.
 */
import { isPlainFallback, liquidParts, setVarFallback, varFallback, type LiquidVar } from './editor-model';
import { fill } from './editor-strings';
import { h } from './editor-ui';

export interface LiquidField {
  el: HTMLElement;
  /** Show a value (re-renders; the mode follows the value). */
  set(value: string): void;
  /** Insert one variable's Liquid at the caret (or at the end). */
  insert(tag: string): void;
  /** Close a pill's fallback popover; true when one was open. */
  closePop(): boolean;
  /** Open the fallback popover of the (first) pill of this variable path; false when there is none. */
  openPill(path: string): boolean;
}

/** The words of a pill's fallback popover: `title` has `{name}`, the field's label. */
export interface FallbackWords {
  title: string;
  help: string;
  bad: string;
  done: string;
}

const PILL_ATTR = 'data-liquid';
const isPill = (n: Node | null | undefined): n is HTMLElement => !!n && n.nodeType === 1 && (n as Element).hasAttribute(PILL_ATTR);

/** A box's content as Liquid: text as is, a pill as its Liquid, a browser-inserted `<br>` as nothing. */
export function serialize(n: Node): string {
  if (n.nodeType === 3) return (n as Text).data;
  if (isPill(n)) return n.getAttribute(PILL_ATTR) || '';
  let s = '';
  for (const k of Array.from(n.childNodes)) s += serialize(k);
  return s;
}

export function liquidField(opts: {
  label: string;
  rawNote: string;
  root: ShadowRoot | null;
  onChange: (value: string) => void;
  labelOf?: (path: string) => string | undefined;
  fallback?: FallbackWords;
}): LiquidField {
  const el = h('div', { 'data-j': 'text-box' });
  let value = '';
  let box: HTMLElement | null = null;
  let saved: Range | null = null;
  let pop: HTMLElement | null = null;

  const selection = (): Selection | null => {
    const r = opts.root as unknown as { getSelection?: () => Selection | null } | null;
    return (r && typeof r.getSelection === 'function' ? r.getSelection() : null) || document.getSelection();
  };
  /** The selection as a Range in the box: Chromium's root.getSelection(), else getComposedRanges (Safari, Firefox), else the plain range. */
  const caret = (): Range | null => {
    const s = selection();
    if (!s || !s.rangeCount) return null;
    let r: Range | null = s.getRangeAt(0);
    const composed = (s as unknown as { getComposedRanges?: (o: unknown) => StaticRange[] }).getComposedRanges;
    if (opts.root && composed && !(box && box.contains(r.startContainer))) {
      try {
        const sr = composed.call(s, { shadowRoots: [opts.root] })[0];
        r = document.createRange();
        r.setStart(sr.startContainer, sr.startOffset);
        r.setEnd(sr.endContainer, sr.endOffset);
      } catch {
        r = null;
      }
    }
    return box && r && box.contains(r.startContainer) && box.contains(r.endContainer) ? r : null;
  };
  const remember = () => {
    const r = caret();
    if (r) saved = r.cloneRange();
  };
  const emit = () => {
    if (box && box.tagName === 'DIV') value = serialize(box);
    remember();
    opts.onChange(value);
  };
  const putCaret = (r: Range) => {
    const s = selection();
    try {
      if (s && s.setBaseAndExtent) s.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
      else if (s) {
        s.removeAllRanges();
        s.addRange(r);
      }
    } catch {
      /* no selection here */
    }
    saved = r.cloneRange();
  };
  const labelOf = (v: LiquidVar) => (opts.labelOf && opts.labelOf(v.path)) || v.name;
  const pill = (v: LiquidVar) => {
    const fb = varFallback(v.src);
    const label = labelOf(v);
    const words = opts.fallback;
    return h(
      'span',
      {
        class: 'vp',
        contenteditable: 'false',
        dir: 'auto',
        title: v.src,
        [PILL_ATTR]: v.src,
        'data-path': v.path,
        ...(words ? { role: 'button', tabindex: '0', 'aria-haspopup': 'dialog', 'aria-label': fb ? `${label} · ${fb}` : label } : {}),
      },
      label,
      fb ? h('span', { class: 'vfb', 'data-j': 'pill-fallback' }, ` · ${fb}`) : null,
    );
  };

  const closePop = (): boolean => {
    if (!pop) return false;
    pop.remove();
    pop = null;
    return true;
  };
  /** A pill's own fallback: the popover under the field, writing that pill's `| default:` as it is typed. */
  const openPop = (target: HTMLElement) => {
    const words = opts.fallback;
    if (!words || !box || box.tagName !== 'DIV') return;
    closePop();
    let cur = target;
    const v = { path: cur.getAttribute('data-path') || '', name: '', src: cur.getAttribute(PILL_ATTR) || '' };
    v.name = v.path.replace(/^user\.(custom\.)?/, '');
    const title = fill(words.title, { name: labelOf(v) });
    const input = h('input', { dir: 'auto', 'data-j': 'fallback', 'aria-label': title, maxlength: '200' });
    input.value = varFallback(v.src) || '';
    const err = h('div', { class: 'err', 'data-j': 'fallback-error', role: 'alert' });
    const done = h('button', { class: 'vc ui', type: 'button', 'data-j': 'fallback-done' }, words.done);
    const p = h('div', { class: 'pk fbp', role: 'dialog', 'aria-label': title, 'data-j': 'fallback-pop' }, h('label', { class: 'lbl' }, title), input, err, h('div', { class: 'help2' }, words.help), done);
    const finish = () => {
      closePop();
      try {
        cur.focus();
      } catch {
        /* gone */
      }
    };
    input.addEventListener('input', () => {
      const ok = isPlainFallback(input.value);
      err.textContent = ok ? '' : words.bad;
      if (!ok) return;
      const src = setVarFallback(cur.getAttribute(PILL_ATTR) || '', input.value);
      const next = pill({ ...v, src });
      if (cur.parentNode) cur.parentNode.replaceChild(next, cur);
      cur = next;
      if (box && box.tagName === 'DIV') value = serialize(box);
      opts.onChange(value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    });
    done.addEventListener('click', finish);
    // Focus leaving the popover (Tab away, a click elsewhere) closes it.
    p.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (pop === p && (!to || !p.contains(to))) closePop();
    });
    pop = p;
    el.appendChild(p);
    input.focus();
  };

  const set = (v: string) => {
    value = v;
    saved = null;
    pop = null;
    el.textContent = '';
    const parts = liquidParts(v);
    if (!parts) {
      const area = h('textarea', { rows: '3', dir: 'auto', 'data-j': 'text', 'aria-label': opts.label });
      area.value = v;
      area.addEventListener('input', () => {
        value = area.value;
        opts.onChange(value);
      });
      area.addEventListener('blur', () => liquidParts(value) && set(value));
      box = area;
      el.append(area, h('div', { class: 'help2', 'data-j': 'raw-note' }, opts.rawNote));
      return;
    }
    const ce = h('div', { class: 'ce', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', dir: 'auto', spellcheck: 'false', 'data-j': 'text', 'aria-label': opts.label });
    for (const p of parts) ce.append(typeof p === 'string' ? document.createTextNode(p) : pill(p));
    ce.addEventListener('input', emit);
    ce.addEventListener('keyup', remember);
    ce.addEventListener('mouseup', remember);
    ce.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? (e.target.closest(`[${PILL_ATTR}]`) as HTMLElement | null) : null;
      if (t && ce.contains(t)) openPop(t);
    });
    ce.addEventListener('keydown', (e) => {
      const onPill = e.target instanceof Element && isPill(e.target) ? (e.target as HTMLElement) : null;
      if (onPill && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        return openPop(onPill);
      }
      if (e.key === 'Enter') return e.preventDefault();
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const r = caret();
      if (!r || !r.collapsed) return;
      const back = e.key === 'Backspace';
      const c = r.startContainer;
      const o = r.startOffset;
      let next: Node | null = null;
      if (c.nodeType === 3) {
        if (back && o === 0) next = c.previousSibling;
        else if (!back && o === (c as Text).length) next = c.nextSibling;
      } else next = c.childNodes[back ? o - 1 : o] || null;
      if (!isPill(next)) return;
      e.preventDefault();
      next.remove();
      emit();
    });
    const clip = (cut: boolean) => (e: ClipboardEvent) => {
      const r = caret();
      if (!r || r.collapsed || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', serialize(r.cloneContents()));
      if (cut) {
        r.deleteContents();
        emit();
      }
    };
    ce.addEventListener('copy', clip(false));
    ce.addEventListener('cut', clip(true));
    ce.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r/g, '');
      const r = caret();
      if (!text || !r) return;
      r.deleteContents();
      const t = document.createTextNode(text);
      r.insertNode(t);
      r.setStartAfter(t);
      r.collapse(true);
      putCaret(r);
      emit();
      if (/\{[{%]/.test(text)) set(value);
    });
    // Liquid typed by hand becomes pills (or the raw box) once the field is left.
    ce.addEventListener('blur', () => Array.from(ce.childNodes).some((n) => n.nodeType === 3 && /\{[{%]/.test((n as Text).data)) && set(value));
    box = ce;
    el.appendChild(ce);
  };

  const insert = (tag: string) => {
    const live = caret();
    const r = live || (saved && box && box.isConnected && box.contains(saved.startContainer) ? saved : null);
    if (!r || !box || box.tagName !== 'DIV') {
      set(value ? `${value.replace(/\s+$/, '')} ${tag}` : tag);
      return opts.onChange(value);
    }
    const parts = liquidParts(tag);
    const v = parts && parts[0];
    if (!v || typeof v === 'string') return;
    box.focus();
    r.deleteContents();
    const before = document.createRange();
    before.selectNodeContents(box);
    before.setEnd(r.startContainer, r.startOffset);
    const prev = serialize(before.cloneContents());
    const frag = document.createDocumentFragment();
    if (prev && !/\s$/.test(prev)) frag.appendChild(document.createTextNode(' '));
    const p = pill(v);
    frag.appendChild(p);
    r.insertNode(frag);
    r.setStartAfter(p);
    r.collapse(true);
    putCaret(r);
    emit();
  };

  const openPill = (path: string): boolean => {
    if (!box || box.tagName !== 'DIV') return false;
    const target = Array.from(box.querySelectorAll(`[${PILL_ATTR}]`)).filter((n) => n.getAttribute('data-path') === path)[0] as HTMLElement | undefined;
    if (!target) return false;
    openPop(target);
    return true;
  };

  return { el, set, insert, closePop, openPill };
}
