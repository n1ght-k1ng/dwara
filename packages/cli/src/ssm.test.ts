import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSshConfig, parsePolicy, resolveHost, selectHostRules } from '@dwara/core';
import { BLOCK_END, BLOCK_START, spliceSsmBlock, ssmSshConfig, ssmTarget, usesSsm } from './ssm.js';

/**
 * Parses generated text through the real file-based parser.
 *
 * Core exposes no string parser, and writing a temp file is the better test for
 * it: the thing that matters is that `ssh -F` and Dwara's own loader agree about
 * what this block means, and both read a file.
 */
const dirs: string[] = [];
async function parseText(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'dwara-ssm-'));
  dirs.push(dir);
  const path = join(dir, 'ssh_config');
  await writeFile(path, text, 'utf8');
  return parseSshConfig(path);
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const HOSTS = [
  { alias: 'app-a', instanceId: 'i-0123456789abcdef0', user: 'dwara' },
  { alias: 'app-b', instanceId: 'i-0fedcba9876543210', user: 'dwara' },
];

describe('recognising an SSM host', () => {
  it('sees the documented proxy invocation', () => {
    expect(
      usesSsm({
        proxyCommand:
          'sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"',
      }),
    ).toBe(true);
  });

  it('is not fooled by an ordinary proxy', () => {
    expect(usesSsm({ proxyCommand: 'ssh -W %h:%p bastion' })).toBe(false);
    expect(usesSsm({ proxyCommand: undefined })).toBe(false);
  });

  it('takes the target from HostName, because ssh substitutes %h', () => {
    expect(
      ssmTarget({
        hostname: 'i-0123456789abcdef0',
        proxyCommand: 'aws ssm start-session --target %h',
      }),
    ).toBe('i-0123456789abcdef0');
  });

  it('prefers an explicit --target, because someone who wrote one meant it', () => {
    expect(
      ssmTarget({
        hostname: 'ignored',
        proxyCommand: 'aws ssm start-session --target i-0fedcba9876543210',
      }),
    ).toBe('i-0fedcba9876543210');
  });
});

describe('the generated SSH config', () => {
  const text = ssmSshConfig(HOSTS, {
    identityFile: '~/.dwara/keys/dwara',
    knownHostsFile: '~/.dwara/keys/known_hosts',
    region: 'ap-south-1',
  });

  it('parses as an SSH config and resolves through the proxy', async () => {
    const config = await parseText(text);
    const resolved = resolveHost(config, 'app-a');

    expect(resolved.hostname).toBe('i-0123456789abcdef0');
    expect(resolved.user).toBe('dwara');
    expect(usesSsm(resolved)).toBe(true);
    expect(ssmTarget(resolved)).toBe('i-0123456789abcdef0');
  });

  it('keeps the aliases stable and free of instance ids', async () => {
    // The load-bearing property. Policy matches on the alias, and these hosts
    // are in an auto-scaling group: if the alias were the instance id, every
    // refresh would produce a host no rule matches, which the evaluator denies.
    // Dwara would stop working after a routine AWS operation.
    const config = await parseText(text);

    expect(config.hosts).toEqual(['app-a', 'app-b']);
    for (const alias of config.hosts) {
      expect(alias).not.toMatch(/^i-[0-9a-f]+$/u);
    }
  });

  it('is matched by a wildcard policy rule written against the aliases', () => {
    const policy = parsePolicy(`
version: 1
defaults:
  allow: [read]
  deny: [reversible, config, destructive]
hosts:
  - match: 'app-*'
    allow: [read]
`);

    for (const host of HOSTS) {
      expect(selectHostRules(policy.policy.hosts, host.alias).length).toBeGreaterThan(0);
    }
    // And the instance id is not a host the policy knows, which is the failure
    // mode that stable aliases avoid.
    expect(selectHostRules(policy.policy.hosts, 'i-0123456789abcdef0')).toHaveLength(0);
  });

  it('records the instance id as a comment, so an entry can be traced back', () => {
    expect(text).toContain('# instance at time of writing: i-0123456789abcdef0');
  });

  it('multiplexes, because a session per command is too slow to use', () => {
    expect(text).toContain('ControlMaster auto');
    expect(text).toContain('ControlPersist 300');
  });

  it('keeps the non-negotiable connection settings', () => {
    expect(text).toContain('BatchMode yes');
    expect(text).toContain('IdentitiesOnly yes');
    expect(text).toContain('PasswordAuthentication no');
    expect(text).not.toMatch(/StrictHostKeyChecking\s+no/u);
  });

  it('threads the region through the proxy command', () => {
    expect(text).toContain('AWS_REGION=ap-south-1 aws ssm start-session');
  });
});

describe('splicing the block into an existing file', () => {
  it('appends when there is no block yet', () => {
    const out = spliceSsmBlock('Host mine\n  HostName example.invalid\n', ssmSshConfig(HOSTS));

    expect(out).toContain('Host mine');
    expect(out).toContain('Host app-a');
  });

  it('replaces only the generated region, keeping hand-written hosts', () => {
    // Rewriting the whole file would discard hosts somebody added themselves,
    // which is data loss a convenience command has no business causing.
    const first = spliceSsmBlock('Host mine\n  HostName example.invalid\n', ssmSshConfig(HOSTS));
    const second = spliceSsmBlock(
      first,
      ssmSshConfig([{ alias: 'app-a', instanceId: 'i-deadbeef00000000', user: 'dwara' }]),
    );

    expect(second).toContain('Host mine');
    expect(second).toContain('i-deadbeef00000000');
    expect(second).not.toContain('i-0123456789abcdef0');
    expect(second).not.toContain('app-b');
    // Exactly one generated region, not two stacked.
    expect(second.split(BLOCK_START)).toHaveLength(2);
    expect(second.split(BLOCK_END)).toHaveLength(2);
  });

  it('still parses after a rewrite', async () => {
    const once = spliceSsmBlock('', ssmSshConfig(HOSTS));
    const twice = spliceSsmBlock(once, ssmSshConfig(HOSTS));

    expect((await parseText(twice)).hosts).toEqual(['app-a', 'app-b']);
  });
});
