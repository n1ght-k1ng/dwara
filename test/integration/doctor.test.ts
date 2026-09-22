import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { formatReport, runDoctor } from '@dwara/cli';

/**
 * `dwara doctor` against the lab, healthy and deliberately broken.
 *
 * A doctor that only ever reports "fine" is worthless, so the second half of
 * this suite breaks a host on purpose and checks that it says so, with a fix
 * an operator could paste.
 */
const exec = promisify(execFile);
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const OPTIONS = {
  sshConfigPath: 'testbed/ssh_config',
  policyPath: 'testbed/policy.yaml',
  timeoutMs: 15_000,
} as const;

/** Acts as root on a lab host, the way the break scenarios do. */
async function labRoot(host: string, ...argv: string[]): Promise<void> {
  await exec('docker', ['exec', host, ...argv]);
}

describeTestbed('dwara doctor', () => {
  afterAll(async () => {
    // Put lab-staging back however the tests left it.
    await labRoot(
      'lab-staging',
      'sh',
      '-c',
      'mv -f /root/dwara-common.bak /etc/sudoers.d/dwara-common',
    ).catch(() => undefined);
  });

  it('reports every lab host as usable', async () => {
    const report = await runDoctor(OPTIONS);

    expect(report.hosts.map((host) => host.host)).toEqual([
      'lab-api',
      'lab-db',
      'lab-cache',
      'lab-queue',
      'lab-staging',
    ]);
    for (const host of report.hosts) {
      expect(host.status, `${host.host}: ${JSON.stringify(host.checks)}`).toBe('ok');
    }
    expect(report.ok).toBe(true);
  }, 120_000);

  it('checks only the hosts asked for', async () => {
    const report = await runDoctor({ ...OPTIONS, hosts: ['lab-cache'] });
    expect(report.hosts).toHaveLength(1);
    expect(report.hosts[0]?.host).toBe('lab-cache');
  });

  it('warns about a host the policy does not cover, without connecting to it', async () => {
    // Connecting to a host Dwara is not allowed to manage would be the wrong
    // thing to do, so it is reported rather than probed.
    const report = await runDoctor({ ...OPTIONS, hosts: ['not-in-the-policy'] });

    expect(report.hosts[0]).toMatchObject({ managed: false, status: 'warn' });
    expect(report.hosts[0]?.checks[0]?.name).toBe('policy');
    expect(report.ok).toBe(true);
  });

  it('fails a host it cannot reach, and says why', async () => {
    const report = await runDoctor({
      sshConfigPath: 'testbed/ssh_config',
      hosts: ['lab-unreachable'],
      timeoutMs: 10_000,
    });

    expect(report.ok).toBe(false);
    const connect = report.hosts[0]?.checks[0];
    expect(connect).toMatchObject({ name: 'connect', status: 'fail' });
    expect(connect?.fix).toContain('BatchMode');
  }, 60_000);

  it('flags a host whose sudo allowlist is missing, with the sudoers line to add', async () => {
    await labRoot(
      'lab-staging',
      'sh',
      '-c',
      'mv /etc/sudoers.d/dwara-common /root/dwara-common.bak',
    );

    const report = await runDoctor({ ...OPTIONS, hosts: ['lab-staging'] });

    expect(report.ok).toBe(false);
    const systemctl = report.hosts[0]?.checks.find((check) => check.name === 'systemctl');
    expect(systemctl?.status).toBe('fail');
    expect(systemctl?.detail).toContain('password');
    expect(systemctl?.fix).toContain('NOPASSWD');
    expect(systemctl?.fix).toContain('is-system-running');

    // The rendered report has to carry the fix too, since that is all most
    // people will ever see.
    const text = formatReport(report, false);
    expect(text).toContain('How to fix');
    expect(text).toContain('NOPASSWD');
    expect(text).toContain('Some hosts are not usable yet.');

    await labRoot(
      'lab-staging',
      'sh',
      '-c',
      'mv /root/dwara-common.bak /etc/sudoers.d/dwara-common',
    );

    const recovered = await runDoctor({ ...OPTIONS, hosts: ['lab-staging'] });
    expect(recovered.ok).toBe(true);
  }, 120_000);
});
