import { access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Working out which hosts Dwara is actually managing.
 *
 * The answer drives the hook's whole behaviour, and the important case is the
 * empty one: **no policy means no managed hosts, which means the hook stays
 * out of the way entirely.** A plugin installed globally must not interfere
 * with the many projects that do not use Dwara, or it gets uninstalled rather
 * than configured. The hook is defence in depth (DESIGN §4); the guarantee
 * that does not depend on it is the dedicated-key setup, where the agent's
 * shell has no credentials for managed hosts at all.
 *
 * Policy patterns are globs — `prod-*` — and a shell command names a concrete
 * host, so the patterns are expanded against the SSH config to get real names.
 */

export interface Managed {
  readonly hosts: readonly string[];
  /** Where the policy came from, for the `--explain` output. */
  readonly policyPath?: string;
}

const NONE: Managed = { hosts: [] };

/**
 * The managed hosts for a working directory.
 *
 * Never throws. A hook that crashed would be a hook that stopped protecting
 * anything, and the failure would look exactly like success.
 */
export async function managedHosts(options: {
  cwd?: string;
  policyPath?: string;
  sshConfigPath?: string;
}): Promise<Managed> {
  const cwd = options.cwd ?? process.cwd();
  const policyPath =
    options.policyPath ?? process.env['DWARA_POLICY'] ?? join(cwd, '.dwara', 'policy.yaml');

  // Checked before anything heavy is loaded. This hook runs before **every**
  // Bash call, and most projects do not use Dwara at all; making those
  // sessions pay to parse a policy loader they will never call is the
  // difference between a plugin people keep installed and one they do not.
  try {
    await access(policyPath);
  } catch {
    return NONE;
  }

  // Imported here rather than at the top so the check above can short-circuit
  // it. The policy loader pulls in YAML and schema validation; none of that is
  // worth loading to discover there is no policy.
  const { loadPolicy, matchesHost, parseSshConfig } = await import('@dwara/core');

  let patterns: readonly string[];
  try {
    const loaded = await loadPolicy(policyPath);
    patterns = loaded.policy.hosts.map((rule) => rule.match);
  } catch {
    // No policy, or one that does not load. Either way Dwara governs nothing
    // here and there is nothing for the hook to protect.
    return NONE;
  }

  if (patterns.length === 0) return NONE;

  const literals = patterns.filter((pattern) => !/[*?]/.test(pattern));
  const wildcards = patterns.filter((pattern) => /[*?]/.test(pattern));

  // Only the wildcards need the SSH config, so a missing or unreadable config
  // still leaves the literal host names working.
  let expanded: string[] = [];
  if (wildcards.length > 0) {
    try {
      const sshConfigPath =
        options.sshConfigPath ?? process.env['DWARA_SSH_CONFIG'] ?? '~/.ssh/config';
      const config = await parseSshConfig(sshConfigPath);
      expanded = config.hosts.filter((host) =>
        wildcards.some((pattern) => matchesHost(pattern, host)),
      );
    } catch {
      expanded = [];
    }
  }

  const hosts = [...new Set([...literals, ...expanded])].sort();
  return hosts.length === 0 ? NONE : { hosts, policyPath };
}
