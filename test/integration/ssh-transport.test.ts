import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DwaraError, SshTransport } from '@dwara/core';

/**
 * The transport against real hosts.
 *
 * Gated behind DWARA_TESTBED=1 and pointed at `testbed/ssh_config`, never at
 * anything outside the lab. Run with:
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 15_000,
});

describeTestbed('SshTransport against the lab', () => {
  it('runs a command and returns its output', async () => {
    const result = await transport.run('lab-api', { argv: ['hostname'], timeoutMs: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('lab-api');
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('reports a non-zero exit as a result, not an error', async () => {
    // A command that fails is information the tool needs, not a transport
    // failure. Throwing here would hide the exit code from the caller.
    const result = await transport.run('lab-api', {
      argv: ['sh', '-c', 'echo to-stderr >&2; exit 3'],
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('to-stderr');
  });

  it('feeds stdin to the remote command', async () => {
    const result = await transport.run('lab-api', {
      argv: ['cat'],
      stdin: 'lines\nwith\nnewlines\n',
      timeoutMs: 10_000,
    });

    // Content that argv refuses still has a way through.
    expect(result.stdout).toBe('lines\nwith\nnewlines\n');
  });

  it('caps output and flags it as truncated', async () => {
    const small = new SshTransport({ sshConfigPath: 'testbed/ssh_config', maxOutputBytes: 4096 });
    const result = await small.run('lab-api', {
      argv: ['sh', '-c', 'head -c 200000 /dev/zero | tr "\\0" "x"'],
      timeoutMs: 20_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(4096);
    // The exit code still survives: the stream is drained, not the child killed.
    expect(result.exitCode).toBe(0);
  });

  it('times out a command that hangs, at the deadline and not after it', async () => {
    const started = Date.now();
    await expect(
      transport.run('lab-api', { argv: ['sleep', '30'], timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    // Regression: the transport used to return TIMEOUT only once the remote
    // command finished, so a 2s deadline took the full 30s. A deadline that
    // waits for the thing it is bounding is not a deadline.
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('reports an unreachable host as a connect failure', async () => {
    await expect(
      transport.run('lab-nonexistent', { argv: ['true'], timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' });
  });

  it('runs an allowlisted command under sudo -n', async () => {
    const result = await transport.run('lab-api', {
      argv: ['systemctl', 'is-active', 'ssh'],
      sudo: true,
      timeoutMs: 10_000,
    });

    expect(result.stdout.trim()).toBe('active');
  });

  it('reports a sudo password prompt with the sudoers line to add', async () => {
    // `rm` is deliberately outside the lab's sudo allowlist.
    try {
      await transport.run('lab-api', {
        argv: ['rm', '-f', '/tmp/dwara-should-not-happen'],
        sudo: true,
        timeoutMs: 10_000,
      });
      throw new Error('expected sudo to be refused');
    } catch (err) {
      expect(DwaraError.is(err)).toBe(true);
      const error = err as DwaraError;
      expect(error.code).toBe('SUDO_PASSWORD_REQUIRED');
      expect(error.hint).toContain('NOPASSWD');
      // Dwara must never offer to collect a password instead.
      expect(error.hint).toContain('will not prompt');
    }
  });

  it('never leaves arguments unescaped on the far end', async () => {
    // The batched local shell test in packages/core covers scale; this sample
    // goes through the whole path — ssh's own argument joining and the remote
    // login shell — where a quoting mistake would actually bite.
    const samples = fc.sample(
      fc.oneof(
        fc.stringMatching(/^[\x20-\x7e]{0,20}$/),
        fc.constantFrom(
          '$(touch /tmp/dwara-pwned)',
          '`id`',
          "a'b",
          'a"b',
          'a!b',
          'ERROR!',
          '; id',
          '&& id',
          '| id',
          '../../etc/passwd',
          '*',
          '~root',
          '$HOME',
        ),
      ),
      100,
    );

    for (const sample of samples) {
      const result = await transport.run('lab-api', {
        argv: ['printf', '%s', sample],
        timeoutMs: 10_000,
      });
      expect(result.stdout, `argument ${JSON.stringify(sample)} did not survive`).toBe(sample);
    }

    const canary = await transport.run('lab-api', {
      argv: ['test', '!', '-e', '/tmp/dwara-pwned'],
      timeoutMs: 10_000,
    });
    expect(canary.exitCode, 'a generated argument executed as a command').toBe(0);
  }, 180_000);
});
