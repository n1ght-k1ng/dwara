import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField, keyValues, lines, unavailable } from './common.js';

const input = z.object({ host: hostField }).strict();
type Input = z.output<typeof input>;

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  readonly check: string;
  readonly severity: Severity;
  readonly detail: string;
}

export interface SecurityAudit {
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<Severity, number>>;
  /** Checks that could not run, so a clean report is not mistaken for a clean host. */
  readonly skipped: readonly { readonly check: string; readonly reason: string }[];
  readonly assessment: string;
}

/**
 * A small, honest posture check: sshd hardening, sockets reachable off-host,
 * world-writable files under /etc, and pending package updates.
 *
 * Bounded on purpose. It does not claim to be a security scan, and it reports
 * what it could not check as loudly as what it found — a report that silently
 * skips a check reads as a pass.
 */
export const securityAudit: ToolDef<Input, SecurityAudit> = {
  name: 'security_audit',
  risk: Risk.Read,
  description: [
    'Basic security posture of a host: sshd settings that matter (root login, password',
    'authentication, empty passwords, forwarding), listening sockets reachable from off',
    'the host, world-writable files under /etc, and how many package updates are pending.',
    '',
    'Findings carry a severity. Read `skipped` as carefully as `findings` — a check that',
    'could not run is not a check that passed, and this tool says which is which.',
    '',
    'This is a handful of specific checks, not a vulnerability scan, and a clean result',
    'means only that these particular things look right. It reads nothing: no file',
    'contents, no credentials, no /etc/shadow.',
  ].join('\n'),
  input,

  build: () => [
    { argv: ['sshd', '-T'], sudo: true, timeoutMs: READ_TIMEOUT_MS },
    { argv: ['ss', '-H', '-tlnp'], sudo: true, timeoutMs: READ_TIMEOUT_MS },
    {
      // -xdev keeps this on one filesystem, so a mounted volume cannot turn a
      // quick check into a scan of the whole machine.
      argv: ['find', '/etc', '-xdev', '-type', 'f', '-perm', '-0002'],
      timeoutMs: READ_TIMEOUT_MS,
    },
    { argv: ['apt', 'list', '--upgradable'], timeoutMs: READ_TIMEOUT_MS },
  ],

  parse: (raws) => {
    const findings: Finding[] = [];
    const skipped: { check: string; reason: string }[] = [];

    const sshd = at(raws, 0);
    const sshdMissing = unavailable(sshd);
    if (sshdMissing) {
      skipped.push({ check: 'sshd', reason: sshdMissing.reason });
    } else {
      findings.push(...auditSshd(keyValues(sshd.stdout.replace(/^(\S+) /gm, '$1='))));
    }

    const ports = at(raws, 1);
    const portsMissing = unavailable(ports);
    if (portsMissing) {
      skipped.push({ check: 'listening-sockets', reason: portsMissing.reason });
    } else {
      findings.push(...auditPorts(ports.stdout));
    }

    const writable = at(raws, 2);
    if (writable.exitCode !== 0 && writable.stdout === '') {
      skipped.push({ check: 'world-writable', reason: `find exited ${writable.exitCode}` });
    } else {
      const paths = lines(writable.stdout);
      if (paths.length > 0) {
        findings.push({
          check: 'world-writable',
          severity: 'high',
          detail: `${paths.length} world-writable file(s) under /etc: ${paths.slice(0, 5).join(', ')}`,
        });
      }
    }

    const updates = at(raws, 3);
    // apt prints "Listing..." and nothing else when everything is current.
    const upgradable = lines(updates.stdout).filter(
      (line) => line.includes('/') && !line.startsWith('Listing'),
    );
    if (updates.exitCode !== 0) {
      skipped.push({ check: 'pending-updates', reason: `apt exited ${updates.exitCode}` });
    } else if (upgradable.length > 0) {
      findings.push({
        check: 'pending-updates',
        severity: upgradable.length > 20 ? 'medium' : 'low',
        detail: `${upgradable.length} package update(s) pending`,
      });
    }

    const counts = countBy(findings);
    return { findings, counts, skipped, assessment: assess(counts, skipped.length) };
  },
};

function auditSshd(config: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  const get = (key: string): string => (config[key] ?? '').trim().toLowerCase();

  if (get('permitrootlogin') === 'yes') {
    findings.push({
      check: 'sshd.PermitRootLogin',
      severity: 'high',
      detail: 'root may log in over SSH directly',
    });
  }
  if (get('passwordauthentication') === 'yes') {
    findings.push({
      check: 'sshd.PasswordAuthentication',
      severity: 'medium',
      detail: 'password authentication is enabled, so the host is brute-forceable',
    });
  }
  if (get('permitemptypasswords') === 'yes') {
    findings.push({
      check: 'sshd.PermitEmptyPasswords',
      severity: 'high',
      detail: 'accounts with no password may log in',
    });
  }
  if (get('x11forwarding') === 'yes') {
    findings.push({
      check: 'sshd.X11Forwarding',
      severity: 'low',
      detail: 'X11 forwarding is enabled',
    });
  }
  if (get('permittunnel') === 'yes') {
    findings.push({ check: 'sshd.PermitTunnel', severity: 'low', detail: 'tunnelling is enabled' });
  }

  return findings;
}

function auditPorts(text: string): Finding[] {
  const exposed = lines(text)
    .map((line) => line.trim().split(/\s+/)[3] ?? '')
    .filter((local) => local !== '' && !/^(?:127\.|\[::1\])/.test(local));

  if (exposed.length === 0) return [];

  return [
    {
      check: 'exposed-sockets',
      // Whether this matters depends on the network in front of the host, which
      // Dwara cannot see. Reported as information, not as a fault.
      severity: 'info',
      detail: `${exposed.length} socket(s) listening beyond loopback: ${[...new Set(exposed)].slice(0, 8).join(', ')}`,
    },
  ];
}

function countBy(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function assess(counts: Record<Severity, number>, skipped: number): string {
  const note =
    skipped > 0 ? `; ${skipped} check(s) could not run, so this is not a full picture` : '';

  if (counts.high > 0) return `${counts.high} high-severity finding(s)${note}`;
  if (counts.medium > 0) return `${counts.medium} medium-severity finding(s)${note}`;
  if (counts.low > 0) return `only low-severity findings${note}`;
  return `nothing of concern in these checks${note}`;
}
