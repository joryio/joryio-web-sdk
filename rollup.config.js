import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { dts } from 'rollup-plugin-dts';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source-map `sources` never carry a path of the machine that built them
 * (rule 70): the published map is served from sdk.joryio.com and shipped in
 * the npm package. Rollup writes them relative to the map, which for a
 * dependency resolved through a symlinked node_modules climbed out of the
 * package into the builder's home directory ("../Users/<name>/..."). Files
 * of this package stay relative to the map ("../src/core/sdk.ts"); anything
 * outside it becomes "../node_modules/<package>/<file>" (or its bare name).
 * infra/scripts/publish-web-sdk.sh refuses a map that still holds one.
 */
function portableSourcePath(relativeSourcePath, sourcemapPath) {
  const mapDir = path.dirname(sourcemapPath);
  const absolute = path.resolve(mapDir, relativeSourcePath);
  const fromRoot = path.relative(PACKAGE_ROOT, absolute);
  const insidePackage = fromRoot && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot);
  const posix = (p) => p.split(path.sep).join('/');
  if (insidePackage && !fromRoot.split(path.sep).includes('node_modules')) {
    return posix(path.relative(mapDir, absolute));
  }
  const parts = posix(absolute).split('/node_modules/');
  const tail = parts.length > 1 ? parts[parts.length - 1] : path.basename(absolute);
  return posix(path.relative(mapDir, path.join(PACKAGE_ROOT, 'node_modules'))) + '/' + tail;
}

const banner = `/**
 * Joryio Web SDK v${pkg.version}
 * (c) ${new Date().getFullYear()} Joryio. All rights reserved.
 * @license Commercial - see https://github.com/joryio/joryio-web-sdk/blob/main/LICENSE
 */`;

/**
 * The script-tag build's module wrapper (dist/joryio.umd.js, dist/joryio.min.js).
 *
 * NOT Rollup's `format: 'umd'`: that wrapper calls an ANONYMOUS `define()`
 * whenever the page has an AMD loader (`define.amd`), and runs the SDK only
 * when the loader runs that module. Loaded by a plain <script> - the hosted
 * file on sdk.joryio.com, the async snippet, the Magento / WooCommerce /
 * PrestaShop / Shopify loaders - on a RequireJS page (every Magento Luma
 * store) that anonymous define is a module RequireJS did not ask for: it
 * either names it after whichever Magento module loads next (Magento's
 * knockout template engine became the SDK - "templateEngine must inherit
 * from ko.templateEngine", the checkout stuck on its spinner) or throws
 * "Mismatched anonymous define() module", and `window.Joryio` was never set
 * (owner QA 2026-10-26, Magento 2.4.7 Luma, SDK 1.3.2).
 *
 * So, the jQuery pattern: the SDK always runs and always sets its globals
 * (`window.Joryio`, `JoryioSDK`), and an AMD page gets a define it can place:
 *  - CommonJS (`module.exports`): exported, as before;
 *  - RequireJS asked for this file (its <script> carries
 *    `data-requiremodule`): an anonymous define, which RequireJS names after
 *    the module it requested - `require(['anything-mapped-to-this-url'])`
 *    keeps working;
 *  - any other load on an AMD page: the NAMED define 'joryio-web-sdk', which
 *    a loader queues without attaching it to another module.
 * ES module and CommonJS builds are untouched (they have no wrapper).
 * Pinned by src/umd-wrapper.spec.ts.
 */
const AMD_MODULE_ID = 'joryio-web-sdk';
const scriptTagOutro = `
(function (root, ns) {
  if (typeof module === 'object' && module && typeof module.exports === 'object') { module.exports = ns; return; }
  if (root) { root.JoryioSDK = ns; }
  if (typeof define === 'function' && define.amd) {
    var script = typeof document !== 'undefined' ? document.currentScript : null;
    if (script && typeof script.getAttribute === 'function' && script.getAttribute('data-requiremodule')) {
      define(function () { return ns; });
    } else {
      define('${AMD_MODULE_ID}', [], function () { return ns; });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, exports);`;

const baseConfig = {
  input: 'src/index.ts',
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      // The published map embeds the sources (sourcesContent): its
      // `../src/...` paths are not uploaded next to it on sdk.joryio.com, so
      // without them the CDN map resolved nothing (scan 7 N5). The sources
      // carry no local paths.
      inlineSources: true,
      declarationDir: './dist',
      rootDir: './src',
    }),
  ],
};

export default [
  // Script-tag build, unminified (see scriptTagOutro for the wrapper)
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.umd.js',
      format: 'iife',
      name: 'JoryioSDK',
      outro: scriptTagOutro,
      banner,
      exports: 'named',
      globals: {},
    },
  },

  // Script-tag build, minified - the hosted sdk.joryio.com file
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.min.js',
      format: 'iife',
      name: 'JoryioSDK',
      outro: scriptTagOutro,
      // No output.banner here — terser's `format.preamble` (below) already emits
      // the banner and survives minification; setting both duplicates it.
      exports: 'named',
      globals: {},
      sourcemap: true,
      sourcemapPathTransform: portableSourcePath,
    },
    plugins: [
      ...baseConfig.plugins,
      terser({
        format: {
          comments: /^!/,
          preamble: banner,
        },
        compress: {
          passes: 2,
          unsafe: true,
          unsafe_comps: true,
          unsafe_math: true,
          unsafe_methods: true,
        },
        mangle: {
          properties: {
            // `_private` fields only. NOT names starting with `__`: those are
            // contracts with code outside this bundle - `__esModule` (read by
            // every bundler's ES-module interop), and the `__joryio*` keys the
            // in-app iframe and the snippet queue use. /^_/ renamed
            // `__esModule`, so `import JoryioSDK from '@joryio/web-sdk'`
            // resolved to the module object instead of the class in any
            // bundler that picked this file.
            regex: /^_[^_]/,
          },
        },
      }),
    ],
  },

  // ESM build (bundlers via `module`/`exports.import`, and Node ESM). `.mjs`
  // so Node loads it as ESM: as `.js` in a package without "type": "module"
  // Node read it as CommonJS, and `import JoryioSDK from '@joryio/web-sdk'`
  // gave the module object instead of the class (rule 70).
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.mjs',
      format: 'es',
      banner,
      exports: 'named',
    },
  },

  // CommonJS build (for Node.js)
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.cjs.js',
      format: 'cjs',
      banner,
      exports: 'named',
    },
  },

  // Service worker bundle — shipped separately to sdk.joryio.com/web/1/joryio-sw.js.
  // Customer hosts a 1-line stub at their domain root that importScripts() this file.
  // Plain JS (no TS) — avoids lib:["WebWorker","DOM"] conflicts.
  {
    input: 'src/worker/joryio-sw.js',
    plugins: [
      resolve({ browser: true, preferBuiltins: false }),
      commonjs(),
      terser({ format: { preamble: banner } }),
    ],
    output: {
      file: 'dist/joryio-sw.js',
      format: 'iife',
      // No output.banner — terser's `format.preamble` already adds it (and
      // setting both is what produced the doubled banner in the served SW).
    },
  },
  // Types for `import` (exports map): one ES-format declaration bundle, so
  // TypeScript's node16/bundler resolution types the default import as the
  // class. The CommonJS `require` side keeps dist/index.d.ts. Runs last: it
  // reads the declarations the TypeScript plugin wrote above.
  {
    input: 'dist/index.d.ts',
    plugins: [dts()],
    output: {
      file: 'dist/index.d.mts',
      format: 'es',
    },
  },
];
