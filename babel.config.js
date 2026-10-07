// Used ONLY by babel-jest to transform TS test files (the package had no TS test
// transform, so `.spec.ts` couldn't run). The production bundle is built by
// Rollup's own @rollup/plugin-typescript and does NOT use this config.
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript',
  ],
};
