import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSshConfig } from '@dwara/core';
import { BLOCK_START, BLOCK_END } from './ssm.js';
import {
  aliasFor,
  classifyAll,
  classifyReachability,
  defaultUserFor,
  discover,
  generateBlock,
  matchKeyFile,
  parseImageNames,
  parseInstances,
  parseSgAllows22,
  parseSsmOnline,
  parseSsmPlatforms,
  sanitiseAlias,
  type RawInstance,
  type Runner,
} from './discover.js';

/**
 * Fixtures are real in *shape* and fabricated in *content*. The structure was
 * captured from a real account during the first live run; the ids, IPs and names
 * are invented (CLAUDE.md rule 12: never company data in the repo). The decision
 * table they drive is the one that run produced by hand: one reachable public
 * box, several with no public IP and no SSM that are correctly unreachable, and
 * duplicate Name tags that must not collide.
 */

// Mirrors the real account: a reachable UAT box, two prod backends with no public
// IP (and not SSM), and three front-ends sharing one Name tag.
// PlatformDetails is "Linux/UNIX" for every one of these — the billing platform,
// which is what AWS really returns and what caught the earlier heuristic. The
// distro comes from the AMI name (direct hosts) or SSM PlatformName (SSM hosts).
const describeInstances = JSON.stringify({
  Reservations: [
    {
      Instances: [
        {
          InstanceId: 'i-000000000000000a1',
          Tags: [{ Key: 'Name', Value: 'app-uat' }],
          PublicIpAddress: '203.0.113.10',
          PlatformDetails: 'Linux/UNIX',
          ImageId: 'ami-ubuntu',
          KeyName: 'app-ec2-key',
          SecurityGroups: [{ GroupId: 'sg-open22' }],
        },
        {
          InstanceId: 'i-000000000000000b1',
          Tags: [{ Key: 'Name', Value: 'app-be-prod' }],
          PlatformDetails: 'Linux/UNIX',
          ImageId: 'ami-amazon',
          KeyName: 'app-ec2-key',
          SecurityGroups: [{ GroupId: 'sg-closed' }],
        },
        {
          InstanceId: 'i-000000000000000b2',
          Tags: [{ Key: 'Name', Value: 'app-be-prod' }],
          PlatformDetails: 'Linux/UNIX',
          ImageId: 'ami-amazon',
          KeyName: 'app-ec2-key',
          SecurityGroups: [{ GroupId: 'sg-closed' }],
        },
        {
          InstanceId: 'i-000000000000000c1',
          Tags: [{ Key: 'Name', Value: 'app-worker' }],
          PlatformDetails: 'Linux/UNIX',
          ImageId: 'ami-amazon',
          KeyName: 'app-ec2-key',
          SecurityGroups: [{ GroupId: 'sg-closed' }],
        },
      ],
    },
  ],
});

// The worker is SSM-managed and reports its distro; nothing else is.
const describeSsm = JSON.stringify({
  InstanceInformationList: [
    { InstanceId: 'i-000000000000000c1', PingStatus: 'Online', PlatformName: 'Amazon Linux' },
  ],
});

// AMI names carry the distro, in the real `ubuntu/...` / `al2023-...` shapes.
const describeImages = JSON.stringify({
  Images: [
    {
      ImageId: 'ami-ubuntu',
      Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260101',
    },
    { ImageId: 'ami-amazon', Name: 'al2023-ami-2023.6.20260101.0-kernel-6.1-x86_64' },
  ],
});

const describeSgs = JSON.stringify({
  SecurityGroups: [
    {
      GroupId: 'sg-open22',
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22 }],
    },
    {
      GroupId: 'sg-closed',
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
    },
  ],
});

/** Distro per instance the way the orchestrator builds it: SSM wins, else AMI name. */
function fixtureDistro(): Map<string, string> {
  const ssm = parseSsmPlatforms(describeSsm);
  const img = parseImageNames(describeImages);
  const map = new Map<string, string>();
  for (const i of parseInstances(describeInstances)) {
    const d = ssm.get(i.instanceId) ?? (i.imageId === undefined ? undefined : img.get(i.imageId));
    if (d !== undefined) map.set(i.instanceId, d);
  }
  return map;
}

