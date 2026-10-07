import { builtinModules } from 'node:module';
import { defineConfig } from 'tsup';

/**
 * The single published artifact: three binaries, one package.
 *
 * `noExternal` inlines this repository's own packages and nothing else. The six
 * third-party dependencies stay external and are declared as real
 * `dependencies`, which keeps the tarball small, keeps them visible to
 * `npm audit`, and avoids re-shipping other people's code under our licence.
 *
 * Node's builtins are listed as external explicitly, including the `x/promises`
 * submodules. `platform: 'node'` is not enough: the CLI imports
 * `readline/promises` for its prompts and esbuild failed to resolve it, which is
 * how this config came to have the list at all. `@dwara/hook`'s config carries the
 * same list and the same note -- bundling builtins also makes esbuild rewrite
 * `require('process')` inside a CommonJS dependency into a shim that throws, and
 * `yaml`, reached through the policy loader, does exactly that.
 */
export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    mcp: 'src/mcp.ts',
    hook: 'src/hook.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@dwara\//],
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
});
