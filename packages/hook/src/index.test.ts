import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACKAGE_NAME, VERSION, decide, run } from './index.js';
import { managedHosts } from './hosts.js';

const POLICY = `
version: 1
defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]
hosts:
  - match: "lab-api"
  - match: "lab-*"
limits:
  max_actions_per_session: 60
  max_hosts_per_action: 1
`;

let dir: string;

/** A hook payload as Claude Code sends one. */
function payload(command: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 's_1',
    transcript_path: '/tmp/t.jsonl',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...over,
  });
}

const decisionOf = (out: Awaited<ReturnType<typeof run>>): string =>
  out.hookSpecificOutput.permissionDecision;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-hook-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function withPolicy(): Promise<void> {
  await mkdir(join(dir, '.dwara'), { recursive: true });
  await writeFile(join(dir, '.dwara', 'policy.yaml'), POLICY, 'utf8');
}

describe('@dwara/hook', () => {
  it('reports its package identity', () => {
    expect(PACKAGE_NAME).toBe('@dwara/hook');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the reply shape', () => {
  it('answers in the form Claude Code expects', async () => {
    await withPolicy();
    const out = await run(payload('ssh lab-api'));

    // Read out of the Claude Code binary's own docs: permissionDecision, not
    // the deprecated top-level `decision: "block"`.
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
    expect(out).not.toHaveProperty('decision');
  });
});

describe('what the hook looks at', () => {
  beforeEach(withPolicy);

  it('ignores every tool but Bash', async () => {
    const out = await run(payload('ssh lab-api', { tool_name: 'Read' }));

    expect(decisionOf(out)).toBe('allow');
  });

  it('blocks a managed host from Bash', async () => {
    expect(decisionOf(await run(payload('ssh lab-api')))).toBe('deny');
  });

  it('allows a host no policy names', async () => {
    expect(decisionOf(await run(payload('ssh my-other-box')))).toBe('allow');
  });

  it('allows ordinary development commands', async () => {
    for (const command of ['pnpm test', 'git status', 'ls -la', 'grep ssh README.md']) {
      expect(decisionOf(await run(payload(command))), command).toBe('allow');
    }
  });
});

describe('failing safely', () => {
  it('allows when the payload is not JSON, rather than breaking the session', async () => {
    // Refusing everything on a malformed payload would make Claude Code
    // unusable, and this hook is defence in depth rather than the guarantee.
    expect(decisionOf(await run('not json at all'))).toBe('allow');
    expect(decisionOf(await run(''))).toBe('allow');
  });

  it('allows when there is no command to look at', async () => {
    expect(decisionOf(await run(JSON.stringify({ tool_name: 'Bash', tool_input: {} })))).toBe(
      'allow',
    );
    expect(
      decisionOf(await run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: '   ' } }))),
    ).toBe('allow');
  });

  it('allows when the command is not a string', async () => {
    const out = await run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: { evil: true } } }),
    );

    expect(decisionOf(out)).toBe('allow');
  });
});

describe('with no policy anywhere', () => {
  it('stays silent, even for a command it would otherwise block', async () => {
    // The decision that makes the plugin installable globally.
    expect(decisionOf(await run(payload('ssh lab-api')))).toBe('allow');
    expect(decisionOf(await run(payload('scp f lab-db:/tmp')))).toBe('allow');
  });

  it('reports no managed hosts rather than guessing some', async () => {
    expect(await managedHosts({ cwd: dir })).toEqual({ hosts: [] });
  });
});

describe('resolving managed hosts', () => {
  it('takes literal host names straight from the policy', async () => {
    await withPolicy();
    const managed = await managedHosts({ cwd: dir, sshConfigPath: '/nonexistent' });

    // `lab-api` is literal; `lab-*` needs an SSH config to expand and there
    // is none, which must not lose the literal.
    expect(managed.hosts).toContain('lab-api');
  });

  it('expands wildcards against the SSH config', async () => {
    await withPolicy();
    const managed = await managedHosts({ cwd: dir, sshConfigPath: 'testbed/ssh_config' });

    expect(managed.hosts).toEqual(
      expect.arrayContaining(['lab-api', 'lab-db', 'lab-cache', 'lab-queue', 'lab-staging']),
    );
  });

  it('survives a policy file that will not load', async () => {
    await mkdir(join(dir, '.dwara'), { recursive: true });
    await writeFile(join(dir, '.dwara', 'policy.yaml'), 'this: is: not: valid', 'utf8');

    expect(await managedHosts({ cwd: dir })).toEqual({ hosts: [] });
  });
});

describe('what a denial tells the model', () => {
  it('names the host, the verb, and the tool to use instead', () => {
    const reason = decide('ssh lab-api journalctl -u nginx', ['lab-api']).hookSpecificOutput
      .permissionDecisionReason;

    expect(reason).toContain('lab-api');
    expect(reason).toContain('ssh');
    // A block the model cannot act on just produces a second attempt.
    expect(reason).toContain('read_tail_logs');
  });

  it('suggests the matching tool for what was attempted', () => {
    const cases: [string, string][] = [
      ['ssh lab-api systemctl restart nginx', 'reversible_restart_service'],
      ['ssh lab-api docker restart app', 'reversible_restart_container'],
      ['ssh lab-api df -h', 'read_disk_usage'],
      ['ssh lab-api ss -tlnp', 'read_open_ports'],
      ['scp ./nginx.conf lab-api:/etc/nginx/', 'config_edit_config'],
    ];

    for (const [command, wanted] of cases) {
      expect(
        decide(command, ['lab-api']).hookSpecificOutput.permissionDecisionReason,
        command,
      ).toContain(wanted);
    }
  });

  it('says plainly when it could not read the command', () => {
    const reason = decide('ssh $HOST', ['lab-api']).hookSpecificOutput.permissionDecisionReason;

    expect(reason).toContain('cannot be read with confidence');
    expect(reason).toContain('variable');
  });
});
