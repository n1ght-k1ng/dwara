import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DwaraError, parseSshConfig } from '@dwara/core';
import { formatReport, runDoctor } from './doctor.js';

/**
 * `dwara init` — from nothing to a first diagnosis.
 *
 * The target in `docs/PLAN.md` is two minutes on a fresh machine, and every
 * decision here is in service of that. It asks the fewest questions it can,
 * defaults to the safest answer, and prints the next thing to do rather than
 * leaving someone to work it out.
 *
 * The defaults are deliberately restrictive. Every selected host starts with
 * `require_approval` for anything that changes state, and tagging a host as
 * production only ever adds restrictions. Someone who wants a looser policy
 * can edit the file; nobody should get one by accident.
 */

const exec = promisify(execFile);

export interface InitOptions {
  /** Where `.dwara/` and `.claude/` are written. Defaults to the cwd. */
  readonly dir?: string;
  readonly sshConfigPath?: string;
  /** Hosts to manage. Asked for interactively when omitted. */
  readonly hosts?: readonly string[];
  /** Of those, the ones to treat as production. */
  readonly production?: readonly string[];
  /** Skip the connectivity check. Only for tests; doctor is the useful part. */
  readonly skipDoctor?: boolean;
  /** Run `claude mcp add`. Off in tests, since it writes outside the project. */
  readonly register?: boolean;
  /** Answer every prompt with its default. */
  readonly yes?: boolean;
  ask?(question: string): Promise<string>;
}

export interface InitResult {
  readonly ok: boolean;
  readonly hosts: readonly string[];
  readonly policyPath: string;
  readonly text: string;
}

/** Hosts worth offering. A wildcard pattern is not a machine. */
function selectable(hosts: readonly string[]): string[] {
  return hosts.filter((host) => !/[*?]/.test(host)).sort();
}

/**
 * The policy file, written by hand rather than serialised.
 *
 * A generated YAML blob is something people skim once; a commented one is
 * something they edit. This is the file that decides what an untrusted model
 * may do, so it is worth the characters.
 */
function policyFor(hosts: readonly string[], production: ReadonlySet<string>): string {
  const rules = hosts
    .map((host) => {
      const tagged = production.has(host);
      return [
        `  - match: '${host}'`,
        tagged ? '    tags: [production]' : null,
        '    require_approval: [reversible, config]',
        tagged ? '    # A production host. Loosen this only on purpose.' : null,
      ]
        .filter((line) => line !== null)
        .join('\n');
    })
    .join('\n\n');

  return `# Dwara policy.
#
# This file decides what an AI agent may do on these hosts. It is the control,
# not a suggestion to the model, so it is worth reading before you rely on it.
#
# Precedence is deny > require_approval > allow. A risk class that no rule
# mentions is denied: silence here is not permission.

version: 1

defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]

hosts:
${rules}

tools:
  # Tools denied everywhere, whatever else this file says.
  never: []
  overrides: {}

redaction:
  # Extra patterns to strip from output, on top of the built-in ones.
  extra_patterns: []

limits:
  # A real investigation reads widely before it concludes anything. Twenty was
  # the original example and proved too low: a diagnosis spent all of it on one
  # host and was cut off before it could look at the others.
  max_actions_per_session: 60
  max_hosts_per_action: 1
`;
}

/** Claude Code permissions: reads are allowed, anything that changes asks. */
function settingsFor(): string {
  return `${JSON.stringify(
    {
      permissions: {
        allow: ['mcp__dwara__read_*'],
        ask: ['mcp__dwara__reversible_*', 'mcp__dwara__config_*'],
      },
    },
    null,
    2,
  )}\n`;
}

/** Config snippets for the other MCP clients, printed rather than written. */
function snippetsFor(policyPath: string, sshConfigPath: string): string {
  const server = {
    command: 'dwara-mcp',
    env: { DWARA_POLICY: policyPath, DWARA_SSH_CONFIG: sshConfigPath },
  };

  return [
    'Other agents use the same stdio server. The config shape differs; the server does not.',
    '',
    '  Codex    ~/.codex/config.toml',
    '    [mcp_servers.dwara]',
    '    command = "dwara-mcp"',
    `    env = { DWARA_POLICY = "${policyPath}", DWARA_SSH_CONFIG = "${sshConfigPath}" }`,
    '',
    '  Cursor   .cursor/mcp.json',
    `    ${JSON.stringify({ mcpServers: { dwara: server } })}`,
    '',
    '  Goose    ~/.config/goose/config.yaml',
    '    extensions:',
    '      dwara:',
    '        type: stdio',
    '        cmd: dwara-mcp',
    `        envs: { DWARA_POLICY: "${policyPath}", DWARA_SSH_CONFIG: "${sshConfigPath}" }`,
  ].join('\n');
}

