/**
 * The script-tag build (dist/joryio.min.js, dist/joryio.umd.js) on a page
 * with an AMD loader.
 *
 * Owner QA 2026-10-26, Magento 2.4.7 Luma: SDK 1.3.2 (Rollup `format:
 * 'umd'`) loaded by a plain <script> called an ANONYMOUS define() because
 * the page had RequireJS. RequireJS bound it to the next Magento module to
 * load (the checkout's knockout template engine: "templateEngine must inherit
 * from ko.templateEngine") or threw "Mismatched anonymous define() module:
 * function(t){"use strict";const i="1.3.2"...", the checkout stayed on its
 * spinner, and `window.Joryio` was never set.
 *
 * The wrapper is now rollup.config.js `scriptTagOutro`: the SDK always runs
 * and sets `window.Joryio` / `JoryioSDK`; it defines anonymously only when
 * RequireJS requested the file (`data-requiremodule` on its <script>), and
 * otherwise defines the NAMED module 'joryio-web-sdk'. This test builds the
 * real bundle and loads it into a page whose loader follows RequireJS 2.3's
 * queue rules (takeGlobalQueue / completeLoad / intakeDefines).
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as vm from 'vm';

const ROOT = join(__dirname, '..');
const MIN = join(ROOT, 'dist/joryio.min.js');
const UMD = join(ROOT, 'dist/joryio.umd.js');
const SDK_URL = 'https://sdk.joryio.com/web/1/joryio.min.js';
const BASE = 'https://store.test/static/';

let bundles: Record<'min' | 'umd', string>;

beforeAll(() => {
  // The bundle under test is built from this checkout, not taken from a stale dist/.
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['rollup', '-c', '--silent'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  expect(existsSync(MIN)).toBe(true);
  bundles = { min: readFileSync(MIN, 'utf8'), umd: readFileSync(UMD, 'utf8') };
}, 300_000);

type ScriptNode = {
  src?: string;
  attrs: Record<string, string>;
  listeners: Record<string, Array<() => void>>;
  onload?: () => void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, fn: () => void): void;
};

/** A page: a vm context with a minimal DOM whose <head> runs appended scripts in order. */
function makePage(files: Record<string, string>, withRequireJs: boolean) {
  const errors: string[] = [];
  const queue: ScriptNode[] = [];
  const node = (): ScriptNode => ({
    attrs: {},
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  });
  const storage = new Map<string, string>();
  const win: any = {
    document: {
      currentScript: null,
      cookie: '',
      createElement: node,
      head: { appendChild: (n: ScriptNode) => queue.push(n) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      visibilityState: 'visible',
    },
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
    },
    navigator: { userAgent: 'test', language: 'en' },
    location: { href: 'https://store.test/checkout/', search: '', hostname: 'store.test' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, console,
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  vm.createContext(win);

  const exec = (source: string, current: ScriptNode | null) => {
    win.document.currentScript = current;
    try { vm.runInContext(source, win); } catch (e: any) { errors.push(String(e?.message)); }
    win.document.currentScript = null;
  };

  // ---- RequireJS 2.3's module queue, small ----
  const rjs = {
    globalDefQueue: [] as Array<[string | null, string[], any]>,
    registry: {} as Record<string, { deps: string[]; factory: any }>,
    defined: {} as Record<string, unknown>,
    requested: new Set<string>(),
    paths: {} as Record<string, string>,
    waiters: [] as Array<{ deps: string[]; cb: (...a: unknown[]) => void }>,
  };
  const register = ([name, deps, factory]: [string, string[], any]) => {
    if (!(name in rjs.registry)) rjs.registry[name] = { deps, factory };
    deps.forEach(load);
  };
  const resolve = () => {
    let progress = true;
    while (progress) {
      progress = false;
      for (const [name, m] of Object.entries(rjs.registry)) {
        if (name in rjs.defined || !m.deps.every((d) => d === 'exports' || d in rjs.defined)) continue;
        const exports = {};
        let value: unknown;
        try {
          value = typeof m.factory === 'function'
            ? m.factory(...m.deps.map((d) => (d === 'exports' ? exports : rjs.defined[d])))
            : m.factory;
        } catch (e: any) { errors.push(String(e?.message)); }
        rjs.defined[name] = m.deps.includes('exports') && value === undefined ? exports : value;
        progress = true;
      }
      for (const w of [...rjs.waiters]) {
        if (!w.deps.every((d) => d in rjs.defined)) continue;
        rjs.waiters.splice(rjs.waiters.indexOf(w), 1);
        try { w.cb(...w.deps.map((d) => rjs.defined[d])); } catch (e: any) { errors.push(String(e?.message)); }
        progress = true;
      }
    }
  };
  /** require.js completeLoad: the first anonymous define takes the loaded module's name. */
  const completeLoad = (moduleName: string) => {
    let found = false;
    while (rjs.globalDefQueue.length) {
      const args = rjs.globalDefQueue.shift()!;
      if (args[0] === null) {
        args[0] = moduleName;
        if (found) break;
        found = true;
      } else if (args[0] === moduleName) {
        found = true;
      }
      register(args as [string, string[], any]);
    }
    if (!found && !(moduleName in rjs.registry)) register([moduleName, [], undefined]);
    resolve();
  };
  /** require.js intakeDefines: an anonymous define nobody requested is an error. */
  const intakeDefines = () => {
    while (rjs.globalDefQueue.length) {
      const args = rjs.globalDefQueue.shift()!;
      if (args[0] === null) {
        errors.push('Mismatched anonymous define() module: ' + String(args[args.length - 1]).slice(0, 40));
        return;
      }
      register(args as [string, string[], any]);
    }
  };
  function load(id: string) {
    if (id === 'exports' || id in rjs.defined || rjs.requested.has(id)) return;
    rjs.requested.add(id);
    const n = node();
    n.src = (rjs.paths[id] || BASE + id) + '.js';
    n.setAttribute('data-requiremodule', id);
    n.addEventListener('load', () => completeLoad(id));
    win.document.head.appendChild(n);
  }
  if (withRequireJs) {
    const define: any = (name: any, deps?: any, factory?: any) => {
      if (typeof name !== 'string') { factory = deps; deps = name; name = null; }
      if (!Array.isArray(deps)) { factory = deps; deps = []; }
      rjs.globalDefQueue.push([name, deps, factory]);
    };
    define.amd = { jQuery: true };
    const require: any = (deps: string[], cb: (...a: unknown[]) => void) => {
      intakeDefines();
      rjs.waiters.push({ deps, cb });
      deps.forEach(load);
      resolve();
    };
    require.config = (c: { paths?: Record<string, string> }) => Object.assign(rjs.paths, c.paths || {});
    win.define = define;
    win.require = require;
  }

  return {
    win,
    rjs,
    errors,
    /** A plain <script src> the page (or a storefront loader) adds. */
    scriptTag(src: string) { const n = node(); n.src = src; win.document.head.appendChild(n); },
    exec: (source: string) => exec(source, null),
    settle() {
      for (let i = 0; queue.length && i < 100; i++) {
        const n = queue.shift()!;
        const body = n.src ? files[n.src] : undefined;
        if (body === undefined) { errors.push(`404 ${n.src}`); continue; }
        exec(body, n);
        n.onload?.();
        (n.listeners.load || []).forEach((fn) => fn());
      }
    },
  };
}

/** Magento's checkout, small: knockout, its template engine, the bootstrap that checks it. */
const CHECKOUT: Record<string, string> = {
  [BASE + 'ko.js']: 'define([], function () { function templateEngine() {} return { templateEngine: templateEngine }; });',
  [BASE + 'engine.js']: "define(['ko'], function (ko) { function E() {} E.prototype = new ko.templateEngine(); return new E(); });",
  [BASE + 'bootstrap.js']: `define(['ko', 'engine'], function (ko, engine) {
    if (!(engine instanceof ko.templateEngine)) { throw new Error('templateEngine must inherit from ko.templateEngine'); }
    window.checkoutReady = true; return {};
  });`,
};

describe.each(['min', 'umd'] as const)('dist/joryio.%s.js on an AMD page', (which) => {
  it('a plain <script> on a RequireJS checkout: no mismatched define, the checkout starts, window.Joryio is set', () => {
    const page = makePage({ ...CHECKOUT, [SDK_URL]: bundles[which] }, true);
    page.scriptTag(SDK_URL); // the SDK first, as the storefront loaders run before the checkout
    page.exec("require(['bootstrap'], function () {});");
    page.settle();
    page.exec("require(['bootstrap'], function () {});"); // a later require() meets anything left in the queue
    page.settle();
    expect(page.errors).toEqual([]);
    expect(page.win.checkoutReady).toBe(true);
    expect(typeof page.win.Joryio).toBe('function');
    expect(page.win.JoryioSDK.default).toBe(page.win.Joryio);
    // Named, so RequireJS can place it - and nothing else became the SDK.
    expect(page.rjs.registry['joryio-web-sdk']).toBeDefined();
    expect((page.rjs.defined.bootstrap as any)?.default).toBeUndefined();
  });

  it('loaded through require() under any id: the module is the SDK namespace, the global is set too', () => {
    const page = makePage({ ...CHECKOUT, 'https://cdn.test/sdk.js': bundles[which] }, true);
    page.exec("require.config({ paths: { anySdk: 'https://cdn.test/sdk' } });");
    let mod: any;
    page.win.__got = (m: unknown) => (mod = m);
    page.exec("require(['anySdk', 'bootstrap'], function (m) { window.__got(m); });");
    page.settle();
    expect(page.errors).toEqual([]);
    expect(page.win.checkoutReady).toBe(true);
    expect(mod.default).toBe(page.win.Joryio);
    expect(mod.JoryioSDK).toBe(page.win.Joryio);
    expect(mod.SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('loaded through require("joryio-web-sdk") (the storefront loaders\' id)', () => {
    const page = makePage({ [SDK_URL]: bundles[which] }, true);
    page.exec("require.config({ paths: { 'joryio-web-sdk': 'https://sdk.joryio.com/web/1/joryio.min' } });");
    let mod: any;
    page.win.__got = (m: unknown) => (mod = m);
    page.exec("require(['joryio-web-sdk'], function (m) { window.__got(m); });");
    page.settle();
    expect(page.errors).toEqual([]);
    expect(mod.default).toBe(page.win.Joryio);
  });

  it('no AMD loader: the globals, as before', () => {
    const page = makePage({ [SDK_URL]: bundles[which] }, false);
    page.scriptTag(SDK_URL);
    page.settle();
    expect(page.errors).toEqual([]);
    expect(typeof page.win.Joryio).toBe('function');
    expect(page.win.JoryioSDK.default).toBe(page.win.Joryio);
    expect(page.win.JoryioSDK.__esModule).toBe(true);
  });

  it('CommonJS (require() of the file): module.exports is the namespace', () => {
    const mod: any = { exports: {} };
    const sandbox: any = { module: mod, exports: mod.exports, console, setTimeout, clearTimeout, URL };
    vm.runInNewContext(bundles[which], sandbox);
    expect(typeof mod.exports.default).toBe('function');
    expect(mod.exports.JoryioSDK).toBe(mod.exports.default);
    expect(mod.exports.__esModule).toBe(true);
  });
});

it('the ES module and CommonJS builds carry no AMD wrapper', () => {
  for (const f of ['dist/joryio.mjs', 'dist/joryio.cjs.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    expect(src).not.toContain('define.amd');
  }
});
