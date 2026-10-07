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
  // UMD build (for direct browser usage via <script> tag)
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.umd.js',
      format: 'umd',
      name: 'JoryioSDK',
      banner,
      exports: 'named',
      globals: {},
    },
  },

  // UMD minified build
  {
    ...baseConfig,
    output: {
      file: 'dist/joryio.min.js',
      format: 'umd',
      name: 'JoryioSDK',
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
