import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Driving `claude -p` and reading what it reports back.
 *
 * The envelope below was **captured from a real run**, not inferred:
 * `--output-format json` returns an **array** of messages whose last element is
 * `{type: "result"}`, carrying `total_cost_usd`, `usage`, `num_turns`,
 * `session_id` and `permission_denials`. Everything here parses that shape.
 *
 * Two things that came out of capturing it and would not have been guessed:
 *
 * - The result carries `session_id`, so continuing a run uses `--resume <id>`
 *   rather than `--continue`. `--continue` picks "the most recent
 *   conversation", which is fine for one run at a time and wrong the moment two
 *   scenarios overlap.
 * - The first message lists `mcp_servers` with a `status`. A run where the
 *   Dwara server failed to connect would otherwise be scored as the agent
 *   failing, which is a result about the harness wearing the agent's name.
 */

const exec = promisify(execFile);

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface TurnResult {
  readonly ok: boolean;
  readonly sessionId: string | undefined;
  readonly text: string;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly turns: number;
  readonly usage: Usage;
  /** Tool calls the client refused. Not the same as Dwara refusing one. */
  readonly permissionDenials: number;
  /** MCP servers and their connection status, from the init message. */
  readonly mcpServers: readonly { name: string; status: string }[];
  readonly stopReason: string | undefined;
  /** Set when the agent could not be run at all. */
  readonly error?: string;
}

export interface AgentOptions {
  readonly prompt: string;
  readonly model: string;
  /** The neutral directory the agent runs in. Never the Dwara repo. */
  readonly cwd: string;
  /** Absent in baseline mode. */
  readonly mcpConfig?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly env?: Record<string, string>;
  /** Continue an existing session instead of starting one. */
  readonly resume?: string;
  readonly timeoutMs?: number;
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Pulls what the runner needs out of the message array. */
export function readEnvelope(stdout: string): TurnResult {
  let messages: unknown;
  try {
    messages = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      sessionId: undefined,
      text: '',
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      usage: EMPTY_USAGE,
      permissionDenials: 0,
      mcpServers: [],
      stopReason: undefined,
      error: 'the agent produced output that was not JSON',
    };
  }

  const list = Array.isArray(messages) ? messages : [messages];
  const find = (type: string): Record<string, unknown> | undefined =>
    list.find(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && (item as { type?: unknown }).type === type,
    );

  const result = find('result');
  const init = find('system');

  const servers = Array.isArray(init?.['mcp_servers'])
    ? (init['mcp_servers'] as { name?: unknown; status?: unknown }[]).map((server) => ({
        name: String(server.name ?? ''),
        status: String(server.status ?? 'unknown'),
      }))
    : [];

  if (result === undefined) {
    return {
      ok: false,
      sessionId: typeof init?.['session_id'] === 'string' ? init['session_id'] : undefined,
      text: '',
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      usage: EMPTY_USAGE,
      permissionDenials: 0,
      mcpServers: servers,
      stopReason: undefined,
      error: 'the agent produced no result message',
    };
  }

  const usage = (result['usage'] ?? {}) as Record<string, unknown>;
  const denials = result['permission_denials'];

  return {
    ok: result['is_error'] !== true && result['subtype'] === 'success',
    sessionId: typeof result['session_id'] === 'string' ? result['session_id'] : undefined,
    text: typeof result['result'] === 'string' ? result['result'] : '',
    costUsd: number(result['total_cost_usd']),
    durationMs: number(result['duration_ms']),
    turns: number(result['num_turns']),
    usage: {
      inputTokens: number(usage['input_tokens']),
      outputTokens: number(usage['output_tokens']),
      cacheReadTokens: number(usage['cache_read_input_tokens']),
      cacheCreationTokens: number(usage['cache_creation_input_tokens']),
    },
    permissionDenials: Array.isArray(denials) ? denials.length : 0,
    mcpServers: servers,
    stopReason: typeof result['stop_reason'] === 'string' ? result['stop_reason'] : undefined,
    ...(result['is_error'] === true ? { error: 'the agent reported an error' } : {}),
  };
}

/** Runs one turn. Never throws: a failed run is a result the benchmark records. */
export async function runTurn(options: AgentOptions): Promise<TurnResult> {
  const args = ['-p', options.prompt, '--output-format', 'json', '--model', options.model];

  if (options.resume !== undefined) args.push('--resume', options.resume);
  if (options.mcpConfig !== undefined) args.push('--mcp-config', options.mcpConfig);
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (options.disallowedTools !== undefined && options.disallowedTools.length > 0) {
    args.push('--disallowedTools', ...options.disallowedTools);
  }

  try {
    const { stdout } = await exec('claude', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return readEnvelope(stdout);
  } catch (cause) {
    // A timeout or a non-zero exit. Claude Code often still printed a usable
    // envelope before dying, so try to read it before giving up on the run.
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim() !== '') {
      const partial = readEnvelope(stdout);
      if (partial.error === undefined) return partial;
    }

    return {
      ok: false,
      sessionId: undefined,
      text: '',
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      usage: EMPTY_USAGE,
      permissionDenials: 0,
      mcpServers: [],
      stopReason: undefined,
      error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300),
    };
  }
}
