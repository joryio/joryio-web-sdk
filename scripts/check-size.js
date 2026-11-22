#!/usr/bin/env node
/**
 * Bundle size budget for the hosted web SDK (BACKLOG D444 Phase 4 follow-up).
 *
 * `joryio.min.js` is loaded on every page of every customer site, so its
 * gzip size is a product property, not a build detail. CI runs this after
 * `npm run build` and fails when a file grows past its budget in
 * `size-budget.json`. A deliberate increase raises the budget in the same PR,
 * with the reason in the PR body - the number is then a reviewed decision.
 *
 *   npm run build && npm run size          # check
 *   npm run size -- --report               # print only, never fail
 *
 * gzip level 9 (what a CDN serves at best; brotli is smaller still).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const budget = JSON.parse(fs.readFileSync(path.join(root, 'size-budget.json'), 'utf8'));
const reportOnly = process.argv.includes('--report');
let failed = false;

for (const [file, limit] of Object.entries(budget.files)) {
  const p = path.join(root, 'dist', file);
  if (!fs.existsSync(p)) {
    console.error(`${file}: not built (run npm run build first)`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(p);
  const gzip = zlib.gzipSync(raw, { level: 9 }).length;
  const over = gzip > limit.gzipBytes;
  console.log(`${over ? 'OVER ' : 'ok   '} ${file}: ${raw.length} bytes raw, ${gzip} bytes gzip (budget ${limit.gzipBytes} gzip)`);
  if (over) failed = true;
}

if (failed && !reportOnly) {
  console.error('\nA web SDK bundle is over its size budget (packages/sdk-web/size-budget.json). Make it smaller, or raise the budget in the same PR and say why.');
  process.exit(1);
}
