/**
 * Path rules that hold for every tool, wherever a path comes from.
 *
 * The deny-list lives here rather than in `@dwara/tools` because it is not a
 * property of reading: a snapshot copies files to a directory that survives the
 * action, so a tool that could snapshot `/etc/shadow` would leave a root-owned
 * copy of it behind whether or not anything ever read the original. One list,
 * enforced at every point a path enters a command.
 *
 * The lexical checks matter as much as the list. A captured fixture in
 * `@dwara/tools` shows `readlink -f /etc/nginx/../shadow` resolving to
 * `/etc/shadow` on a real host: any guard that trusts the requested string is
 * already defeated.
 */

/**
 * Never readable or copyable, whatever the policy says.
 *
 * Password hashes, private keys, environment files, shell history and netrc:
 * the things whose disclosure is the incident, rather than a step towards one.
 * The same standing as the destructive floor — a boundary a policy file could
 * lift is not a boundary.
 */
export const DENIED_PATHS: readonly string[] = [
  '/etc/shadow',
  '/etc/shadow-',
  '/etc/gshadow',
  '/etc/gshadow-',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  '/etc/ssh/*_key',
  '/root/**',
  '**/.ssh/**',
  '**/id_rsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/.env',
  '**/.env.*',
  '**/.netrc',
  '**/.pgpass',
  '**/.git-credentials',
  '**/.*_history',
  '**/.aws/**',
  '**/.kube/config',
  '**/.docker/config.json',
] as const;

/**
 * Compiles a path glob.
 *
 * `**` crosses directory separators, `*` and `?` do not — the usual convention,
 * and the one that makes `/etc/nginx/**` mean the whole tree while
 * `/etc/ssh/*_key` stays within one directory.
 */
export function globToRegExp(pattern: string): RegExp {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*';
        i += 1;
      } else {
        body += '[^/]*';
      }
    } else if (char === '?') {
      body += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      body += `\\${char}`;
    } else {
      body += char;
    }
  }
  return new RegExp(`^${body}$`);
}

/** True when `path` matches any of the globs. */
export function matchesGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** Collapses duplicate separators and drops a trailing one. */
export function normalisePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/**
 * Why this path may not be used in a command, or undefined when it is fine.
 *
 * Purely lexical, so it refuses a traversal attempt before any command is
 * built — nothing leaves for the host and nothing comes back. Says nothing
 * about allow-lists, which differ per tool.
 */
export function lexicalPathProblem(requested: string): string | undefined {
  if (!requested.startsWith('/')) return 'path must be absolute';

  // `/etc/nginx/../shadow` resolves to /etc/shadow, so a guard that checked
  // only the final resolved path would have to read the file to find out.
  if (requested.split('/').includes('..')) return 'path must not contain ".."';

  // eslint-disable-next-line no-control-regex -- rejecting controls is the point
  if (/[\u0000-\u001f\u007f]/u.test(requested)) {
    return 'path must not contain control characters';
  }

  return undefined;
}

/** True when the path is on the permanent deny-list. */
export function pathIsDenied(path: string): boolean {
  return matchesGlob(DENIED_PATHS, normalisePath(path.trim()));
}
