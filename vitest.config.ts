import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
      // The policy evaluator decides what an untrusted model is allowed to do.
      // Anything less than full coverage there means an untested branch is
      // making that decision. This is a Phase 1 exit criterion.
      thresholds: {
        'packages/core/src/policy/**': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // Testbed hosts are slow to converge after a restart.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
