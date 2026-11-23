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

/** The `{{ ... }}` outputs of a text: the expression and its `| default:` value, if any. */
export function liquidOutputs(value: string): Array<{ expr: string; fallback: string | null }> {
  const out: Array<{ expr: string; fallback: string | null }> = [];
  const re = new RegExp(OUTPUT_TAG.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(value || ''))) {
    const expr = m[1].trim();
    const d = DEFAULT_FILTER.exec(expr);
    out.push({ expr, fallback: d ? unquote(d[1]) : null });
  }
  return out;
}

/** "If a value is missing": the first default of the text's variables; '' when none has one; null when it has no variable. */
export function textFallback(value: string): string | null {
  const outs = liquidOutputs(value);
  if (!outs.length) return null;
  const withOne = outs.filter((o) => o.fallback !== null)[0];
  return withOne ? (withOne.fallback as string) : '';
}

const quoted = (fallback: string) => (fallback.includes('"') ? `'${fallback.replace(/'/g, '')}'` : `"${fallback}"`);

/** Every `{{ ... }}` of the text with `fallback` as its `| default:` (an empty fallback removes it). */
export function setTextFallback(value: string, fallback: string): string {
  return (value || '').replace(new RegExp(OUTPUT_TAG.source, 'g'), (_m, inner: string) => {
    const expr = inner.trim().replace(new RegExp(DEFAULT_FILTER.source, 'g'), '').trim();
    return fallback ? `{{ ${expr} | default: ${quoted(fallback)} }}` : `{{ ${expr} }}`;
  });
}

/** The Liquid of one profile field: defaults are `user.<name>`, custom attributes `user.custom.<name>`. */
export function variableTag(name: string, custom: boolean, fallback?: string | null): string {
  const path = custom ? `user.custom.${name}` : `user.${name}`;
  return fallback ? `{{ ${path} | default: ${quoted(fallback)} }}` : `{{ ${path} }}`;
}

/**
 * What the page shows while editing: each `{{ path ... }}` becomes the
 * sample value the dashboard sent for that path (its known visitor), else
 * the fallback (what an unknown visitor sees), else the field name in
 * brackets so an empty spot is still visible.
 */
export function previewText(value: string, sample: Record<string, string>): string {
  return (value || '').replace(new RegExp(OUTPUT_TAG.source, 'g'), (_m, inner: string) => {
    const expr = inner.trim();
    const path = expr.split('|')[0].trim();
    const d = DEFAULT_FILTER.exec(expr);
    if (Object.prototype.hasOwnProperty.call(sample, path) && sample[path] !== '') return sample[path];
    if (d && unquote(d[1])) return unquote(d[1]);
    return `[${path.replace(/^user\.(custom\.)?/, '')}]`;
  });
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
