/**
 * The editor's pure parts: the Liquid of a personalized text (the same
 * `{{ user.<field> | default: "..." }}` the dashboard writes, packages/frontend
 * src/lib/web-experience.ts), the slot-name slug, the friendly element kind,
 * and the live-preview rendering of an edit's text.
 */
import type { EditorStringKey } from './editor-strings';

const OUTPUT_TAG = /\{\{-?([\s\S]*?)-?\}\}/g;
const DEFAULT_FILTER = /\|\s*default\s*:\s*("[^"]*"|'[^']*'|[^|}]*?)\s*(?=\||$)/;
const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');

/**
 * A fallback as a Liquid string literal. Liquid has no escape inside a
 * literal, so: double quotes; single quotes when the text has a `"`; with
 * both, single quotes and each `'` as the typographic apostrophe (U+2019),
 * so nothing the marketer typed disappears.
 */
export const quoted = (fallback: string): string =>
  !fallback.includes('"') ? `"${fallback}"` : !fallback.includes("'") ? `'${fallback}'` : `'${fallback.replace(/'/g, '\u2019')}'`;

/** A fallback is plain text: no Liquid in it, one line, at most 200 characters. */
export const isPlainFallback = (v: string): boolean => v.length <= 200 && !/\{[{%]|[}%]\}|[\r\n]/.test(v);

/** The `| default:` value of ONE variable's Liquid (`{{ user.x | default: "y" }}`), or null. */
export function varFallback(src: string): string | null {
  const m = /^\{\{-?([\s\S]*?)-?\}\}$/.exec((src || '').trim());
  const d = m && DEFAULT_FILTER.exec(m[1].trim());
  return d ? unquote(d[1]) : null;
}

/** ONE variable's Liquid with `fallback` as its own `| default:` (an empty one removes it); its path is kept. */
export function setVarFallback(src: string, fallback: string): string {
  const m = /^\{\{-?\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec((src || '').trim());
  return m ? pathTag(m[1], fallback.trim() || null) : src;
}

/** The Liquid of one profile field: defaults are `user.<name>`, custom attributes `user.custom.<name>`. */
export const variableTag = (name: string, custom: boolean, fallback?: string | null): string => pathTag(custom ? `user.custom.${name}` : `user.${name}`, fallback);

/** The Liquid of one variable by its path (`user.firstName`, the catalog's `key`). */
export const pathTag = (path: string, fallback?: string | null): string => (fallback ? `{{ ${path} | default: ${quoted(fallback)} }}` : `{{ ${path} }}`);

/** A Liquid variable path: dotted identifiers (`user.custom.city`). */
export const VAR_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$/;

/** A variable the editor shows as a placeholder pill: its field name, and (in the text field) its exact Liquid. */
export interface LiquidVar {
  name: string;
  path: string;
  src: string;
}
export type LiquidPart = string | LiquidVar;

const pathName = (path: string) => path.replace(/^user\.(custom\.)?/, '');

/**
 * What the page shows while editing: each `{{ path ... }}` becomes the
 * sample value the dashboard sent for that path (its known visitor), else
 * the fallback (what an unknown visitor sees), else a placeholder pill with
 * the field name (`{ name }`), so an empty spot is still visible and never
 * mistaken for page text.
 */
export function previewParts(value: string, sample: Record<string, string>): LiquidPart[] {
  const out: LiquidPart[] = [];
  const re = new RegExp(OUTPUT_TAG.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (s: string) => {
    if (!s) return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += s;
    else out.push(s);
  };
  value = value || '';
  while ((m = re.exec(value))) {
    text(value.slice(last, m.index));
    last = re.lastIndex;
    const expr = m[1].trim();
    const path = expr.split('|')[0].trim();
    const d = DEFAULT_FILTER.exec(expr);
    if (Object.prototype.hasOwnProperty.call(sample, path) && sample[path] !== '') text(sample[path]);
    else if (d && unquote(d[1])) text(unquote(d[1]));
    else out.push({ name: pathName(path), path, src: m[0] });
  }
  text(value.slice(last));
  return out;
}

/** previewParts as plain text (a pill as `[name]`). */
export const previewText = (value: string, sample: Record<string, string>): string => previewParts(value, sample).map((p) => (typeof p === 'string' ? p : `[${p.name}]`)).join('');

/** A variable path with at most a quoted `| default:` - what the text field shows as a pill. */
const SIMPLE_VAR = /^\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\|\s*default\s*:\s*(?:"[^"]*"|'[^']*')\s*)?-?\}\}$/;

/**
 * The text field's view of a text: plain parts and variables (each with its
 * exact Liquid, so the text round-trips byte for byte), or null when it holds
 * Liquid a pill cannot show (a tag like `{% if %}`, a filter other than
 * `default`, a stray brace pair) - the field then stays raw text.
 */
export function liquidParts(value: string): LiquidPart[] | null {
  const out: LiquidPart[] = [];
  const re = new RegExp(OUTPUT_TAG.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  value = value || '';
  while ((m = re.exec(value))) {
    const v = SIMPLE_VAR.exec(m[0]);
    if (!v) return null;
    if (m.index > last) out.push(value.slice(last, m.index));
    out.push({ name: pathName(v[1]), path: v[1], src: m[0] });
    last = re.lastIndex;
  }
  if (last < value.length) out.push(value.slice(last));
  return out.some((p) => typeof p === 'string' && /\{[{%]|[}%]\}/.test(p)) ? null : out;
}

/** A slot name as a placement key: lowercase, anything else -> `_`, no leading/trailing `_`, at most 64. */
export function slugify(name: string): string {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
}

/** A new edit id, the dashboard's format (`e` + 8 base-36 characters). */
export const newEditId = (): string => `e${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;

/** The friendly name of an element, by tag (or the selector's last tag when the element is not on the page). */
export function kindKey(tagOrSelector: string, isSelector = false): EditorStringKey {
  let t = (tagOrSelector || '').toLowerCase();
  if (isSelector) {
    const parts = t.trim().split(/[\s>+~]+/).filter(Boolean);
    const m = /^[a-z][a-z0-9]*/.exec(parts[parts.length - 1] || '');
    t = m ? m[0] : '';
  }
  if (/^h[1-6]$/.test(t)) return 'kHeading';
  if (/^(p|span|strong|em|small|label|blockquote|b|i)$/.test(t)) return 'kText';
  if (t === 'a') return 'kLink';
  if (t === 'button') return 'kButton';
  if (t === 'img' || t === 'picture') return 'kImage';
  if (/^(ul|ol|li)$/.test(t)) return 'kList';
  if (t === 'main') return 'kMain';
  if (t === 'header') return 'kHeader';
  if (t === 'footer') return 'kFooter';
  if (t === 'nav') return 'kNav';
  if (t === 'form') return 'kForm';
  if (/^(section|div|article|aside)$/.test(t)) return 'kSection';
  return 'kElement';
}
