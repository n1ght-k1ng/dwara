import { describe, expect, it } from 'vitest';
import { SshTransport } from './transport.js';

/**
 * Unit coverage for the argument vector. Everything that needs a real host —
 * exit codes, timeouts, truncation, sudo denial — is in
 * test/integration/ssh-transport.test.ts, against the testbed.
 */
describe('SshTransport.buildArgs', () => {
  const transport = new SshTransport({ controlDir: '/tmp/dwara-test' });

  it('always runs with BatchMode=yes', () => {
    // Without it, ssh can sit waiting for a passphrase and an agent would hang
    // rather than report a broken host.
    expect(transport.buildArgs('lab-api', { argv: ['uptime'], timeoutMs: 1000 })).toContain(
      'BatchMode=yes',
    );
  });

  it('reuses one connection per host', () => {
    const args = transport.buildArgs('lab-api', { argv: ['uptime'], timeoutMs: 1000 });
    expect(args).toContain('ControlMaster=auto');
    expect(args).toContain('ControlPersist=60s');
    expect(args.join(' ')).toContain('ControlPath=/tmp/dwara-test/cm-%C');
  });

  it('passes -F only when a config path was given', () => {
    expect(transport.buildArgs('lab-api', { argv: ['uptime'], timeoutMs: 1000 })).not.toContain(
      '-F',
    );

    const scoped = new SshTransport({ sshConfigPath: 'testbed/ssh_config' });
    const args = scoped.buildArgs('lab-api', { argv: ['uptime'], timeoutMs: 1000 });
    expect(args.slice(0, 2)).toEqual(['-F', 'testbed/ssh_config']);
  });

  it('separates options from the host with --', () => {
    const args = transport.buildArgs('lab-api', { argv: ['uptime'], timeoutMs: 1000 });
    // A host alias beginning with a dash must not be read as an ssh option.
    expect(args[args.indexOf('lab-api') - 1]).toBe('--');
  });

  it('prefixes sudo -n and nothing else', () => {
    const args = transport.buildArgs('lab-api', {
      argv: ['systemctl', 'restart', 'nginx'],
      sudo: true,
      timeoutMs: 1000,
    });

    expect(args.at(-1)).toBe('sudo -n systemctl restart nginx');
  });

  it('quotes each argument so one cannot start another command', () => {
    const args = transport.buildArgs('lab-api', {
      argv: ['journalctl', '-u', 'nginx; rm -rf /'],
      timeoutMs: 1000,
    });

    expect(args.at(-1)).toBe("journalctl -u 'nginx; rm -rf /'");
  });

  it('refuses an argument with a control character', () => {
    expect(() =>
      transport.buildArgs('lab-api', { argv: ['echo', 'a\nb'], timeoutMs: 1000 }),
    ).toThrowError(/control character/);
  });

  it('refuses an empty command', () => {
    expect(() => transport.buildArgs('lab-api', { argv: [], timeoutMs: 1000 })).toThrowError(
      /at least one argument/,
    );
  });
});

describe('per-command output cap', () => {
  it('builds the same argv whatever the cap', () => {
    // The cap is a client-side read limit, not something sent to the host.
    const transport = new SshTransport({ sshConfigPath: 'testbed/ssh_config' });
    const plain = transport.buildArgs('lab-api', { argv: ['echo', 'x'], timeoutMs: 1000 });
    const capped = transport.buildArgs('lab-api', {
      argv: ['echo', 'x'],
      timeoutMs: 1000,
      maxOutputBytes: 128,
    });

    expect(capped).toEqual(plain);
  });
});
