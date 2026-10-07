import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedHost } from '@dwara/core';
import type { Check } from './doctor.js';

/**
 * Reaching a host through AWS Systems Manager instead of an open SSH port.
 *
 * Dwara needs **no transport changes** for this: `ssh -F` honours `ProxyCommand`
 * itself, and `ControlMaster=auto` -- which the transport already sets -- reuses
 * one SSM session across every command instead of paying a new `start-session`
 * per call. Without multiplexing each tool call would cost a second or two of
 * handshake, which is the difference between usable and not.
 *
 * What Dwara does need is a way to tell these hosts apart when something is
 * wrong. **Every SSM misconfiguration arrives as the same SSH timeout**: the AWS
 * CLI missing, the Session Manager plugin missing, expired credentials, an IAM
 * policy without `ssm:StartSession`, or an agent that is simply offline on the
 * far side. A fifteen-second wait followed by "connection closed" sends people
 * looking at sshd. So the checks below run *before* connecting, locally, and
 * each one names the fix.
 */

const exec = promisify(execFile);

/** Matches the documented SSM proxy invocation, however it is spelled. */
const SSM_PROXY = /\bssm\s+start-session\b/u;

/** True when this host is reached through an SSM session rather than a socket. */
export function usesSsm(resolved: Pick<ResolvedHost, 'proxyCommand'>): boolean {
  return resolved.proxyCommand !== undefined && SSM_PROXY.test(resolved.proxyCommand);
}

/**
 * The instance the proxy will target.
 *
 * `%h` in a `ProxyCommand` is substituted by ssh with `HostName`, so the target
 * is the resolved hostname -- which for SSM is an instance id rather than
 * anything resolvable in DNS. An explicit `--target i-...` in the command wins,
 * because someone who wrote one meant it.
 */
export function ssmTarget(resolved: Pick<ResolvedHost, 'hostname' | 'proxyCommand'>): string {
  const explicit = /--target\s+(i-[0-9a-f]+)/u.exec(resolved.proxyCommand ?? '');
  return explicit?.[1] ?? resolved.hostname;
}

/** Runs a local command, reporting failure rather than throwing. */
async function tryRun(
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  const [command, ...args] = argv;
  try {
    const { stdout, stderr } = await exec(command!, args, { timeout: timeoutMs });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || (err.message ?? ''),
    };
  }
}

/**
 * Local preflight for an SSM-reached host.
 *
 * Ordered so the cheapest and most commonly wrong thing is first. Stops at the
 * first failure, because every later check would fail for the same reason and a
 * list of five red lines hides which one to fix.
 */
