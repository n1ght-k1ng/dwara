/**
 * Which files a read tool may open.
 *
 * Two lists, with different standing. The **deny-list lives in code and no
 * policy can override it** — the same shape as the destructive floor, because a
 * boundary a policy file could lift is not a boundary. The allow-list has a
 * sensible default that policy may extend, because nobody can enumerate in
 * advance where a given shop keeps its service configuration.
 *
 * The lexical checks matter as much as the lists. A captured fixture in this
 * package shows `readlink -f /etc/nginx/../shadow` resolving to `/etc/shadow` on
 * a real host: any guard that trusts the requested string is already defeated.
 */

/**
 * Never readable, whatever the policy says.
 *
 * Password hashes, private keys, environment files, shell history and netrc:
 * the things whose disclosure is the incident, rather than a step towards one.
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

/** Readable by default. Policy may add to this; it cannot remove the deny-list. */
export const DEFAULT_CONFIG_PATHS: readonly string[] = [
  '/etc/os-release',
  '/etc/hostname',
  '/etc/hosts',
  '/etc/fstab',
  '/etc/resolv.conf',
  '/etc/timezone',
  '/etc/nginx/**',
  '/etc/apache2/**',
  '/etc/httpd/**',
  '/etc/systemd/**',
  '/etc/postgresql/**',
  '/etc/redis/**',
  '/etc/mysql/**',
  '/etc/php/**',
  '/etc/logrotate.conf',
  '/etc/logrotate.d/**',
  '/etc/cron.d/**',
  '/etc/crontab',
  '/etc/ssh/sshd_config',
  '/etc/ssh/sshd_config.d/**',
  '/etc/docker/daemon.json',
  '/proc/meminfo',
  '/proc/cpuinfo',
  '/proc/loadavg',
  '/proc/uptime',
  '/proc/mounts',
] as const;

/** Where `tail_logs` may read a file from. */
export const DEFAULT_LOG_PATHS: readonly string[] = ['/var/log/**'] as const;

export type PathGuardResult =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Compiles a path glob.
 *
 * `**` crosses directory separators, `*` and `?` do not — the usual convention,
 * and the one that makes `/etc/nginx/**` mean the whole tree while
 * `/etc/ssh/*_key` stays within one directory.
 */
function toRegExp(pattern: string): RegExp {
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

function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => toRegExp(pattern).test(path));
}

/** Collapses duplicate separators and drops a trailing one. */
function normalise(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/**
 * Decides whether a path may be read.
 *
 * Order is deliberate. The lexical checks run first, so a traversal attempt is
 * refused before any command is built — no bytes leave the host and nothing
 * reaches Dwara's memory. Then deny, then allow. A path matching neither list is
 * refused: an allow-list that defaults to yes is not an allow-list.
 */
export function guardPath(
  requested: string,
  allowed: readonly string[],
  extraAllowed: readonly string[] = [],
): PathGuardResult {
  if (!requested.startsWith('/')) {
    return { ok: false, reason: 'path must be absolute' };
  }

  // Refused lexically rather than resolved on the host. `/etc/nginx/../shadow`
  // resolves to /etc/shadow, so a guard that checked only the final resolved
  // path would have to read the file to find out.
  if (requested.split('/').includes('..')) {
    return { ok: false, reason: 'path must not contain ".."' };
  }

  // eslint-disable-next-line no-control-regex -- rejecting controls is the point
  if (/[\u0000-\u001f\u007f]/u.test(requested)) {
    return { ok: false, reason: 'path must not contain control characters' };
  }

  const path = normalise(requested);

  if (matchesAny(DENIED_PATHS, path)) {
    return {
      ok: false,
      reason: `"${path}" is on Dwara's permanent deny-list; no policy can allow it`,
    };
  }

  if (!matchesAny([...allowed, ...extraAllowed], path)) {
    return {
      ok: false,
      reason: `"${path}" is not in the allowed paths; add it to the policy if it should be readable`,
    };
  }

  return { ok: true, path };
}

/**
 * Re-checks a path the host resolved for us.
 *
 * `read_config` reports the target of `readlink -f` alongside the content. If
 * that target is on the deny-list, a symlink inside an allowed directory was
 * pointing somewhere it should not, and the content is withheld.
 *
 * This is defence in depth, not the primary guard: the read has already
 * happened by the time we see it. Closing that fully needs the command for the
 * second stage to depend on the first stage's output, which the Phase 2
 * pipeline does not do. Planting such a symlink also requires root on the host
 * already, at which point the file is readable without Dwara's help.
 */
export function resolvedPathIsDenied(resolved: string): boolean {
  return matchesAny(DENIED_PATHS, normalise(resolved.trim()));
}
