import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'testbed/app/**'],
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
    // The CLI and the hook binary talk to the user over stdio.
    files: ['packages/cli/**/*.ts', 'packages/hook/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
