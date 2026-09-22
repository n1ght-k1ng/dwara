import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSshConfig, resolveHost } from './config.js';

let dir: string;

async function write(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-sshcfg-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseSshConfig', () => {
  it('lists literal aliases and skips wildcard blocks', async () => {
    const path = await write(
      'basic',
      `
Host lab-api lab-db
  User dwara

Host *
  ServerAliveInterval 15

Host prod-*
  User ops
`,
    );

    const config = await parseSshConfig(path);
    // `Host *` and `prod-*` set defaults; neither is a host you can connect to.
    expect(config.hosts).toEqual(['lab-api', 'lab-db']);
  });

  it('accepts both "Keyword value" and "Keyword=value"', async () => {
    const path = await write('equals', 'Host lab-api\n  Port=2201\n  User = dwara\n');
    const resolved = resolveHost(await parseSshConfig(path), 'lab-api');

    expect(resolved.port).toBe(2201);
    expect(resolved.user).toBe('dwara');
  });

  it('ignores comments and blank lines', async () => {
    const path = await write(
      'comments',
      '# a comment\n\nHost lab-api\n  # indented comment\n  Port 2201\n',
    );
    expect(resolveHost(await parseSshConfig(path), 'lab-api').port).toBe(2201);
  });

  it('strips quotes around values', async () => {
    const path = await write('quoted', 'Host lab-api\n  IdentityFile "~/keys/with space"\n');
    expect(resolveHost(await parseSshConfig(path), 'lab-api').identityFile).toContain('with space');
  });

  it('treats settings before any Host line as global', async () => {
    const path = await write('global', 'User ops\n\nHost lab-api\n  Port 2201\n');
    const config = await parseSshConfig(path);

    expect(resolveHost(config, 'lab-api').user).toBe('ops');
    expect(config.hosts).toEqual(['lab-api']);
  });

  it('ignores keywords it does not need', async () => {
    const path = await write('unknown', 'Host lab-api\n  SomeFutureOption yes\n  Port 2201\n');
    // A config Dwara does not fully understand is normal; refusing to start
    // over an unrecognised keyword would be worse than ignoring it.
    await expect(parseSshConfig(path)).resolves.toBeDefined();
    expect(resolveHost(await parseSshConfig(path), 'lab-api').port).toBe(2201);
  });

  it('reports a missing top-level config as an error', async () => {
    await expect(parseSshConfig(join(dir, 'absent'))).rejects.toMatchObject({
      code: 'SSH_CONFIG_INVALID',
    });
  });
});

describe('Include', () => {
  it('pulls in another file', async () => {
    await write('inc/extra', 'Host lab-extra\n  Port 2299\n');
    const path = await write('with-include', 'Include inc/extra\n\nHost lab-api\n  Port 2201\n');

    const config = await parseSshConfig(path);
    expect(config.hosts).toEqual(['lab-extra', 'lab-api']);
    expect(resolveHost(config, 'lab-extra').port).toBe(2299);
  });

  it('expands a glob, in sorted order', async () => {
    await write('conf.d/10-a', 'Host lab-a\n');
    await write('conf.d/20-b', 'Host lab-b\n');
    const path = await write('globbed', 'Include conf.d/*\n');

    expect((await parseSshConfig(path)).hosts).toEqual(['lab-a', 'lab-b']);
  });

  it('ignores an Include that matches nothing', async () => {
    const path = await write('empty-include', 'Include nothing.d/*\n\nHost lab-api\n');
    expect((await parseSshConfig(path)).hosts).toEqual(['lab-api']);
  });

  it('ignores a missing Include target', async () => {
    const path = await write('missing-include', 'Include definitely-absent\n\nHost lab-api\n');
    expect((await parseSshConfig(path)).hosts).toEqual(['lab-api']);
  });

  it('survives an Include cycle', async () => {
    await write('cycle-a', 'Include cycle-b\nHost lab-a\n');
    await write('cycle-b', 'Include cycle-a\nHost lab-b\n');

    const config = await parseSshConfig(join(dir, 'cycle-a'));
    expect(new Set(config.hosts)).toEqual(new Set(['lab-a', 'lab-b']));
  });
});

describe('resolveHost', () => {
  let path: string;

  beforeAll(async () => {
    path = await write(
      'resolve',
      `
Host lab-api
  HostName 127.0.0.1
  Port 2201
  User dwara
  IdentityFile ~/.ssh/lab
  ProxyJump bastion

Host lab-*
  User fallback
  Port 2299

Host *
  User everyone
`,
    );
  });

  it('keeps the first value seen for a keyword', async () => {
    const resolved = resolveHost(await parseSshConfig(path), 'lab-api');

    // The specific block wins over the later lab-* and * blocks, as ssh does.
    expect(resolved).toMatchObject({ hostname: '127.0.0.1', port: 2201, user: 'dwara' });
    expect(resolved.proxyJump).toBe('bastion');
  });

  it('falls through to less specific blocks for values the first did not set', async () => {
    const resolved = resolveHost(await parseSshConfig(path), 'lab-db');
    expect(resolved).toMatchObject({ user: 'fallback', port: 2299 });
  });

  it('defaults hostname to the alias itself', async () => {
    expect(resolveHost(await parseSshConfig(path), 'anything').hostname).toBe('anything');
  });

  it('applies a bare Host * to an alias nothing else matches', async () => {
    expect(resolveHost(await parseSshConfig(path), 'anything').user).toBe('everyone');
  });

  it('ignores a port that is not a positive integer', async () => {
    const bad = await write('bad-port', 'Host lab-api\n  Port not-a-number\n');
    expect(resolveHost(await parseSshConfig(bad), 'lab-api').port).toBeUndefined();

    const negative = await write('neg-port', 'Host lab-api\n  Port -1\n');
    expect(resolveHost(await parseSshConfig(negative), 'lab-api').port).toBeUndefined();
  });

  it('honours a negated pattern', async () => {
    const negated = await write('negated', 'Host lab-* !lab-db\n  User dwara\n');
    const config = await parseSshConfig(negated);

    expect(resolveHost(config, 'lab-api').user).toBe('dwara');
    expect(resolveHost(config, 'lab-db').user).toBeUndefined();
    // A negation is not an alias you can connect to.
    expect(config.hosts).toEqual([]);
  });
});

describe('the testbed config', () => {
  it('parses and resolves every lab host', async () => {
    const config = await parseSshConfig('testbed/ssh_config');

    expect(config.hosts).toEqual(['lab-api', 'lab-db', 'lab-cache', 'lab-queue', 'lab-staging']);
    expect(resolveHost(config, 'lab-api')).toMatchObject({
      hostname: '127.0.0.1',
      port: 2201,
      user: 'dwara',
    });
    expect(resolveHost(config, 'lab-staging').port).toBe(2205);
  });
});
