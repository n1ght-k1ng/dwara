import { describe, expect, it } from 'vitest';
import { sudoersLine } from './doctor.js';

/**
 * The sudoers line `doctor` prints is pasted verbatim into a file on a machine
 * somebody else owns, usually through a ticket. A wrong path does not fail
 * loudly — `visudo -c` accepts a rule for a command that does not exist there,
 * the rule simply never matches, and the cost is a second request to whoever
 * administers the host.
 *
 * So what is pinned here is that the printed path is the one the host itself
 * reported, and that an unresolved path is admitted rather than guessed.
 */
describe('the sudoers line doctor hands to an operator', () => {
  it('uses the path the host resolved, not a guessed prefix', () => {
    // `ss` lives under /usr/sbin on Amazon Linux and /usr/bin on Debian. The
    // hard-coded /usr/bin was wrong on exactly the distribution most likely to
    // be running in the environments Dwara is aimed at.
    const line = sudoersLine(['ss', '-tulpn'], '/usr/sbin/ss');

    expect(line).toContain('NOPASSWD: /usr/sbin/ss -tulpn');
    expect(line).not.toContain('/usr/bin/ss');
  });

  it('keeps the verbs, so the grant is narrower than the bare command', () => {
    const line = sudoersLine(['systemctl', 'status', '*'], '/usr/bin/systemctl');

    expect(line).toContain('NOPASSWD: /usr/bin/systemctl status *');
    expect(line).toContain('Grant the verbs your policy actually permits');
  });

  it('admits an unresolved path instead of inventing one', () => {
    const line = sudoersLine(['journalctl', '-n', '50'], '');

    expect(line).toContain('$(command -v journalctl)');
    expect(line).toContain('could not be resolved');
    expect(line).not.toMatch(/NOPASSWD: \/usr\//u);
  });

  it('says how to validate the file, because a bad one locks sudo for everyone', () => {
    const line = sudoersLine(['du', '-sh', '/var/log'], '/usr/bin/du');

    expect(line).toContain('visudo -c');
    expect(line).toContain('chmod 440');
  });

  it('states that Dwara never prompts, which is why an unlisted command fails fast', () => {
    expect(sudoersLine(['df', '-h'], '/usr/bin/df')).toContain('sudo -n');
  });
});