/** A fake `aws` that answers each describe-* call from the fixtures. */
function fakeAws(overrides: Partial<Record<string, { ok: boolean; out: string }>> = {}): Runner {
  return (argv) => {
    const line = argv.join(' ');
    const pick = (out: string) => ({ ok: true, out });
    if (line.includes('describe-instances'))
      return Promise.resolve(overrides['instances'] ?? pick(describeInstances));
    if (line.includes('describe-instance-information'))
      return Promise.resolve(overrides['ssm'] ?? pick(describeSsm));
    if (line.includes('describe-security-groups'))
      return Promise.resolve(overrides['sgs'] ?? pick(describeSgs));
    if (line.includes('describe-images'))
      return Promise.resolve(overrides['images'] ?? pick(describeImages));
    return Promise.resolve({ ok: false, out: `unexpected call: ${line}` });
  };
}

describe('default user from the distro', () => {
  it('maps SSM PlatformName strings', () => {
    expect(defaultUserFor('Ubuntu')).toBe('ubuntu');
    expect(defaultUserFor('Amazon Linux')).toBe('ec2-user');
    expect(defaultUserFor('Debian')).toBe('admin');
    expect(defaultUserFor('Red Hat Enterprise Linux')).toBe('ec2-user');
  });

  it('maps AMI-name tokens, which is the only signal for a direct host', () => {
    expect(defaultUserFor('ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-x')).toBe(
      'ubuntu',
    );
    expect(defaultUserFor('al2023-ami-2023.6.x-kernel-6.1-x86_64')).toBe('ec2-user');
    expect(defaultUserFor('amzn2-ami-ecs-hvm-2.0.x-x86_64-ebs')).toBe('ec2-user');
  });

  it('returns undefined rather than guess on an unknown or billing-only platform', () => {
    // "Linux/UNIX" is PlatformDetails — the billing platform — and must infer nothing.
    expect(defaultUserFor('Linux/UNIX')).toBeUndefined();
    expect(defaultUserFor('Windows')).toBeUndefined();
    expect(defaultUserFor(undefined)).toBeUndefined();
  });
});

describe('alias from the Name tag', () => {
  it('sanitises to a valid ssh token', () => {
    expect(sanitiseAlias('App UAT (prod)')).toBe('app-uat-prod');
    expect(sanitiseAlias('  ---  ')).toBe('host');
  });

  it('de-duplicates a shared Name with an ordinal, never the instance id', () => {
    const taken = new Set<string>();
    const a = aliasFor('app-be-prod', taken);
    taken.add(a);
    const b = aliasFor('app-be-prod', taken);
    expect(a).toBe('app-be-prod');
    expect(b).toBe('app-be-prod-2');
    expect(b).not.toContain('i-');
  });
});

describe('matching a key pair to a local file', () => {
  it('matches by name or name.pem, and never by connecting', () => {
    const files = ['/home/u/.ssh/id_ed25519', '/home/u/.ssh/app-ec2-key.pem'];
    expect(matchKeyFile('app-ec2-key', files)).toBe('/home/u/.ssh/app-ec2-key.pem');
    expect(matchKeyFile('missing-key', files)).toBeUndefined();
    expect(matchKeyFile(undefined, files)).toBeUndefined();
  });
});

