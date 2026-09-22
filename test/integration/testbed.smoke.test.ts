import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

/**
 * Smoke tests for the testbed itself. They assert the lab is in the shape the
 * rest of the test suite assumes: five hosts reachable with key-only SSH, a
 * scoped sudo allowlist, and a healthy application stack.
 *
 * Gated behind DWARA_TESTBED=1 so `pnpm test` stays hermetic. Run with:
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const LAB_HOSTS = ['lab-api', 'lab-db', 'lab-cache', 'lab-queue', 'lab-staging'] as const;
const SSH_CONFIG = 'testbed/ssh_config';

const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

async function ssh(host: string, command: string): Promise<string> {
  const { stdout } = await exec('ssh', ['-F', SSH_CONFIG, host, command]);
  return stdout.trim();
}

async function httpStatus(url: string): Promise<number> {
  const { stdout } = await exec('curl', [
    '-sk',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '10',
    url,
  ]);
  return Number(stdout.trim());
}

describeTestbed('testbed', () => {
  it.each(LAB_HOSTS)('%s is reachable as the dwara user', async (host) => {
    expect(await ssh(host, 'whoami')).toBe('dwara');
  });

  it.each(LAB_HOSTS)('%s has a working systemd', async (host) => {
    // `degraded` is acceptable: a single failed unit should not mask an
    // otherwise usable host, and diagnosing that is the point of the lab.
    expect(['running', 'degraded']).toContain(
      await ssh(host, 'systemctl is-system-running || true'),
    );
  });

  it('refuses password authentication', async () => {
    await expect(
      exec('ssh', [
        '-F',
        SSH_CONFIG,
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'PreferredAuthentications=password,keyboard-interactive',
        'lab-api',
        'true',
      ]),
    ).rejects.toThrow();
  });

  it('grants sudo only for allowlisted commands', async () => {
    expect(await ssh('lab-api', 'sudo -n systemctl is-active ssh')).toBe('active');
    await expect(ssh('lab-api', 'sudo -n rm -rf /tmp/dwara-should-not-run')).rejects.toThrow();
  });

  it('serves a healthy stack through the reverse proxy', async () => {
    expect(await httpStatus('https://127.0.0.1:8443/health')).toBe(200);

    const { stdout } = await exec('curl', [
      '-sk',
      '--max-time',
      '10',
      'https://127.0.0.1:8443/health',
    ]);
    const body = JSON.parse(stdout) as {
      status: string;
      checks: Record<string, { ok: boolean; detail: string }>;
    };

    expect(body.status).toBe('ok');
    expect(Object.keys(body.checks).sort()).toEqual(['kafka', 'postgres', 'redis']);
    for (const [name, check] of Object.entries(body.checks)) {
      expect(check.ok, `${name}: ${check.detail}`).toBe(true);
    }
  });

  it('runs the app and kafka as containers on their own hosts', async () => {
    expect(await ssh('lab-api', 'docker ps --format "{{.Names}}"')).toContain('lab-app');
    expect(await ssh('lab-queue', 'docker ps --format "{{.Names}}"')).toContain('lab-kafka');
  });
});
