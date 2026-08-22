import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.tmp-*/` are per-run scratch directories created by
    // `mkdtempSync` in tests and scripts (the stdio smoke uses
    // `.tmp-s7-mcp-*`, replay tests use `.tmp-test-*`). They contain
    // generated `.mjs` shims with bare Node globals (`console`,
    // `process`) which would otherwise trip `no-undef`. `test-stdio.mjs`
    // is a developer scratch probe at the repo root — same globals, no
    // contract — so it is excluded from the linter too. Canonical
    // sources under `scripts/` and `tests/` still go through lint.
    //
    // `packages/sdk-{ts,python}/generated/**` are OpenAPI Generator
    // 7.10.0 output, fully owned by `scripts/generate-sdks.mjs`. The
    // generator writes its own `/* eslint-disable */` banners into the
    // TS index files, and the Python tree ships boilerplate (tox.ini,
    // setup.cfg, git_push.sh, ...) that carries no contract for us.
    // Linting generated code has zero signal: it can only either be
    // ignored wholesale (in which case warnings like "Unused
    // eslint-disable directive" leak through) or pollute the lint
    // output with noise from upstream. Both are wrong. We exclude the
    // trees here and trust the generator contract (PROVENANCE.json +
    // sdk-drift tests) to detect real changes to the OpenAPI surface.
    ignores: [
      'dist/**',
      'packages/*/dist/**',
      'packages/sdk-ts/generated/**',
      'packages/sdk-python/generated/**',
      'slices/**',
      'node_modules/**',
      'artifacts/**',
      'baseline/**',
      'rejected/**',
      '.tmp-*/',
      'test-stdio.mjs',
    ],
  },
  {
    files: ['scripts/**/*.mjs', 'examples/**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
    rules: { 'no-console': 'off' },
  },
);
