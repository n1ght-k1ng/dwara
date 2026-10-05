import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePolicy } from '@dwara/core';
import { init } from './init.js';

/**
 * `init` against the committed testbed SSH config.
 *
 * Never against `~/.ssh/config`: `CLAUDE.md` forbids pointing Dwara at
 * anything outside the lab during phases 0–6, and a setup command that read
 * the developer's real hosts while being tested would be exactly that.
 *
 * `register` is off throughout, because `claude mcp add` writes outside the
 * project and a test has no business changing someone's Claude Code config.
 */
const SSH_CONFIG = 'testbed/ssh_config';

let dir: string;

const base = {
  sshConfigPath: SSH_CONFIG,
  skipDoctor: true,
  register: false,
} as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-init-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const policyAt = async (): Promise<string> => readFile(join(dir, '.dwara', 'policy.yaml'), 'utf8');

describe('init writes a usable policy', () => {
  it('writes one that the policy loader accepts', async () => {
    const result = await init({ ...base, dir, hosts: ['lab-api', 'lab-db'] });

    // The file is the control. If it does not load, nothing else matters.
    const parsed = parsePolicy(await policyAt()).policy;
    expect(parsed.hosts.map((rule) => rule.match)).toEqual(['lab-api', 'lab-db']);
    expect(result.hosts).toEqual(['lab-api', 'lab-db']);
  });

  it('defaults to requiring approval for anything that changes state', async () => {
    await init({ ...base, dir, hosts: ['lab-api'] });
    const policy = parsePolicy(await policyAt()).policy;

    expect(policy.defaults.allow).toEqual(['read']);
    expect(policy.defaults.require_approval).toEqual(['reversible', 'config']);
    expect(policy.defaults.deny).toEqual(['destructive']);
    expect(policy.hosts[0]?.require_approval).toEqual(['reversible', 'config']);
  });

  it('tags production hosts, and only those', async () => {
    await init({ ...base, dir, hosts: ['lab-api', 'lab-staging'], production: ['lab-api'] });
    const policy = parsePolicy(await policyAt()).policy;

    expect(policy.hosts.find((rule) => rule.match === 'lab-api')?.tags).toEqual(['production']);
    expect(policy.hosts.find((rule) => rule.match === 'lab-staging')?.tags).toBeUndefined();
  });

  it('leaves comments in the file, because it is meant to be edited', async () => {
    await init({ ...base, dir, hosts: ['lab-api'] });
    const text = await policyAt();

    expect(text).toContain('This file decides what an AI agent may do');
    expect(text).toContain('silence here is not permission');
  });
});

describe('init keeps local state out of git', () => {
  it('adds .dwara/ to .gitignore', async () => {
    await init({ ...base, dir, hosts: ['lab-api'] });

    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.dwara/');
  });

  it('appends rather than clobbering an existing .gitignore', async () => {
    await writeFile(join(dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    await init({ ...base, dir, hosts: ['lab-api'] });
    const text = await readFile(join(dir, '.gitignore'), 'utf8');

    expect(text).toContain('node_modules/');
    expect(text).toContain('.dwara/');
  });

  it('does not add it twice on a second run', async () => {
    await init({ ...base, dir, hosts: ['lab-api'] });
    await init({ ...base, dir, hosts: ['lab-api'] });
    const text = await readFile(join(dir, '.gitignore'), 'utf8');

    expect(text.split('\n').filter((line) => line.trim() === '.dwara/')).toHaveLength(1);
  });
});

describe('init and Claude Code permissions', () => {
  it('allows reads and asks for anything that changes', async () => {
    await init({ ...base, dir, hosts: ['lab-api'] });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      permissions: { allow: string[]; ask: string[] };
    };

    // The risk prefix on every tool name is what makes these two rules enough.
    expect(settings.permissions.allow).toEqual(['mcp__dwara__read_*']);
    expect(settings.permissions.ask).toEqual(['mcp__dwara__reversible_*', 'mcp__dwara__config_*']);
  });

  it('does not overwrite permissions someone already set', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const mine = { permissions: { deny: ['Bash'] } };
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(mine), 'utf8');

    const result = await init({ ...base, dir, hosts: ['lab-api'] });

    expect(JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'))).toEqual(mine);
    // Silently discarding someone's configuration to add a convenience is not
    // a trade worth making, so it says what to add instead.
    expect(result.text).toContain('left alone');
    expect(result.text).toContain('mcp__dwara__read_*');
  });
});

describe('init refuses what it cannot do', () => {
  it('refuses a host the SSH config does not know', async () => {
    await expect(init({ ...base, dir, hosts: ['not-a-real-host'] })).rejects.toMatchObject({
      code: 'UNKNOWN_HOST',
    });
  });

  it('refuses an SSH config with no hosts in it', async () => {
    const empty = join(dir, 'empty_config');
    await writeFile(empty, '# nothing here\n', 'utf8');

    await expect(
      init({ ...base, dir, sshConfigPath: empty, hosts: ['lab-api'] }),
    ).rejects.toMatchObject({ code: 'SSH_CONFIG_INVALID' });
  });

  it('refuses to guess when run non-interactively with no hosts', async () => {
    await expect(init({ ...base, dir, yes: true })).rejects.toThrowError(/--host/);
  });
});

describe('init tells you what to do next', () => {
  it('prints the command to register the server when it did not', async () => {
    const result = await init({ ...base, dir, hosts: ['lab-api'] });

    expect(result.text).toContain('claude mcp add dwara');
    expect(result.text).toContain(join(dir, '.dwara', 'policy.yaml'));
  });

  it('prints snippets for the other agents', async () => {
    const result = await init({ ...base, dir, hosts: ['lab-api'] });

    for (const agent of ['Codex', 'Cursor', 'Goose']) {
      expect(result.text).toContain(agent);
    }
  });

  it('ends with a first prompt naming a real host', async () => {
    const result = await init({ ...base, dir, hosts: ['lab-db'] });

    expect(result.text).toContain('Try this first:');
    expect(result.text).toContain('lab-db');
    // Setup should not end by suggesting a change.
    expect(result.text).toContain('Do not change anything yet');
  });

  it('says that changes need approving', async () => {
    const result = await init({ ...base, dir, hosts: ['lab-api'] });

    expect(result.text).toContain('dwara approve');
  });
});

describe('init interactively', () => {
  it('accepts hosts chosen by number', async () => {
    const ask = vi
      .fn<(q: string) => Promise<string>>()
      .mockResolvedValueOnce('1, 2')
      .mockResolvedValueOnce('');

    const result = await init({ ...base, dir, ask });

    // testbed/ssh_config lists lab-api, lab-cache, lab-db, lab-queue,
    // lab-staging; sorted, 1 and 2 are lab-api and lab-cache.
    expect(result.hosts).toEqual(['lab-api', 'lab-cache']);
  });

  it('accepts hosts chosen by name, and production as a second answer', async () => {
    const ask = vi
      .fn<(q: string) => Promise<string>>()
      .mockResolvedValueOnce('lab-api, lab-staging')
      .mockResolvedValueOnce('lab-api');

    await init({ ...base, dir, ask });
    const policy = parsePolicy(await policyAt()).policy;

    expect(policy.hosts.map((rule) => rule.match)).toEqual(['lab-api', 'lab-staging']);
    expect(policy.hosts.find((rule) => rule.match === 'lab-api')?.tags).toEqual(['production']);
  });
});