/** Adds a line to `.gitignore` if it is not already there. */
async function ignore(dir: string, entry: string): Promise<void> {
  const path = join(dir, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    current = '';
  }

  if (current.split('\n').some((line) => line.trim() === entry)) return;

  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await writeFile(
    path,
    `${prefix}\n# Dwara's audit log and approvals are local and not shared.\n${entry}\n`,
    'utf8',
  );
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Sets up Dwara in a project.
 *
 * @throws DwaraError `SSH_CONFIG_INVALID` when the SSH config names no usable
 *   host, since there is nothing to manage and no sensible default to invent.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  // Resolved, because the policy path ends up in the MCP registration and in
  // the snippets for other agents. A relative one would be interpreted
  // against whatever directory the server happened to start in.
  const dir = resolve(options.dir ?? process.cwd());
  const sshConfigPath = options.sshConfigPath ?? '~/.ssh/config';
  const ask = options.ask ?? askTerminal;
  const lines: string[] = [];

  const config = await parseSshConfig(sshConfigPath);
  const available = selectable(config.hosts);

  if (available.length === 0) {
    throw new DwaraError('SSH_CONFIG_INVALID', `no hosts found in ${sshConfigPath}`, {
      details: { sshConfigPath },
      hint: 'Dwara manages hosts you already have in your SSH config; add one there first',
    });
  }

  // 1 · Which hosts.
  //
  // Whether this is an interactive run is decided here and reused below: a
  // caller who passed hosts as flags has told us how they want to be talked
  // to, and should not then be stopped by a prompt they did not expect.
  const interactive = options.hosts === undefined && options.yes !== true;
  let hosts = options.hosts === undefined ? [] : [...options.hosts];
  if (hosts.length === 0) {
    if (options.yes === true) {
      throw new DwaraError('INTERNAL', 'give --host at least once when running non-interactively');
    }

    lines.push(`Found ${available.length} host(s) in ${sshConfigPath}:`, '');
    available.forEach((host, index) => lines.push(`  ${index + 1}. ${host}`));
    lines.push('');
    console.log(lines.join('\n'));

    const answer = await ask('Which should Dwara manage? (numbers or names, comma separated) ');
    hosts = answer
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const index = Number(part);
        return Number.isInteger(index) && index >= 1 && index <= available.length
          ? (available[index - 1] as string)
          : part;
      });
  }

  const unknown = hosts.filter((host) => !available.includes(host));
  if (unknown.length > 0) {
    throw new DwaraError('UNKNOWN_HOST', `not in ${sshConfigPath}: ${unknown.join(', ')}`, {
      details: { unknown, available },
      hint: 'Dwara only manages hosts your SSH config already knows how to reach',
    });
  }
  if (hosts.length === 0) {
    throw new DwaraError('INTERNAL', 'no hosts selected; nothing to set up');
  }

  // 2 · Which of those are production.
  let production = new Set(options.production ?? []);
  if (options.production === undefined && interactive) {
    const answer = await ask('Which of those are production? (comma separated, or blank) ');
    production = new Set(
      answer
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    );
  }

  // 3 · Can we actually reach them?
  if (options.skipDoctor !== true) {
    const report = await runDoctor({ sshConfigPath, hosts, timeoutMs: 15_000 });
    lines.push(formatReport(report, false));
    if (!report.ok) {
      lines.push(
        '',
        'Some hosts are not usable yet. The policy below is still written, so you can',
        'fix the above and re-run `dwara doctor` without starting over.',
      );
    }
  }

  // 4 · Write the policy, and keep local state out of git.
  const policyPath = join(dir, '.dwara', 'policy.yaml');
  await mkdir(join(dir, '.dwara'), { recursive: true });
  await writeFile(policyPath, policyFor(hosts, production), 'utf8');
  await ignore(dir, '.dwara/');

  // 5 · Claude Code permissions: reads allowed, changes ask.
  await mkdir(join(dir, '.claude'), { recursive: true });
  const settingsPath = join(dir, '.claude', 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  if (existing['permissions'] === undefined) {
    await writeFile(settingsPath, settingsFor(), 'utf8');
  } else {
    // Someone has settings already. Overwriting them to add a convenience is
    // not a trade worth making silently.
    lines.push(
      '',
      `${settingsPath} already sets permissions, so it was left alone. To let reads`,
      'run without prompting, add:',
      '    "allow": ["mcp__dwara__read_*"],',
      '    "ask":   ["mcp__dwara__reversible_*", "mcp__dwara__config_*"]',
    );
  }

  // 6 · Register the MCP server.
  let registered = false;
  if (options.register === true) {
    try {
      await exec('claude', [
        'mcp',
        'add',
        'dwara',
        '-e',
        `DWARA_POLICY=${policyPath}`,
        '-e',
        `DWARA_SSH_CONFIG=${sshConfigPath}`,
        '--',
        'dwara-mcp',
      ]);
      registered = true;
    } catch {
      registered = false;
    }
  }

  lines.push(
    '',
    `Wrote ${policyPath}`,
    `Managing: ${hosts.join(', ')}${production.size > 0 ? `  (production: ${[...production].join(', ')})` : ''}`,
    registered
      ? 'Registered the MCP server with Claude Code.'
      : `Register it with:\n    claude mcp add dwara -e DWARA_POLICY=${policyPath} -e DWARA_SSH_CONFIG=${sshConfigPath} -- dwara-mcp`,
    '',
    snippetsFor(policyPath, sshConfigPath),
    '',
    'Everything that changes a host needs you to approve it. When the agent asks,',
    'run `dwara approve <id>` — it prints what the change would do before it asks.',
    '',
    'Try this first:',
    '',
    `    Something is wrong with ${hosts[0] ?? 'that host'}. Diagnose it with the Dwara tools and`,
    '    tell me what you find. Do not change anything yet.',
  );

  return { ok: true, hosts, policyPath, text: lines.join('\n') };
}
