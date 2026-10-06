import { isAbsolute, join } from 'node:path';

/**
 * Making the testbed's SSH config usable from anywhere.
 *
 * `testbed/ssh_config` says its paths are relative to the repo root, and for
 * every other caller that is true: testbed scripts and integration tests run
 * from there. The benchmark does not. The agent runs in a neutral temp
 * directory, the MCP server inherits that directory, and `ssh` resolves
 * `IdentityFile testbed/.keys/dwara_lab` against it — so the key is simply not
 * there and every host answers `Permission denied (publickey)`.
 *
 * This cost a real run to find, and the failure was indistinguishable from a
 * misconfigured lab: policy allowed the call, SSH refused it.
 *
 * Rewriting the file keeps the committed one honest about its own contract
 * rather than making every other caller carry an absolute path.
 */

/** Keywords whose value is a path, and so has to be made absolute. */
const PATH_KEYWORDS = new Set(['identityfile', 'userknownhostsfile', 'certificatefile']);

/**
 * Returns `text` with every relative path option resolved against `repoDir`.
 *
 * Leaves absolute paths, `~` paths and everything else exactly as written: an
 * option this does not recognise is one it must not touch.
 */
export function absoluteSshConfig(text: string, repoDir: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /^(\s*)([A-Za-z]+)(\s+)(.*)$/.exec(line);
      if (match === null) return line;

      const [, indent = '', keyword = '', gap = '', value = ''] = match;
      if (!PATH_KEYWORDS.has(keyword.toLowerCase())) return line;

      const path = value.trim();
      if (path === '' || isAbsolute(path) || path.startsWith('~') || path.startsWith('"')) {
        return line;
      }

      return `${indent}${keyword}${gap}${join(repoDir, path)}`;
    })
    .join('\n');
}
