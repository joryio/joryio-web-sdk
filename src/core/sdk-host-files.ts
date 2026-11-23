/**
 * The files the core loads on demand from the SDK host, next to
 * `joryio.min.js`: the point-and-click editor (`joryio-editor.min.js`,
 * src/core/editor-gate.ts) and the default card feed (`joryio-cards-ui.min.js`,
 * src/core/cards.ts). Kept out of the core so that a visitor who never needs
 * them never downloads them (BACKLOG D444).
 */
import { SDK_VERSION } from './config';

export const SDK_HOST = 'https://sdk.joryio.com';

/** A core bundle's own file name: what a script tag loads (sdk.joryio.com, the npm package's dist/). */
const CORE_FILE = /\/joryio(?:\.umd)?(?:\.min)?\.js$/;

/**
 * The folder the running core was loaded from (with a trailing slash), when
 * it was loaded by a script tag as `joryio.min.js` over https - for example
 * `https://sdk.joryio.com/web/1.4.0-beta.4/`. Null when bundled into the
 * site's own code (the script is then the site's file), or not over https.
 */
export function coreFolderOf(src: string | null | undefined): string | null {
  if (!src || typeof src !== 'string') return null;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !CORE_FILE.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
}

/**
 * Read while this module is evaluated, i.e. while the core's script runs:
 * `document.currentScript` is null afterwards (and for a module script),
 * then the last `<script src=".../joryio.min.js">` on the page is used.
 */
function readOwnFolder(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const current = document.currentScript as HTMLScriptElement | null;
    const fromCurrent = coreFolderOf(current && current.src);
    if (fromCurrent || (current && current.src)) return fromCurrent;
    const tags = document.querySelectorAll('script[src]');
    for (let i = tags.length - 1; i >= 0; i--) {
      const folder = coreFolderOf((tags[i] as HTMLScriptElement).src);
      if (folder) return folder;
    }
  } catch {
    /* no DOM access */
  }
  return null;
}
const OWN_FOLDER = readOwnFolder();

/**
 * Where a lazily loaded file comes from, in order:
 *  1. the folder the core itself was loaded from (`coreFolderOf`), so a core
 *     from `sdk.joryio.com/web/1.4.0-beta.6/` or from the npm package's
 *     `dist/` on a CDN loads the side files of the same build - unless that
 *     folder is the major channel `sdk.joryio.com/web/<major>/`, which moves:
 *     then 2 goes first;
 *  2. the exact SDK version's folder on the SDK host (immutable, the same
 *     build as this core). A beta's SDK_VERSION is the beta's own version
 *     (from 1.4.0-beta.6 the release build stamps it), so this is
 *     `web/1.4.0-beta.6/`, the only folder a beta is published to;
 *  3. the major channel, as a fallback (a version not on the CDN, such as a
 *     local build) - never for a pre-release: the channel carries finals
 *     only, so a beta would get the previous final's side files.
 * An init option (`editorScriptUrl`, `cardsUiScriptUrl`) replaces all of
 * them, for a self-hosted SDK.
 */
export function sdkHostFileUrls(file: string, override?: string, ownFolder: string | null = OWN_FOLDER, version: string = SDK_VERSION): string[] {
  if (override) return [override];
  const major = version.split('.')[0];
  const exact = `${SDK_HOST}/web/${version}/${file}`;
  const channel = `${SDK_HOST}/web/${major}/${file}`;
  const prerelease = version.includes('-');
  let urls = ownFolder && ownFolder !== `${SDK_HOST}/web/${major}/` ? [`${ownFolder}${file}`, exact, channel] : [exact, channel];
  if (prerelease) urls = urls.filter((u) => u !== channel);
  return urls.filter((u, i) => urls.indexOf(u) === i);
}

/** Inject one script tag; resolves when it ran (onload), rejects on an error (a 404, a blocking CSP). */
export function loadSdkScript(src: string, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.setAttribute(marker, 'bundle');
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load ${src}`));
    };
    (document.head || document.documentElement).appendChild(s);
  });
}
