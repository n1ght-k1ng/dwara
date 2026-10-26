import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DwaraError } from '@dwara/core';
import {
  BLOCK_START,
  BLOCK_END,
  spliceSsmBlock,
  ssmStanzaLines,
  tryRun,
  type SsmConfigOptions,
} from './ssm.js';

/**
 * `dwara discover` — fill the SSH config from what AWS already knows.
 *
 * The first live run had to hand-probe which user and key reached a fresh EC2
 * host. That was only necessary because it bypassed AWS: `describe-instances`
 * had already recorded the key pair and the OS, which are the two things that
 * were guessed. This command asks AWS instead.
 *
 * It only **reads** AWS (describe-* calls) and **writes** one local SSH-config
 * file. No host is touched, nothing in AWS is changed, and no key is copied — it
 * names the key pair and looks for a matching file, never stores one. Same
 * posture as the read tools.
 *
 * Everything that decides anything is a pure function taking parsed AWS data, so
 * the whole engine runs in tests with no AWS. The one IO seam is `run`, which
 * defaults to the real `aws` but is injected in tests.
 */

/** Runs a command, reporting failure rather than throwing. Injected in tests. */
export type Runner = (argv: readonly string[]) => Promise<{ ok: boolean; out: string }>;

/** The subset of a `describe-instances` instance this command reads. */
export interface RawInstance {
  readonly instanceId: string;
  readonly name: string | undefined;
  readonly publicIp: string | undefined;
  /** The AMI id, the reliable source of the distro (via its name). */
  readonly imageId: string | undefined;
  readonly keyName: string | undefined;
  readonly securityGroupIds: readonly string[];
}