export async function preflightSsm(target: string, timeoutMs = 15_000): Promise<Check[]> {
  const checks: Check[] = [];

  const cli = await tryRun(['aws', '--version'], timeoutMs);
  if (!cli.ok) {
    return [
      {
        name: 'aws cli',
        status: 'fail',
        detail: 'the `aws` command is not on PATH',
        fix: 'install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      },
    ];
  }
  checks.push({ name: 'aws cli', status: 'ok', detail: cli.out.split(' ')[0] ?? 'present' });

  // The one people miss. The CLI alone is not enough: `start-session` shells out
  // to a separate binary, and without it ssh sees the proxy exit immediately.
  const plugin = await tryRun(['session-manager-plugin', '--version'], timeoutMs);
  if (!plugin.ok && !/installed successfully/iu.test(plugin.out)) {
    return [
      ...checks,
      {
        name: 'session plugin',
        status: 'fail',
        detail: 'session-manager-plugin is not installed; ssh will see the proxy exit at once',
        fix: 'install it: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
      },
    ];
  }
  checks.push({ name: 'session plugin', status: 'ok', detail: 'installed' });

  const who = await tryRun(
    ['aws', 'sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'],
    timeoutMs,
  );
  if (!who.ok) {
    return [
      ...checks,
      {
        name: 'credentials',
        status: 'fail',
        detail: firstLine(who.out) || 'no usable AWS credentials',
        fix: 'refresh them — `aws sso login`, or set the profile with AWS_PROFILE',
      },
    ];
  }
  checks.push({ name: 'credentials', status: 'ok', detail: principal(who.out) });

  // Whether the agent on the far side is actually talking to SSM. An instance
  // that is running but whose agent is offline cannot be reached at all, and
  // nothing about that is visible from the SSH side.
  const online = await tryRun(
    [
      'aws',
      'ssm',
      'describe-instance-information',
      '--filters',
      `Key=InstanceIds,Values=${target}`,
      '--query',
      'InstanceInformationList[0].PingStatus',
      '--output',
      'text',
    ],
    timeoutMs,
  );
  const status = online.out.trim();

  if (!online.ok) {
    checks.push({
      name: 'ssm agent',
      status: 'fail',
      detail: firstLine(online.out) || `could not ask SSM about ${target}`,
      fix: 'the IAM principal needs ssm:DescribeInstanceInformation, and ssm:StartSession on this target',
    });
  } else if (status === 'Online') {
    checks.push({ name: 'ssm agent', status: 'ok', detail: `${target} is Online` });
  } else if (status === 'None' || status === '') {
    checks.push({
      name: 'ssm agent',
      status: 'fail',
      detail: `SSM does not know ${target}`,
      fix: 'check the instance id, the region, and that the instance has an IAM role with AmazonSSMManagedInstanceCore',
    });
  } else {
    checks.push({
      name: 'ssm agent',
      status: 'fail',
      detail: `${target} is ${status}, not Online`,
      fix: 'the SSM agent on the instance is not reporting; restart amazon-ssm-agent there',
    });
  }

  return checks;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

/**
 * The principal, without the account id.
 *
 * `doctor` output gets pasted into tickets and chat. The role or user name is
 * the part that answers "am I who I think I am"; the account number is not, and
 * it is the part people regret sharing.
 */
function principal(arn: string): string {
  const name = arn.trim().split('/').slice(1).join('/');
  return name === '' ? 'valid' : `valid as ${name}`;
}

/** One host to write into the generated SSH config block. */
export interface SsmHost {
  /** The stable alias. Policy matches on this, so it must not be an instance id. */
  readonly alias: string;
  readonly instanceId: string;
  readonly user: string;
}

export interface SsmConfigOptions {
  readonly identityFile?: string;
  readonly knownHostsFile?: string;
  readonly region?: string;
  readonly profile?: string;
}

/** Marks the region of a file this tool owns, so a rewrite replaces only that. */
export const BLOCK_START = '# >>> dwara ssm hosts (generated) >>>';
export const BLOCK_END = '# <<< dwara ssm hosts (generated) <<<';

/**
 * Generates the SSH config for a set of SSM-reached hosts.
 *
 * **The alias is the load-bearing part, and it must not be the instance id.**
 * Dwara's policy matches on the host alias: a rule saying `match: 'app-*'`
 * is what makes a host read-only. These instances are in an auto-scaling group,
 * so a scale event or an instance refresh replaces them and every id changes --
 * and a host whose alias nobody has written a rule for is denied outright by the
 * evaluator. Fails closed, which is right, but it means Dwara would quietly stop
 * working after a routine AWS operation. Stable aliases keep the policy pointing
 * at a *role* rather than at a machine.
 *
 * The cost of that choice, stated in the output: the same alias can mean a
 * different physical instance after a replacement, so the audit log's host field
 * identifies the role and not the box. The id is written as a comment beside each
 * entry so an operator can tell which machine an entry meant at the time.
 */
export function ssmSshConfig(hosts: readonly SsmHost[], options: SsmConfigOptions = {}): string {
  const env = [
    options.profile === undefined ? '' : `AWS_PROFILE=${options.profile} `,
    options.region === undefined ? '' : `AWS_REGION=${options.region} `,
  ].join('');

  const lines: string[] = [
    BLOCK_START,
    '#',
    '# Generated by `dwara discover`. Edit the command, not this block: anything',
    '# between the markers is replaced on the next run.',
    '#',
    '# Aliases are deliberately stable and are NOT instance ids. The policy matches',
    '# on the alias, and these hosts are in an auto-scaling group -- after a refresh',
    '# every id changes, and a host no rule matches is refused. The trade is that an',
    '# alias names a role rather than a machine, so the id below is the one seen at',
    '# generation time and may not be the one you reach later.',
    '#',
    `# Generated ${new Date().toISOString().slice(0, 10)}`,
  ];

  for (const host of hosts) {
    lines.push(
      '',
      `Host ${host.alias}`,
      `  # instance at time of writing: ${host.instanceId}`,
      `  HostName ${host.instanceId}`,
      `  User ${host.user}`,
      ...(options.identityFile === undefined ? [] : [`  IdentityFile ${options.identityFile}`]),
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  PasswordAuthentication no',
      '  StrictHostKeyChecking accept-new',
      ...(options.knownHostsFile === undefined
        ? []
        : [`  UserKnownHostsFile ${options.knownHostsFile}`]),
      '  ConnectTimeout 10',
      // ControlMaster is what makes this usable rather than merely possible: one
      // SSM session is reused for every command instead of a fresh handshake per
      // call, which costs a second or two each.
      '  ControlMaster auto',
      '  ControlPersist 300',
      `  ProxyCommand sh -c "${env}aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"`,
    );
  }

  lines.push('', BLOCK_END, '');
  return lines.join('\n');
}

/**
 * Replaces the generated block in an existing file, leaving everything else.
 *
 * Rewriting the whole file would throw away hosts a person added by hand, which
 * is the kind of data loss a convenience command has no business causing.
 */
export function spliceSsmBlock(existing: string, block: string): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);

  if (start < 0 || end < 0 || end < start) {
    const base = existing.trimEnd();
    return base === '' ? block : `${base}\n\n${block}`;
  }

  return existing.slice(0, start) + block.trimStart() + existing.slice(end + BLOCK_END.length + 1);
}
