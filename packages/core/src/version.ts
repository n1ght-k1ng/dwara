import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The version of the package a module was built into, read from the
 * `package.json` beside it.
 *
 * **Found by installing the tarball, not by reading the code.** Every package
 * carried a hard-coded `VERSION = '0.0.0'`, so the first release would have
 * published `dwara@0.1.0` whose `dwara --version` answered `0.0.0` — and the bug
 * report template asks for exactly that number.
 *
 * Reading it leaves one source of truth. In the published bundle the nearest
 * manifest is `dwara`'s own, so every binary reports the released version; in a
 * workspace build it is that package's manifest, which honestly reports an
 * unpublished `0.0.0`.
 *
 * @param from an entry module's `import.meta.url`
 * @param fallback used when there is no readable manifest, such as the hook
 *   copy bundled into the Claude Code plugin
 */
export function packageVersion(from: string, fallback = '0.0.0'): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', from)), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : fallback;
  } catch {
    return fallback;
  }
}
