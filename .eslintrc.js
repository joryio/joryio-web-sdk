/**
 * Lint for the web SDK.
 *
 * The package advertised `"lint": "eslint src --ext .ts"` with no config, so the
 * script had never once run - which is worse than having no script, because it
 * looks like coverage.
 *
 * Deliberately weighted toward RULES THAT CATCH BUGS rather than style. Style
 * rules in a codebase that has never been linted produce hundreds of findings and
 * train everyone to ignore the output; the point here is that a red lint means
 * something. `no-floating-promises` in particular is not decoration: an
 * unhandled rejection inside an SDK surfaces in the HOST page's error handlers
 * and lands in their monitoring as if their app had failed. We shipped exactly
 * that bug (a bare `void this._push.subscribe()`) and found it by reading, not
 * by tooling.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  env: { browser: true, es2020: true },
  // test-harness.ts is test support: tsconfig excludes it, so the type-aware
  // parser cannot load it and reported a parse error instead of linting.
  ignorePatterns: ['dist/', 'node_modules/', '*.spec.ts', 'test-harness.ts', '.eslintrc.js', 'rollup.config.js'],
  rules: {
    // --- the bug-catching core ---
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-constant-condition': 'error',
    'no-fallthrough': 'error',
    'no-self-compare': 'error',
    'no-unreachable': 'error',
    eqeqeq: ['error', 'smart'],

    // --- guest-in-someone-else's-page hygiene ---
    // An SDK writing to the host page's console is noise in THEIR devtools.
    // Warn rather than error: the logger is opt-in and gated behind enableDebug.
    'no-console': 'warn',
    '@typescript-eslint/no-explicit-any': 'off', // pervasive at the wire boundary; not a bug signal here
  },
  overrides: [
    {
      // The logger's entire job is writing to the console.
      files: ['src/utils/logger.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // Push setup failures warn unconditionally, by design: an integrator must
      // see "push is not enabled and here is why" even with debug logging off,
      // because the alternative is a channel that silently never delivers.
      files: ['src/core/push.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