export type Reachability =
  | { readonly kind: 'direct'; readonly hostname: string }
  | { readonly kind: 'ssm' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export interface Classified {
  readonly instanceId: string;
  readonly alias: string;
  readonly user: string | undefined;
  readonly keyName: string | undefined;
  readonly identityFile: string | undefined;
  readonly reachability: Reachability;
}

/**
 * The default login for an instance, from its distro.
 *
 * **The distro does not come from `describe-instances`.** Its `PlatformDetails`
 * is the *billing* platform ("Linux/UNIX") and never names the distribution —
 * the first live smoke test caught an earlier version reading it and inferring
 * nothing for every Linux host. The real signals are SSM's `PlatformName`
 * ("Amazon Linux", "Ubuntu") and the AMI name (`ubuntu/...`, `al2023-...`,
 * `amzn2-ami-...`), and this matches on whichever is available.
 *
 * A heuristic, and labelled as one wherever it is surfaced: an image can rename
 * its default account. Undefined rather than a wrong guess when nothing matches —
 * a blank `User` with a comment is more honest than confidently writing the
 * wrong one.
 *
 * @param distro SSM `PlatformName`, or the AMI name, or undefined
 */
export function defaultUserFor(distro: string | undefined): string | undefined {
  const p = (distro ?? '').toLowerCase();
  if (p.includes('ubuntu')) return 'ubuntu';
  if (p.includes('debian')) return 'admin';
  // Amazon Linux shows as "Amazon Linux" (SSM) or al2023-/amzn2-/amzn-/amazon (AMI).
  if (/amazon|al20\d\d|amzn/u.test(p)) return 'ec2-user';
  if (p.includes('red hat') || p.includes('rhel')) return 'ec2-user';
  if (p.includes('suse') || p.includes('sles')) return 'ec2-user';
  if (p.includes('rocky') || p.includes('almalinux')) return 'ec2-user';
  if (p.includes('centos')) return 'centos';
  if (p.includes('fedora')) return 'fedora';
  return undefined;
}

/** A `Name` tag reduced to a valid, readable ssh alias. */
export function sanitiseAlias(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned === '' ? 'host' : cleaned;
}

/**
 * A stable alias from the `Name` tag, de-duplicated against aliases already used.
 *
 * Never the instance id: policy matches on the alias, and in an auto-scaling
 * group every id changes on a refresh, so an id-based alias would be denied
 * after a routine AWS operation. Duplicate `Name` tags are real — one account
 * had five instances sharing two names — and get an ordinal suffix, because a
 * single role-alias cannot name two machines without ambiguity. The caller warns
 * the operator to rename.
 */
export function aliasFor(name: string | undefined, taken: ReadonlySet<string>): string {
  const base = name === undefined ? 'host' : sanitiseAlias(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The local private-key file for a key pair, by name.
 *
 * AWS gives the key pair's *name*, never the path on this machine — the key file
 * never left it, which is the point of it. So this matches by name among files
 * the operator has, and never tries a key by connecting: probing keys against a
 * host is the smell this command exists to remove.
 */
export function matchKeyFile(
  keyName: string | undefined,
  candidates: readonly string[],
): string | undefined {
  if (keyName === undefined) return undefined;
  const wanted = [keyName, `${keyName}.pem`];
  return candidates.find((path) => wanted.includes(path.split('/').pop() ?? ''));
}

/**
 * How a single instance should be reached, from the three AWS facts.
 *
 * Public IP with an open :22 wins; otherwise an Online SSM agent; otherwise it is
 * unreachable from here, and the reason is kept rather than the host silently
 * dropped — the no-public-IP, non-SSM case is exactly what left the production
 * boxes unreachable in the first live run.
 */
export function classifyReachability(
  instance: RawInstance,
  ssmOnline: ReadonlySet<string>,
  sgAllows22: ReadonlySet<string>,
): Reachability {
  const open22 = instance.securityGroupIds.some((id) => sgAllows22.has(id));
  if (instance.publicIp !== undefined && open22) {
    return { kind: 'direct', hostname: instance.publicIp };
  }
  if (ssmOnline.has(instance.instanceId)) return { kind: 'ssm' };

  if (instance.publicIp !== undefined && !open22) {
    return {
      kind: 'unreachable',
      reason: 'has a public IP but no inbound :22 rule, and is not SSM-managed',
    };
  }
  return { kind: 'unreachable', reason: 'no public IP and not SSM-managed' };
}

export interface ClassifyOptions {
  readonly keyFiles?: readonly string[];
  readonly keyOverride?: string;
  /** Distro per instance id (SSM PlatformName or AMI name), for the login guess. */
  readonly distroById?: ReadonlyMap<string, string>;
}

/** Turns raw instances into the decided hosts the block is generated from. */
export function classifyAll(
  instances: readonly RawInstance[],
  ssmOnline: ReadonlySet<string>,
  sgAllows22: ReadonlySet<string>,
  options: ClassifyOptions = {},
): Classified[] {
  const taken = new Set<string>();
  const out: Classified[] = [];

  for (const instance of instances) {
    const alias = aliasFor(instance.name, taken);
    taken.add(alias);
    const identityFile =
      options.keyOverride ?? matchKeyFile(instance.keyName, options.keyFiles ?? []);

    out.push({
      instanceId: instance.instanceId,
      alias,
      user: defaultUserFor(options.distroById?.get(instance.instanceId)),
      keyName: instance.keyName,
      identityFile,
      reachability: classifyReachability(instance, ssmOnline, sgAllows22),
    });
  }
  return out;
}

function directStanza(host: Classified, options: SsmConfigOptions): string[] {
  if (host.reachability.kind !== 'direct') return [];
  return [
    '',
    `Host ${host.alias}`,
    `  # ${host.instanceId}`,
    `  HostName ${host.reachability.hostname}`,
    ...(host.user === undefined
      ? ['  # User: could not infer from the AMI — set it']
      : [`  User ${host.user}`]),
    ...(host.identityFile === undefined
      ? host.keyName === undefined
        ? ['  # IdentityFile: this instance has no key pair recorded']
        : [`  # IdentityFile: key pair "${host.keyName}" — no local file found, set the path`]
      : [`  IdentityFile ${host.identityFile}`]),
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    '  PasswordAuthentication no',
    '  StrictHostKeyChecking accept-new',
    ...(options.knownHostsFile === undefined
      ? []
      : [`  UserKnownHostsFile ${options.knownHostsFile}`]),
    '  ConnectTimeout 8',
  ];
}

function unreachableStanza(host: Classified): string[] {
  if (host.reachability.kind !== 'unreachable') return [];
  return [
    '',
    `# ${host.alias} (${host.instanceId}) — not reachable: ${host.reachability.reason}.`,
    '# Left here so you can see it was considered. Open a path (a public :22 rule,',
    '# a bastion, or SSM) and re-run, or add a Host block by hand.',
  ];
}

export interface GenerateOptions extends SsmConfigOptions {
  /** Aliases with a duplicated Name tag, surfaced in the header as a warning. */
  readonly duplicated?: readonly string[];
}

/** The whole generated block: direct, SSM and unreachable stanzas under one pair of markers. */
export function generateBlock(hosts: readonly Classified[], options: GenerateOptions = {}): string {
  const direct = hosts.filter((h) => h.reachability.kind === 'direct').length;
  const ssm = hosts.filter((h) => h.reachability.kind === 'ssm').length;
  const unreachable = hosts.filter((h) => h.reachability.kind === 'unreachable').length;

  const lines: string[] = [
    BLOCK_START,
    '#',
    '# Generated by `dwara discover`. Edit the command, not this block: anything',
    '# between the markers is replaced on the next run. Hosts outside the markers',
    '# are yours and are left alone.',
    '#',
    `# ${direct} direct, ${ssm} via SSM, ${unreachable} unreachable. Generated ${new Date()
      .toISOString()
      .slice(0, 10)}.`,
    '#',
    '# Aliases come from the Name tag, never the instance id: policy matches on the',
    '# alias, and an auto-scaling refresh changes every id.',
  ];

  if (options.duplicated !== undefined && options.duplicated.length > 0) {
    lines.push(
      '#',
      `# Note: these share a Name tag and were given ordinal suffixes — ${options.duplicated.join(
        ', ',
      )}.`,
      '# A single role-alias cannot name two machines; rename them to something stable.',
    );
  }

  for (const host of hosts) {
    if (host.reachability.kind === 'direct') lines.push(...directStanza(host, options));
    else if (host.reachability.kind === 'ssm')
      lines.push(
        ...ssmStanzaLines(
          { alias: host.alias, instanceId: host.instanceId, user: host.user ?? '' },
          options,
        ),
      );
    else lines.push(...unreachableStanza(host));
  }

  lines.push('', BLOCK_END, '');
  return lines.join('\n');
}

// ---- AWS parsing (pure: given the CLI's text output, produce the records) ----

interface AwsJson {
  readonly Reservations?: readonly {
    readonly Instances?: readonly Record<string, unknown>[];
  }[];
}

function tag(instance: Record<string, unknown>, key: string): string | undefined {
  const tags = instance['Tags'];
  if (!Array.isArray(tags)) return undefined;
  const found = tags.find((t) => (t as { Key?: unknown }).Key === key);
  const value = (found as { Value?: unknown } | undefined)?.Value;
  return typeof value === 'string' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Parses `aws ec2 describe-instances` JSON into the fields this command uses. */
export function parseInstances(json: string): RawInstance[] {
  const parsed = JSON.parse(json) as AwsJson;
  const out: RawInstance[] = [];
  for (const reservation of parsed.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      const id = str(instance['InstanceId']);
      if (id === undefined) continue;
      const sgs = Array.isArray(instance['SecurityGroups'])
        ? (instance['SecurityGroups'] as Record<string, unknown>[])
            .map((g) => str(g['GroupId']))
            .filter((g): g is string => g !== undefined)
        : [];
      out.push({
        instanceId: id,
        name: tag(instance, 'Name'),
        publicIp: str(instance['PublicIpAddress']),
        imageId: str(instance['ImageId']),
        keyName: str(instance['KeyName']),
        securityGroupIds: sgs,
      });
    }
  }
  return out;
}

/** Instance ids whose SSM agent is Online, from `describe-instance-information`. */
export function parseSsmOnline(json: string): Set<string> {
  const parsed = JSON.parse(json) as {
    InstanceInformationList?: readonly Record<string, unknown>[];
  };
  const online = new Set<string>();
  for (const info of parsed.InstanceInformationList ?? []) {
    if (info['PingStatus'] === 'Online') {
      const id = str(info['InstanceId']);
      if (id !== undefined) online.add(id);
    }
  }
  return online;
}

/**
 * The distro per instance, from SSM's `PlatformName`.
 *
 * This is the reliable distro signal for SSM-managed hosts — "Amazon Linux",
 * "Ubuntu" — which `describe-instances` cannot give.
 */
export function parseSsmPlatforms(json: string): Map<string, string> {
  const parsed = JSON.parse(json) as {
    InstanceInformationList?: readonly Record<string, unknown>[];
  };
  const platforms = new Map<string, string>();
  for (const info of parsed.InstanceInformationList ?? []) {
    const id = str(info['InstanceId']);
    const name = str(info['PlatformName']);
    if (id !== undefined && name !== undefined) platforms.set(id, name);
  }
  return platforms;
}

/** AMI id -> image name, from `describe-images`. The name carries the distro. */
export function parseImageNames(json: string): Map<string, string> {
  const parsed = JSON.parse(json) as { Images?: readonly Record<string, unknown>[] };
  const names = new Map<string, string>();
  for (const image of parsed.Images ?? []) {
    const id = str(image['ImageId']);
    const name = str(image['Name']) ?? str(image['Description']);
    if (id !== undefined && name !== undefined) names.set(id, name);
  }
  return names;
}

/** Security-group ids that have any inbound TCP :22 rule, from `describe-security-groups`. */
export function parseSgAllows22(json: string): Set<string> {
  const parsed = JSON.parse(json) as { SecurityGroups?: readonly Record<string, unknown>[] };
  const allows = new Set<string>();
  for (const group of parsed.SecurityGroups ?? []) {
    const id = str(group['GroupId']);
    if (id === undefined) continue;
    const perms = Array.isArray(group['IpPermissions']) ? group['IpPermissions'] : [];
    const has22 = perms.some((p) => {
      const perm = p as { FromPort?: unknown; ToPort?: unknown; IpProtocol?: unknown };
      if (perm.IpProtocol === '-1') return true; // all protocols, all ports
      const from = typeof perm.FromPort === 'number' ? perm.FromPort : undefined;
      const to = typeof perm.ToPort === 'number' ? perm.ToPort : undefined;
      return from !== undefined && to !== undefined && from <= 22 && 22 <= to;
    });
    if (has22) allows.add(id);
  }
  return allows;
}

// ---- Orchestration (the one IO seam, run injected) ----

export interface DiscoverOptions {
  readonly run?: Runner;
  readonly sshConfigPath?: string;
  readonly profile?: string;
  readonly region?: string;
  readonly identityFile?: string;
  readonly knownHostsFile?: string;
  /** Override the matched key for every host. */
  readonly keyOverride?: string;
  readonly includeStopped?: boolean;
  /** Print the block instead of writing it. */
  readonly dryRun?: boolean;
  /** Directories to look in for a key file. Defaults to ~/.ssh and ~/.aws. */
  readonly keyDirs?: readonly string[];
  readonly home?: string;
}

export interface DiscoverReport {
  readonly hosts: readonly Classified[];
  readonly block: string;
  readonly path: string;
  readonly wrote: boolean;
  readonly text: string;
}

function realRun(profile: string | undefined, region: string | undefined): Runner {
  return (argv) => {
    const env = [
      ...(profile === undefined ? [] : [`AWS_PROFILE=${profile}`]),
      ...(region === undefined ? [] : [`AWS_REGION=${region}`]),
    ];
    // tryRun shells `aws`; the env assignments ride in front via `env`.
    return tryRun(env.length === 0 ? argv : ['env', ...env, ...argv], 60_000);
  };
}

async function listKeyFiles(dirs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.pub')) files.push(join(dir, name));
      }
    } catch {
      /* a missing ~/.aws is normal */
    }
  }
  return files;
}

