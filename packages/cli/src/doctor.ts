import {
  DwaraError,
  SshTransport,
  loadPolicy,
  parseSshConfig,
  resolveHost,
  selectHostRules,
  type Policy,
  type SshConfig,
} from '@dwara/core';
import { preflightSsm, ssmTarget, usesSsm } from './ssm.js';

/**
 * What Dwara's read-only tools need on a host.
 *
 * Each entry probes with an argv the tools genuinely use, not with
 * `<command> --version`. A well-configured sudoers grants specific verbs —
 * `systemctl status *`, `systemctl restart *` — and refuses everything else, so
 * a `--version` probe would fail on exactly the hosts that are set up correctly
 * and pass on the ones that hand out blanket root.
 */
const REQUIRED_COMMANDS: readonly {
  readonly command: string;
  readonly probe: readonly string[];
  readonly sudo: boolean;
}[] = [
  { command: 'systemctl', probe: ['systemctl', 'is-system-running'], sudo: true },
  { command: 'journalctl', probe: ['journalctl', '-n', '1', '--no-pager'], sudo: true },
  { command: 'ss', probe: ['ss', '-H', '-tuln'], sudo: false },
  { command: 'df', probe: ['df', '-P', '/'], sudo: false },
  { command: 'du', probe: ['du', '-s', '/tmp'], sudo: false },
];

export interface DoctorOptions {
  readonly sshConfigPath?: string;
  readonly policyPath?: string;
  /** Limits the check to these aliases. */
  readonly hosts?: readonly string[];
  readonly timeoutMs?: number;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface HostReport {
  readonly host: string;
  readonly managed: boolean;
  readonly checks: readonly Check[];
  readonly status: CheckStatus;
}

export interface DoctorReport {
  readonly sshConfigPath: string;
  readonly policyPath: string | undefined;
  readonly hosts: readonly HostReport[];
  readonly ok: boolean;
}

/**
 * Checks that every managed host is actually usable, before an agent finds out
 * the hard way.
 *
 * Read-only throughout: it connects, asks what is present, and reports. A host
 * that fails here is reported with the exact fix, because the alternative is an
 * agent hitting the same wall mid-incident with less context than the operator.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const sshConfigPath = options.sshConfigPath ?? '~/.ssh/config';
  const config = await parseSshConfig(sshConfigPath);

  let policy: Policy | undefined;
  let policyPath: string | undefined;
  if (options.policyPath !== undefined) {
    const loaded = await loadPolicy(options.policyPath);
    policy = loaded.policy;
    policyPath = loaded.path;
  }

  const candidates = options.hosts && options.hosts.length > 0 ? options.hosts : [...config.hosts];

  const transport = new SshTransport({
    sshConfigPath,
    defaultTimeoutMs: options.timeoutMs ?? 15_000,
  });

  const hosts: HostReport[] = [];
  for (const host of candidates) {
    const managed = policy === undefined || selectHostRules(policy.hosts, host).length > 0;
    // A host the policy does not cover is listed but not probed: connecting to
    // something Dwara is not allowed to manage would be the wrong thing to do.
    const checks = managed
      ? await checkManagedHost(config, transport, host, options.timeoutMs ?? 15_000)
      : [
          {
            name: 'policy',
            status: 'warn' as const,
            detail: 'not covered by any rule in the policy, so Dwara will refuse to use it',
            fix: `add a rule matching "${host}" to ${policyPath ?? 'your policy'}, or leave it unmanaged`,
          },
        ];

    hosts.push({ host, managed, checks, status: worst(checks) });
  }

  return {
    sshConfigPath,
    policyPath,
    hosts,
    ok: hosts.every((report) => report.status !== 'fail'),
  };
}

/**
 * Probes a managed host, preflighting the proxy first where there is one.
 *
 * Order matters. A host reached through SSM fails with the same SSH timeout
 * whatever is actually wrong -- a missing plugin, stale credentials, an offline
 * agent -- so the local checks run *before* the connection is attempted. That
 * turns a fifteen-second wait and "connection closed" into a named cause, and it
 * costs nothing on the hosts that are fine.
 */
async function checkManagedHost(
  config: SshConfig,
  transport: SshTransport,
  host: string,
  timeoutMs: number,
): Promise<Check[]> {
  const resolved = resolveHost(config, host);
  if (!usesSsm(resolved)) return checkHost(transport, host, timeoutMs);

  const preflight = await preflightSsm(ssmTarget(resolved), timeoutMs);

  // A broken proxy means the connection cannot work, so there is nothing to
  // learn from trying. Saying so beats a second failure that repeats the first.
  if (preflight.some((check) => check.status === 'fail')) {
    return [
      ...preflight,
      {
        name: 'connect',
        status: 'fail',
        detail: 'not attempted: the SSM proxy cannot work until the above is fixed',
      },
    ];
  }

  return [...preflight, ...(await checkHost(transport, host, timeoutMs))];
}

async function checkHost(
  transport: SshTransport,
  host: string,
  timeoutMs: number,
): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    const who = await transport.run(host, { argv: ['id', '-un'], timeoutMs });
    checks.push({
      name: 'connect',
      status: 'ok',
      detail: `reachable as ${who.stdout.trim()}`,
    });
  } catch (err) {
    const error = DwaraError.from(err);
    return [
      {
        name: 'connect',
        status: 'fail',
        detail: error.message,
        ...(error.hint === undefined ? {} : { fix: error.hint }),
      },
    ];
  }

  for (const required of REQUIRED_COMMANDS) {
    checks.push(await checkCommand(transport, host, required, timeoutMs));
  }

  return checks;
}