describe('the reachability decision', () => {
  const base: RawInstance = {
    instanceId: 'i-1',
    name: 'x',
    publicIp: undefined,
    imageId: 'ami-x',
    keyName: 'k',
    securityGroupIds: ['sg-1'],
  };

  it('public IP + an open :22 rule is direct', () => {
    const r = classifyReachability(
      { ...base, publicIp: '203.0.113.10' },
      new Set(),
      new Set(['sg-1']),
    );
    expect(r).toEqual({ kind: 'direct', hostname: '203.0.113.10' });
  });

  it('no public SSH but Online SSM is via SSM', () => {
    expect(classifyReachability(base, new Set(['i-1']), new Set()).kind).toBe('ssm');
  });

  it('a public IP with no :22 rule is unreachable, and says why', () => {
    const r = classifyReachability({ ...base, publicIp: '203.0.113.10' }, new Set(), new Set());
    expect(r.kind).toBe('unreachable');
    if (r.kind === 'unreachable') expect(r.reason).toContain('no inbound :22');
  });

  it('no public IP and no SSM is unreachable — the production-box case', () => {
    const r = classifyReachability(base, new Set(), new Set());
    expect(r).toEqual({ kind: 'unreachable', reason: 'no public IP and not SSM-managed' });
  });
});

describe('parsing the AWS responses', () => {
  it('pulls the fields discover uses out of describe-instances', () => {
    const parsed = parseInstances(describeInstances);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({
      instanceId: 'i-000000000000000a1',
      name: 'app-uat',
      publicIp: '203.0.113.10',
      imageId: 'ami-ubuntu',
      keyName: 'app-ec2-key',
      securityGroupIds: ['sg-open22'],
    });
  });

  it('reads only the Online SSM agents', () => {
    expect([...parseSsmOnline(describeSsm)]).toEqual(['i-000000000000000c1']);
  });

  it('reads the distro from SSM PlatformName and from the AMI name', () => {
    expect(parseSsmPlatforms(describeSsm).get('i-000000000000000c1')).toBe('Amazon Linux');
    expect(parseImageNames(describeImages).get('ami-ubuntu')).toContain('ubuntu');
  });

  it('finds the groups with an inbound :22 rule', () => {
    const allows = parseSgAllows22(describeSgs);
    expect(allows.has('sg-open22')).toBe(true);
    expect(allows.has('sg-closed')).toBe(false);
  });

  it('treats an all-protocols (-1) rule as opening :22', () => {
    const json = JSON.stringify({
      SecurityGroups: [{ GroupId: 'sg-all', IpPermissions: [{ IpProtocol: '-1' }] }],
    });
    expect(parseSgAllows22(json).has('sg-all')).toBe(true);
  });
});

describe('the whole decision, end to end on the fixtures', () => {
  const hosts = classifyAll(
    parseInstances(describeInstances),
    parseSsmOnline(describeSsm),
    parseSgAllows22(describeSgs),
    { keyFiles: ['/keys/app-ec2-key.pem'], distroById: fixtureDistro() },
  );

  it('reproduces the live-run table', () => {
    const byId = Object.fromEntries(hosts.map((h) => [h.instanceId, h]));
    expect(byId['i-000000000000000a1']?.reachability.kind).toBe('direct');
    expect(byId['i-000000000000000a1']?.user).toBe('ubuntu');
    expect(byId['i-000000000000000a1']?.identityFile).toBe('/keys/app-ec2-key.pem');
    expect(byId['i-000000000000000b1']?.reachability.kind).toBe('unreachable');
    expect(byId['i-000000000000000c1']?.reachability.kind).toBe('ssm');
  });

  it('gives the duplicated Name tag an ordinal, not a colliding alias', () => {
    const aliases = hosts.map((h) => h.alias);
    expect(aliases.filter((a) => a.startsWith('app-be-prod'))).toEqual([
      'app-be-prod',
      'app-be-prod-2',
    ]);
  });
});

