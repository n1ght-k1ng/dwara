import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The separation `docs/DEDICATED_KEY.md` tells operators to set up, tested
 * against the lab — which is itself an instance of that setup.
 *
 * `docs/THREAT_MODEL.md` names this as **the** control, on the grounds that every
 * other guarantee is enforced inside Dwara's own process and therefore does not
 * apply to anything that reaches a host another way. A documented control nobody
 * verified is exactly the kind of claim this project is supposed to avoid, so the
 * interesting assertion here is the negative one: **a plain `ssh` must fail.**
 */
const exec = promisify(execFile);
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

/** Runs a command, reporting failure rather than throwing. */
async function attempt(
  argv: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  try {
    const { stdout, stderr } = await exec(command!, args, { timeout: 20_000 });
    return { ok: true, stdout, stderr };
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describeTestbed('the dedicated key actually separates', () => {
  it('reaches a lab host through Dwara’s own ssh config', async () => {
    const result = await attempt([
      'ssh',
      '-F',
      'testbed/ssh_config',
      '-o',
      'BatchMode=yes',
      'lab-api',
      'id -un',
    ]);

    expect(result.ok, result.stderr).toBe(true);
    expect(result.stdout.trim()).toBe('dwara');
  });

  it('does NOT reach the same host without that config', async () => {
    // The assertion that makes the setup worth anything. If this ever passes,
    // the operator's ordinary credentials reach managed hosts, every guard in
    // Dwara is bypassable with one Bash call, and the hook is all that is left.
    const result = await attempt([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      'lab-api',
      'id -un',
    ]);

    expect(
      result.ok,
      'a plain ssh reached lab-api: the dedicated-key separation is not holding',
    ).toBe(false);
  });

  it('offers only its own identity, so a stray agent key cannot be used', async () => {
    // Without IdentitiesOnly, ssh offers every key it can find — including the
    // operator's — and the restriction would appear to work while not working.
    const config = await readFile('testbed/ssh_config', 'utf8');

    expect(config).toMatch(/^\s*IdentitiesOnly\s+yes\s*$/mu);
    expect(config).toMatch(/^\s*BatchMode\s+yes\s*$/mu);
    expect(config).toMatch(/^\s*PasswordAuthentication\s+no\s*$/mu);
    // Host key checking stays on. `accept-new` is the lab's compromise because
    // images are rebuilt; what matters is that it is never `no`.
    expect(config).not.toMatch(/StrictHostKeyChecking\s+no/u);
  });

  it('keeps the private key unreadable by anyone else', async () => {
    const info = await stat('testbed/.keys/dwara_lab');
    const mode = info.mode & 0o777;

    expect(mode & 0o077, `key mode is ${mode.toString(8)}`).toBe(0);
  });

  it('refuses a password prompt rather than waiting for one', async () => {
    // `sudo -n` is the only form Dwara uses. A command outside the allow-list
    // has to fail immediately, not block: a tool that hung waiting for a
    // password would look like a timeout and be debugged as one.
    const result = await attempt([
      'ssh',
      '-F',
      'testbed/ssh_config',
      '-o',
      'BatchMode=yes',
      'lab-api',
      'sudo -n cat /etc/shadow',
    ]);

    expect(result.ok).toBe(false);
    expect(`${result.stderr}${result.stdout}`).toMatch(/password is required|not allowed/iu);
  });
});