/** Reads AWS, decides, and writes the config. Never throws for an unreachable host. */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoverReport> {
  const run = options.run ?? realRun(options.profile, options.region);
  const home = options.home ?? homedir();
  const sshConfigPath = options.sshConfigPath ?? join(home, '.dwara', 'ssh_config');

  const stateFilter = options.includeStopped
    ? []
    : ['--filters', 'Name=instance-state-name,Values=running'];
  const instancesRes = await run(['aws', 'ec2', 'describe-instances', ...stateFilter]);
  if (!instancesRes.ok) {
    throw new DwaraError(
      'COMMAND_FAILED',
      `could not list instances: ${firstLine(instancesRes.out)}`,
      {
        hint: 'Check your AWS login — `aws sso login`, or set AWS_PROFILE. discover only needs read access (ec2:DescribeInstances, ssm:DescribeInstanceInformation, ec2:DescribeSecurityGroups).',
      },
    );
  }

  const instances = parseInstances(instancesRes.out);

  const ssmRes = await run(['aws', 'ssm', 'describe-instance-information']);
  const ssmOnline = ssmRes.ok ? parseSsmOnline(ssmRes.out) : new Set<string>();
  const ssmPlatforms = ssmRes.ok ? parseSsmPlatforms(ssmRes.out) : new Map<string, string>();

  const sgIds = [...new Set(instances.flatMap((i) => i.securityGroupIds))];
  let sgAllows22 = new Set<string>();
  if (sgIds.length > 0) {
    const sgRes = await run(['aws', 'ec2', 'describe-security-groups', '--group-ids', ...sgIds]);
    if (sgRes.ok) sgAllows22 = parseSgAllows22(sgRes.out);
  }

  // The distro for the login guess: SSM PlatformName where we have it, else the
  // AMI name. `describe-instances` alone cannot tell us — its PlatformDetails is
  // the billing platform, not the distribution.
  const imageIds = [
    ...new Set(instances.map((i) => i.imageId).filter((id): id is string => id !== undefined)),
  ];
  let imageNames = new Map<string, string>();
  if (imageIds.length > 0) {
    const imgRes = await run(['aws', 'ec2', 'describe-images', '--image-ids', ...imageIds]);
    if (imgRes.ok) imageNames = parseImageNames(imgRes.out);
  }

  const distroById = new Map<string, string>();
  for (const instance of instances) {
    const distro =
      ssmPlatforms.get(instance.instanceId) ??
      (instance.imageId === undefined ? undefined : imageNames.get(instance.imageId));
    if (distro !== undefined) distroById.set(instance.instanceId, distro);
  }

  const keyDirs = options.keyDirs ?? [join(home, '.ssh'), join(home, '.aws')];
  const keyFiles = await listKeyFiles(keyDirs);

  const hosts = classifyAll(instances, ssmOnline, sgAllows22, {
    keyFiles,
    distroById,
    ...(options.keyOverride === undefined ? {} : { keyOverride: options.keyOverride }),
  });

  const duplicated = hosts.filter((h) => /-\d+$/u.test(h.alias)).map((h) => h.alias);
  const block = generateBlock(hosts, {
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.identityFile === undefined ? {} : { identityFile: options.identityFile }),
    ...(options.knownHostsFile === undefined ? {} : { knownHostsFile: options.knownHostsFile }),
    duplicated,
  });

  let wrote = false;
  if (options.dryRun !== true) {
    await mkdir(dirname(sshConfigPath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(sshConfigPath, 'utf8');
    } catch {
      /* new file */
    }
    await writeFile(sshConfigPath, spliceSsmBlock(existing, block), 'utf8');
    wrote = true;
  }

  return { hosts, block, path: sshConfigPath, wrote, text: summarise(hosts, sshConfigPath, wrote) };
}