describe('the generated block', () => {
  const hosts = classifyAll(
    parseInstances(describeInstances),
    parseSsmOnline(describeSsm),
    parseSgAllows22(describeSgs),
    { keyFiles: ['/keys/app-ec2-key.pem'], distroById: fixtureDistro() },
  );

  it('parses as an SSH config and carries each reachable host', async () => {
    const block = generateBlock(hosts, { profile: 'app' });
    const dir = await mkdtemp(join(tmpdir(), 'dwara-discover-'));
    const file = join(dir, 'ssh_config');
    await writeFile(file, block, 'utf8');
    const config = await parseSshConfig(file);
    expect(config.hosts).toContain('app-uat');
    expect(config.hosts).toContain('app-worker');
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the direct host with its IP and user, not an instance id as HostName', () => {
    const block = generateBlock(hosts);
    expect(block).toContain('Host app-uat');
    expect(block).toContain('HostName 203.0.113.10');
    expect(block).toContain('User ubuntu');
  });

  it('threads the profile into the SSM ProxyCommand', () => {
    expect(generateBlock(hosts, { profile: 'app' })).toContain(
      'AWS_PROFILE=app aws ssm start-session',
    );
  });

  it('leaves the unreachable host as a comment with the reason, not a Host block', () => {
    const block = generateBlock(hosts);
    expect(block).toContain('# app-be-prod');
    expect(block).toContain('not reachable');
    // The prod box must never become a connectable Host entry.
    expect(block).not.toMatch(/^Host app-be-prod$/mu);
  });

  it('warns about the duplicated alias in the header', () => {
    expect(generateBlock(hosts, { duplicated: ['app-be-prod-2'] })).toContain('share a Name tag');
  });
});

describe('discover orchestration (injected runner, no AWS)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-discover-run-'));
    file = join(dir, 'ssh_config');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a spliced config and preserves a hand-written host', async () => {
    await writeFile(file, 'Host mine\n  HostName example.invalid\n', 'utf8');
    const report = await discover({ run: fakeAws(), sshConfigPath: file, keyDirs: [] });

    expect(report.wrote).toBe(true);
    const config = await parseSshConfig(file);
    expect(config.hosts).toContain('mine'); // untouched
    expect(config.hosts).toContain('app-uat'); // added
    expect(report.hosts.filter((h) => h.reachability.kind === 'unreachable')).toHaveLength(2);
  });

  it('infers the login through the full wiring — the regression guard for the live-run catch', async () => {
    // The direct host's distro is only in its AMI name; the SSM host's only in
    // PlatformName. Both must resolve to a user, or discover is back to "set it
    // yourself" for every host, which was the bug the smoke test found.
    const report = await discover({ run: fakeAws(), sshConfigPath: file, keyDirs: [] });
    const byId = Object.fromEntries(report.hosts.map((h) => [h.instanceId, h]));
    expect(byId['i-000000000000000a1']?.user).toBe('ubuntu'); // from the AMI name
    expect(byId['i-000000000000000c1']?.user).toBe('ec2-user'); // from SSM PlatformName
  });

  it('dry-run writes nothing', async () => {
    const report = await discover({
      run: fakeAws(),
      sshConfigPath: file,
      dryRun: true,
      keyDirs: [],
    });
    expect(report.wrote).toBe(false);
    await expect(parseSshConfig(file)).rejects.toThrow();
  });

  it('is idempotent — a second run leaves one generated block', async () => {
    await discover({ run: fakeAws(), sshConfigPath: file, keyDirs: [] });
    await discover({ run: fakeAws(), sshConfigPath: file, keyDirs: [] });
    const text = await (await import('node:fs/promises')).readFile(file, 'utf8');
    expect(text.split(BLOCK_START)).toHaveLength(2);
    expect(text.split(BLOCK_END)).toHaveLength(2);
  });

  it('fails with a fix when AWS cannot be reached', async () => {
    const run = fakeAws({ instances: { ok: false, out: 'Unable to locate credentials' } });
    await expect(discover({ run, sshConfigPath: file, keyDirs: [] })).rejects.toThrow(
      /could not list instances/u,
    );
  });

  it('still classifies when SSM and SG calls fail (degrades, not crashes)', async () => {
    const run = fakeAws({
      ssm: { ok: false, out: 'AccessDenied' },
      sgs: { ok: false, out: 'AccessDenied' },
    });
    const report = await discover({ run, sshConfigPath: file, keyDirs: [] });
    // With no SSM and no SG data, only the public box could ever be direct — and
    // it needs its :22 rule, which we no longer know, so everything is unreachable.
    expect(report.hosts.every((h) => h.reachability.kind === 'unreachable')).toBe(true);
  });
});
