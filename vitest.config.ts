import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Workspace packages resolve to their sources, mirroring the `paths` in
 * tsconfig.base.json. Tests then run against the code as written rather than
 * against the last build, so a stale dist can never make a suite pass.
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Projects do not inherit the root `resolve`, so each one gets its own copy.
const workspaceAliases = {
  '@dwara/core': pkg('core'),
  '@dwara/tools': pkg('tools'),
  '@dwara/mcp-server': pkg('mcp-server'),
  '@dwara/cli': pkg('cli'),
  '@dwara/hook': pkg('hook'),
};

export default defineConfig({
  resolve: { alias: workspaceAliases },
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
        resolve: { alias: workspaceAliases },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: workspaceAliases },
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