export function summarise(hosts: readonly Classified[], path: string, wrote: boolean): string {
  const by = (kind: Reachability['kind']): Classified[] =>
    hosts.filter((h) => h.reachability.kind === kind);
  const lines: string[] = [];

  for (const host of hosts) {
    const r = host.reachability;
    const mark = r.kind === 'unreachable' ? '  --' : '  ok';
    const how =
      r.kind === 'direct' ? `direct ${r.hostname}` : r.kind === 'ssm' ? 'via SSM' : r.reason;
    const key =
      r.kind === 'unreachable'
        ? ''
        : host.identityFile !== undefined
          ? ''
          : host.keyName !== undefined
            ? `  [key "${host.keyName}" not found locally]`
            : '  [no key pair on the instance]';
    lines.push(`${mark}  ${host.alias.padEnd(28)} ${how}${key}`);
  }

  lines.push('');
  lines.push(
    wrote
      ? `Wrote ${by('direct').length + by('ssm').length} reachable host(s) to ${path}.`
      : `Dry run — nothing written. ${by('direct').length + by('ssm').length} host(s) would be added.`,
  );
  if (by('unreachable').length > 0) {
    lines.push(`${by('unreachable').length} unreachable, left as comments with the reason.`);
  }
  lines.push('');
  lines.push('Next: write a policy (a host no rule matches is denied), then');
  lines.push(`  dwara doctor --ssh-config ${path} --policy <policy>`);
  return lines.join('\n');
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
