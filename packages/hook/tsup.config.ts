import { builtinModules } from 'node:module';
import { defineConfig } from 'tsup';

/**
 * Two builds, because the hook ships two ways.
 *
 * `index.js` is the ordinary library/bin build, with dependencies left
 * external and resolved from node_modules.
 *
 * `standalone.js` inlines everything. A Claude Code plugin installed from a
 * marketplace is a directory of files with **no node_modules beside it**, so a
 * build with external imports fails at the first `import 'shell-quote'`. That
 * is not hypothetical: the Phase 4 exit gate ran the plugin's bundled copy and
 * it died exactly there.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { standalone: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    dts: false,
    sourcemap: false,
    clean: false,
    platform: 'node',
    // Everything in, so the file runs on its own -- except node's own
    // builtins, which must stay external. Bundling those makes esbuild
    // replace `require('process')` inside a CommonJS dependency with a shim
    // that throws, and `yaml` does exactly that.
    noExternal: [/.*/],
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    // Some of what gets pulled in is CommonJS -- `yaml`, through the policy
    // loader -- and bundling CJS into ESM leaves calls to `require` that an
    // ES module does not have. This puts one back.
    //
    // The alternative was a second, dependency-free policy reader inside the
    // hook. That would be smaller and faster, and it would be a second parser
    // that can disagree with the real one about which hosts are managed. For
    // a security control, one parser is worth the kilobytes.
    banner: {
      js: "import { createRequire as __dwaraRequire } from 'node:module';\nconst require = __dwaraRequire(import.meta.url);",
    },
  },
]);