async function checkCommand(
  transport: SshTransport,
  host: string,
  required: (typeof REQUIRED_COMMANDS)[number],
  timeoutMs: number,
): Promise<Check> {
  const { command, probe, sudo } = required;

  // Resolved before the sudo probe and kept in scope for the failure path: the
  // sudoers line this prints is pasted verbatim into a file on that host, and a
  // guessed prefix makes it wrong. `ss` is under /usr/sbin on Amazon Linux, so
  // the hard-coded /usr/bin sent an operator away with a rule that could not
  // match, and the round trip cost a second request to whoever owns the box.
  let path = '';

  try {
    const present = await transport.run(host, { argv: ['command', '-v', command], timeoutMs });
    if (present.exitCode !== 0) {
      return {
        name: command,
        status: 'fail',
        detail: 'not installed',
        fix: `install ${command} on ${host}`,
      };
    }

    path = present.stdout.trim();
    if (!sudo) return { name: command, status: 'ok', detail: `present (${path})` };

    // Presence is not enough: the tools run these under `sudo -n`, and a host
    // where that prompts is a host where every mutating tool fails later. What
    // matters is that the command *ran* — `systemctl is-system-running` exits
    // non-zero on a merely degraded host, which is not a setup problem.
    await transport.run(host, { argv: [...probe], sudo: true, timeoutMs });
    return { name: command, status: 'ok', detail: `present, sudo -n works (${path})` };
  } catch (err) {
    const error = DwaraError.from(err);
    if (error.code === 'SUDO_PASSWORD_REQUIRED') {
      return {
        name: command,
        status: 'fail',
        detail: `sudo -n asks for a password for \`${probe.join(' ')}\``,
        fix: sudoersLine(probe, path),
      };
    }
    return {
      name: command,
      status: 'fail',
      detail: error.message,
      ...(error.hint === undefined ? {} : { fix: error.hint }),
    };
  }
}

/**
 * The exact line to add, with the path as the host itself resolved it.
 *
 * @param resolved absolute path from `command -v`, empty when it could not be
 *   read — in which case this says so rather than inventing a prefix, because a
 *   plausible-looking wrong path is worse than an admitted gap.
 */
export function sudoersLine(probe: readonly string[], resolved: string): string {
  const command = probe[0] ?? 'command';
  const target = resolved === '' ? `$(command -v ${command})` : resolved;

  return [
    'Dwara only ever runs `sudo -n` and will not prompt for or store a password.',
    'Add to /etc/sudoers.d/dwara (chmod 440, validate with visudo -c):',
    `  <user> ALL=(root) NOPASSWD: ${target} ${probe.slice(1).join(' ')}`,
    resolved === ''
      ? 'The path could not be resolved on the host — run that substitution there to fill it in.'
      : `Path as ${command} resolves on this host; it differs by distribution.`,
    'Grant the verbs your policy actually permits rather than the bare command.',
  ].join('\n');
}

function worst(checks: readonly Check[]): CheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

/** Renders a report for a terminal. */
export function formatReport(report: DoctorReport, useColour: boolean): string {
  const paint = (code: string, text: string): string =>
    useColour ? `\u001b[${code}m${text}\u001b[0m` : text;

  const mark = (status: CheckStatus): string =>
    status === 'ok'
      ? paint('32', 'ok')
      : status === 'warn'
        ? paint('33', 'warn')
        : paint('31', 'FAIL');

  const lines: string[] = [];
  lines.push(`ssh config: ${report.sshConfigPath}`);
  lines.push(`policy:     ${report.policyPath ?? '(none; checking every host in the SSH config)'}`);
  lines.push('');

  if (report.hosts.length === 0) {
    lines.push('No hosts found to check.');
    return lines.join('\n');
  }

  const fixes: string[] = [];

  for (const host of report.hosts) {
    lines.push(`${mark(host.status)}  ${host.host}`);
    for (const check of host.checks) {
      lines.push(`      ${mark(check.status)}  ${check.name}: ${check.detail}`);
      if (check.fix !== undefined && check.status !== 'ok') {
        fixes.push(`${host.host} · ${check.name}\n${indent(check.fix)}`);
      }
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push('How to fix:');
    lines.push('');
    lines.push(fixes.join('\n\n'));
    lines.push('');
  }

  lines.push(report.ok ? 'All checked hosts are usable.' : 'Some hosts are not usable yet.');
  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
