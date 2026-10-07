import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'testbed/app/**',
      // The plugin bundles a built copy of the hook; the source is linted
      // where it lives, in packages/hook/src.
      'packages/plugin-claude-code/hook/**',
      // And the published package copies the whole plugin in at build time.
      'packages/dwara/plugin/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: strict TS, no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  {
    // Plain .mjs build scripts run under node with no TypeScript lib, so the
    // globals have to be declared, and printing progress is their whole job.
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    // The CLI, the hook binary and the benchmark runner talk to the user over
    // stdio.
    files: ['packages/cli/**/*.ts', 'packages/hook/**/*.ts', 'evals/runner/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
