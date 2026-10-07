/**
 * Copies the Claude Code plugin into the published package.
 *
 * The plugin is a directory of files -- slash commands, a skill, hooks.json,
 * permission settings -- plus a **fully inlined** copy of the hook. It cannot use
 * the `dwara-hook` binary this package installs: a plugin installed from a
 * marketplace has no node_modules beside it, and `hooks.json` points at a path
 * under CLAUDE_PLUGIN_ROOT rather than at something on PATH.
 *
 * So the published tarball carries both: `dist/hook.js` for the binary, and
 * `plugin/hook/index.js` for the plugin. They are the same source, built twice,
 * which is why `@dwara/hook`'s tsup config has two entries.
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const plugin = join(pkg, '../plugin-claude-code');
const out = join(pkg, 'plugin');

/** Fails loudly: a silently missing plugin asset ships a broken plugin. */
async function require_(path) {
  try {
    await access(path);
  } catch {
    throw new Error(
      `cannot build the published package: ${path} is missing. ` +
        'Run the workspace build first -- @dwara/plugin-claude-code must build before this.',
    );
  }
}

await mkdir(out, { recursive: true });

for (const name of ['commands', 'skills', 'hooks', '.claude-plugin', 'hook']) {
  const from = join(plugin, name);
  await require_(from);
  await cp(from, join(out, name), { recursive: true });
}

// The README npm renders on the package page, and the licence text. Copied from
// the repository root rather than duplicated: a package that declares
// Apache-2.0 and ships no LICENSE has not actually granted anything, and a
// published package with no README gets a blank page.
for (const name of ['README.md', 'LICENSE']) {
  const from = join(pkg, '../..', name);
  await require_(from);
  await cp(from, join(pkg, name));
}

console.log('plugin assets, README and LICENSE copied');
