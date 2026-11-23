/**
 * Building blocks of the editor's UI: an element helper that only ever sets
 * attributes and text (never HTML), the icons (fixed SVG paths), and the
 * stylesheet. Everything lives inside the editor's shadow root, so the
 * site's CSS cannot restyle it and this CSS cannot reach the site.
 *
 * Colours are the Joryio product tokens of the design handoff
 * (design_handoff_web_personalization, joryio-tokens.css): navy #071342,
 * teal #31D6C8 / #00A99A, slot lavender #7A6CFF, light panel like the app.
 */

type Kid = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string | boolean | undefined> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  text: ['M4 7V5h16v2M9 19h6M12 5v14'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  image: ['M3 5h18v14H3z', 'm3 16 5-5 4 4 3-3 6 6', 'M15.5 8.5h.01'],
  hide: ['M9.88 9.88a3 3 0 1 0 4.24 4.24', 'M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68', 'M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61', 'm2 2 20 20'],
  slot: ['M3 3h18v18H3z', 'M7 9h10v6H7z'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'],
  up: ['m18 15-6-6-6 6'],
  down: ['m6 9 6 6 6-6'],
  cursor: ['m4 4 7.07 17 2.51-7.39L21 11.07z'],
  code: ['m16 18 6-6-6-6M8 6l-6 6 6 6'],
  chevron: ['m9 18 6-6-6-6'],
  check: ['M20 6 9 17l-5-5'],
  close: ['M18 6 6 18M6 6l12 12'],
};
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 15): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s as SVGSVGElement;
}

/** The host element's own inline style: nothing of the site's CSS reaches inside, and the host takes no room. */
export const HOST_STYLE = 'all:initial !important;position:fixed !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;display:block !important';

/** A preview element the editor puts IN the page (a slot, a hidden-element note): its own shadow root too. */
export const PREVIEW_HOST_STYLE = 'all:initial !important;display:block !important;margin:10px 0 !important';

const FONT = 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const MONO = 'ui-monospace,"SF Mono",Menlo,monospace';

export const PREVIEW_CSS = `.s,.x{font:12.5px/1.4 ${FONT};border-radius:10px;padding:14px 16px;text-align:center}.s{border:2px dashed #7A6CFF;background:#F4F2FF;color:#4C3FD1}.s b{font-weight:700}.s code{font-family:${MONO}}.s div{font-size:11.5px;color:#6B5FD9;margin-top:3px}.x{border:1.5px dashed #F04438;background:#FEF3F2;color:#B42318;text-align:start;padding:10px 12px;font-size:12px}`;

