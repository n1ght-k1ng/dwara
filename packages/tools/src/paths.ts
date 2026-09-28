import { DENIED_PATHS, lexicalPathProblem, matchesGlob, normalisePath } from '@dwara/core';

/**
 * Which files a read tool may open.
 *
 * Two lists, with different standing. The **deny-list lives in code and no
 * policy can override it** — it is re-exported from `@dwara/core`, because it
 * governs every path that reaches a command, not only the ones a read tool
 * opens: a snapshot leaves a root-owned copy behind, so it is bound by the same
 * list. The allow-list has a sensible default that policy may extend, because
 * nobody can enumerate in advance where a given shop keeps its service
 * configuration.
 *
 * The lexical checks matter as much as the lists. A captured fixture in this
 * package shows `readlink -f /etc/nginx/../shadow` resolving to `/etc/shadow` on
 * a real host: any guard that trusts the requested string is already defeated.
 */

export { DENIED_PATHS } from '@dwara/core';

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
  const problem = lexicalPathProblem(requested);
  if (problem !== undefined) return { ok: false, reason: problem };

  const path = normalisePath(requested);

  if (matchesGlob(DENIED_PATHS, path)) {
    return {
      ok: false,
      reason: `"${path}" is on Dwara's permanent deny-list; no policy can allow it`,
    };
  }

  if (!matchesGlob([...allowed, ...extraAllowed], path)) {
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
  return matchesGlob(DENIED_PATHS, normalisePath(resolved.trim()));
}
