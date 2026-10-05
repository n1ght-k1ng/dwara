#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect, type Verdict } from './detect.js';
import { managedHosts } from './hosts.js';

/**
 * The Dwara PreToolUse hook.
 *
 * Claude Code sends a JSON object on stdin before it runs a tool; this answers
 * with a permission decision. The contract was read out of the Claude Code
 * binary's own embedded documentation rather than assumed: the reply is
 * `hookSpecificOutput.permissionDecision`, one of `allow`, `deny` or `ask`.
 * The older top-level `decision: "block"` is deprecated for PreToolUse and is
 * not used here.
 *
 * **This hook never throws and never exits non-zero.** A hook that crashed
 * would stop protecting anything, and from the outside that failure is
 * indistinguishable from a hook that found nothing wrong. Every error path
 * ends in a decision.
 *
 * It is defence in depth, not a sandbox (DESIGN §4). An agent that really
 * wants to reach a host can write a script and run it, and this will not see
 * inside. The guarantee that does not depend on anything being parsed
 * correctly is the dedicated-key setup, where the agent's own shell holds no
 * credentials for managed hosts.
 */

export const PACKAGE_NAME = '@dwara/hook' as const;
export const VERSION = '0.0.0' as const;

export { inspect } from './detect.js';
export type { Verdict } from './detect.js';
export { managedHosts } from './hosts.js';
export type { Managed } from './hosts.js';
export { EVASION_CASES, MUST_NOT_PASS, CORPUS_HOSTS } from './evasions.js';
export type { EvasionCase, Expectation } from './evasions.js';

/** What Claude Code sends. Only the fields this hook reads are declared. */
export interface HookInput {
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: { readonly command?: unknown };
  readonly cwd?: string;
}

export type Decision = 'allow' | 'deny' | 'ask';

export interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: Decision;
    readonly permissionDecisionReason: string;
  };
}

function reply(permissionDecision: Decision, permissionDecisionReason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

/** Which Dwara tool to reach for instead, guessed from what was attempted. */
function suggestion(command: string): string {
  if (/\b(journalctl|tail|less|cat)\b/.test(command)) {
    return 'read_tail_logs for journal or file logs, read_read_config for configuration';
  }
  if (/\bsystemctl\s+(restart|start|stop)/.test(command)) return 'reversible_restart_service';
  if (/\bsystemctl\b/.test(command)) return 'read_service_status';
  if (/\bdocker\s+restart\b/.test(command)) return 'reversible_restart_container';
  if (/\bdocker\b/.test(command)) return 'read_docker_ps, read_container_logs';
  if (/\b(df|du)\b/.test(command)) return 'read_disk_usage';
  if (/\b(ss|netstat|lsof)\b/.test(command)) return 'read_open_ports';
  if (/\b(vi|vim|nano|sed|tee)\b|>/.test(command)) return 'config_edit_config';
  if (/\bscp\b|\brsync\b/.test(command)) {
    return 'read_read_config to read a file, config_edit_config to change one';
  }
  return 'read_host_overview to orient, then the read_* tool for what you need';
}

/** Turns a verdict into the decision and the sentence that explains it. */
export function decide(command: string, hosts: readonly string[]): HookOutput {
  const verdict: Verdict = inspect(command, hosts);

  if (verdict.kind === 'allow') {
    return reply('allow', 'no managed host involved');
  }

  if (verdict.kind === 'deny') {
    return reply(
      'deny',
      [
        `Dwara manages ${verdict.host}, so reaching it with ${verdict.verb} is blocked.`,
        `Use the Dwara tools instead: ${suggestion(command)}.`,
        'They enforce the policy, redact secrets, snapshot before changing anything and',
        'record what happened. A raw shell does none of that.',
      ].join(' '),
    );
  }

  return reply(
    'deny',
    [
      `This command could reach a host Dwara manages, and it cannot be read with confidence: ${verdict.reason}.`,
      'It is blocked because guessing is the wrong answer here.',
      `If you need something from a managed host, use the Dwara tools: ${suggestion(command)}.`,
      'If this command has nothing to do with managed hosts, write it without the',
      'variable or substitution so it can be read.',
    ].join(' '),
  );
}

/** Reads the whole of stdin. Returns empty on any failure. */
async function readStdin(): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

/** The hook, end to end. Always resolves to a decision. */
export async function run(raw: string): Promise<HookOutput> {
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(raw);
    input = parsed !== null && typeof parsed === 'object' ? (parsed as HookInput) : {};
  } catch {
    // Not something this hook sent; allowing is right, because refusing every
    // tool call on a malformed payload would break the session entirely.
    return reply('allow', 'hook input could not be read');
  }

  if (input.tool_name !== 'Bash') return reply('allow', 'not a shell command');

  const command = input.tool_input?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return reply('allow', 'no command to inspect');
  }

  const managed = await managedHosts({
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });

  return decide(command, managed.hosts);
}

/** Entry point. Writes the decision and exits zero, whatever happened. */
export async function main(): Promise<void> {
  let output: HookOutput;
  try {
    output = await run(await readStdin());
  } catch {
    output = reply('allow', 'the Dwara hook failed and did not inspect this command');
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