export const EDITOR_CSS = `
*{box-sizing:border-box}
.r{font:13px/1.4 ${FONT};color:#242B3A;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer}
button:disabled{cursor:not-allowed}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #31D6C8;outline-offset:1px}
.box{position:fixed;pointer-events:none;border:2px dashed #00A99A;background:rgba(0,169,154,.07);border-radius:4px;display:none}
.box.sel{border-style:solid;background:rgba(0,169,154,.04)}
.chip{position:absolute;bottom:100%;inset-inline-start:-2px;margin-bottom:2px;background:#00A99A;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px 6px 6px 0;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
.help{position:fixed;top:16px;inset-inline-end:16px;width:240px;background:#fff;border:1px solid #E5EAF2;border-radius:10px;box-shadow:0 8px 24px rgba(10,18,64,.14);padding:10px 12px}
.help h3{margin:0 0 6px;font-size:11px;font-weight:700;color:#6B7280;letter-spacing:.5px;text-transform:uppercase}
.help .row{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0}
.kbd{min-width:38px;text-align:center;font-size:11px;font-weight:600;border:1px solid #E5EAF2;border-radius:5px;padding:1px 5px;background:#F8FAFC}
.help .x{position:absolute;top:6px;inset-inline-end:6px;border:0;background:none;color:#8990A8;padding:2px;display:grid}
.dock{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;background:#071342;color:#fff;border-radius:14px;padding:7px 7px 7px 14px;box-shadow:0 12px 32px rgba(10,18,64,.35);white-space:nowrap;max-width:calc(100vw - 24px)}
.r.open .dock{left:calc(50% - 190px)}
.r.open[dir=rtl] .dock{left:calc(50% + 190px)}
.logo{width:22px;height:22px;border-radius:6px;background:#fff;color:#071342;display:grid;place-items:center;font-weight:800;font-size:13px;flex:none}
.name{font-size:12.5px;font-weight:600;margin-inline-start:4px;overflow:hidden;text-overflow:ellipsis;max-width:200px}
.sub{font-size:12px;color:#A8AEC1;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.sep{width:1px;height:22px;background:#2A3366;margin:0 8px;flex:none}
.hint{font-size:12px;color:#C9CEDD;display:inline-flex;align-items:center;gap:6px}
.hint svg{color:#31D6C8}
.db{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;border:0;background:#1B245A;color:#fff;font-size:12.5px;font-weight:600}
.ib{height:32px;width:32px;border-radius:8px;border:0;background:transparent;color:#fff;display:grid;place-items:center}
.ib:disabled{color:#4A527A}
.go{height:32px;padding:0 14px;border-radius:8px;border:0;background:#31D6C8;color:#071342;font-size:12.5px;font-weight:700}
.pop{position:absolute;bottom:calc(100% + 10px);left:0;right:0;min-width:280px;max-height:50vh;overflow:auto;background:#fff;color:#242B3A;border-radius:12px;border:1px solid #E5EAF2;box-shadow:0 12px 32px rgba(10,18,64,.18);padding:6px;white-space:normal}
.pop .e{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;background:none;border-radius:8px;font-size:12.5px;text-align:start}
.pop .e:hover{background:#F8FAFC}
.pop .empty{padding:12px;font-size:12.5px;color:#6B7280}
.num{width:20px;height:20px;border-radius:99px;background:#071342;color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;flex:none}
.panel{position:fixed;top:0;bottom:0;inset-inline-end:0;width:380px;max-width:100vw;background:#fff;border-inline-start:1px solid #E5EAF2;box-shadow:-8px 0 24px rgba(10,18,64,.06);display:flex;flex-direction:column}
.hd{padding:16px 18px 14px;border-bottom:1px solid #E5EAF2}
.crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:4px;font-size:11.5px;color:#6B7280;margin-bottom:6px}
.crumbs svg{color:#A8AEC1}
.crumb{border:0;background:transparent;color:#6B7280;font-weight:500;font-size:11.5px;padding:2px 6px;border-radius:5px}
.crumb.cur{background:#E5F9F6;color:#0F766E;font-weight:600}
.nav{margin-inline-start:auto;display:flex;gap:2px}
.nav button{border:1px solid #E5EAF2;background:#fff;border-radius:6px;width:24px;height:22px;display:grid;place-items:center;color:#3A4060;padding:0}
.nav button:disabled{opacity:.4}
.tr{display:flex;align-items:center;gap:10px}
.title{font-size:17px;font-weight:700;color:#0A1240;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pill{margin-inline-start:auto;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;padding:3px 8px;border-radius:999px;white-space:nowrap;flex:none}
.pill.ok{background:#E5F9F6;color:#0F766E}
.pill.many{background:#FFF7E6;color:#92400E}
.pill.none{background:#FEF3F2;color:#B42318}
.bd{padding:16px 18px;overflow:auto;flex:1}
.lbl{display:block;font-size:12.5px;font-weight:600;color:#242B3A;margin-bottom:8px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}
.tile{display:flex;align-items:center;gap:9px;padding:10px 11px;border-radius:10px;text-align:start;background:#fff;border:1.5px solid #E5EAF2;color:#3A4060}
.tile[aria-checked=true]{background:#E5F9F6;border-color:#00C8B7;color:#0F766E}
.tile.slot[aria-checked=true]{background:#F4F2FF;border-color:#7A6CFF;color:#4C3FD1}
.tile:disabled{opacity:.55}
.tile b{display:block;font-size:12.5px;font-weight:600;color:#0A1240}
.tile small{display:block;font-size:10.5px;color:#6B7280}
.fr{display:flex;align-items:baseline;margin-bottom:8px}
.fr .lbl{margin:0}
.was{margin-inline-start:auto;font-size:11.5px;color:#6B7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}
textarea,input{width:100%;font:inherit;font-size:13.5px;color:#0F1424;padding:10px 12px;border-radius:10px;border:1.5px solid #E5EAF2;background:#fff;outline:none}
textarea{line-height:1.5;resize:vertical;border-color:#00C8B7}
input{height:40px;padding:0 12px}
input.slotin{border-color:#7A6CFF}
input.mono{font-family:${MONO};font-size:12px;height:36px;background:#F8FAFC;border-width:1px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
.chips span{font-size:11.5px;color:#6B7280;margin-inline-end:2px}
.vc{font-family:${MONO};font-size:11.5px;padding:3px 8px;border-radius:6px;border:1px solid #E5EAF2;background:#F8FAFC;color:#3A4060}
.help2{font-size:11.5px;color:#6B7280;margin-top:5px}
.err{font-size:11.5px;color:#B42318;margin-top:5px}
.mt{margin-top:14px}
.note{background:#FFF7E6;border:1px solid #FCD34D;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#92400E;line-height:1.5}
.key{font-family:${MONO};color:#4C3FD1;background:#F4F2FF;padding:1px 6px;border-radius:4px}
.seg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#F3F5FA;border-radius:9px;padding:3px}
.seg button{border:0;background:transparent;border-radius:7px;padding:6px 4px;font-size:12px;color:#3A4060}
.seg button[aria-checked=true]{background:#fff;color:#0A1240;font-weight:600;box-shadow:0 1px 2px rgba(10,18,64,.08)}
.css{margin-top:20px;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:0;color:#6B7280;font-size:12px}
.ft{padding:12px 18px;border-top:1px solid #E5EAF2;display:flex;gap:10px;background:#F8FAFC}
.cancel{height:38px;padding:0 14px;border-radius:10px;border:1px solid #E5EAF2;background:#fff;color:#242B3A;font-size:13px;font-weight:600}
.save{flex:1;height:38px;border-radius:10px;border:0;background:#071342;color:#fff;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.save:disabled{opacity:.45}
@media (max-width:760px){.r.open .dock{display:none}.help{display:none}}
`;
