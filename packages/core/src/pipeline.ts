import type { AuditLog } from './audit/log.js';
import { wrap, type Envelope } from './envelope.js';
import { DwaraError } from './errors.js';
import { evaluate } from './policy/evaluate.js';
import type { LoadedPolicy } from './policy/load.js';
import { defaultRedactor, type Redactor } from './redact/redact.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';
import type { Session } from './session.js';
import type { SshConfig } from './ssh/config.js';
import type { Decision, RawResult, RemoteCommand, ToolResult } from './types.js';

/** What the pipeline needs to run a command. `SshTransport` satisfies it. */
export interface CommandRunner {
  run(host: string, command: RemoteCommand): Promise<RawResult>;
}

export interface PipelineOptions {
  readonly policy: LoadedPolicy;
  readonly sshConfig: SshConfig;
  readonly runner: CommandRunner;
  readonly registry: ToolRegistry;
  readonly audit: AuditLog;
  readonly redactor?: Redactor;
}

/**
 * Runs one tool call, start to finish.
 *
 * The order is DESIGN §3 and it is not negotiable:
 *
 * 1. validate the arguments against the tool's schema
 * 2. resolve the host against the SSH config and the policy
 * 3. ask the policy engine
 * 4. stop here if approval is required — nothing in this process can grant it
 * 5. execute
 * 6. parse, redact, wrap as untrusted data
 * 7. write an audit entry
 *
 * Every exit from this function writes an audit entry, including the refusals.
 * A log that recorded only what succeeded would describe an agent that never
 * hit a limit.
 */
export class Pipeline {
  private readonly options: PipelineOptions;
  private readonly redactor: Redactor;

  constructor(options: PipelineOptions) {
    this.options = options;
    this.redactor = options.redactor ?? defaultRedactor;
  }

  async execute(
    toolName: string,
    args: unknown,
    session: Session,
  ): Promise<ToolResult<Envelope<unknown>>> {
    const startedAt = Date.now();
    const tool = this.options.registry.get(toolName);

    if (!tool) {
      // No audit entry: an unknown name means no tool, no host and no risk
      // class, so there is nothing to record against. The MCP layer never
      // sends one, because it only advertises registered tools.
      throw new DwaraError('INTERNAL', `no tool named "${toolName}"`, {
        details: { tool: toolName, known: this.options.registry.list().map((t) => t.name) },
      });
    }

    const name = tool.mcpName;

    // 1 · Arguments. A model can send anything; the schema is what decides.
    const parsed = tool.validate(args);
    if (!parsed.ok) {
      const problems = parsed.problems;

      return this.refuse({
        tool,
        name,
        host: readHost(args) ?? 'unknown',
        session,
        startedAt,
        decision: {
          kind: 'deny',
          reason: `arguments are not valid: ${problems.join('; ')}`,
          rule: 'tool.input',
          code: 'INTERNAL',
        },
        input: args,
        result: 'error',
      });
    }

    const validated = parsed.value;
    const input = validated as Record<string, unknown>;
    const host = String(input['host']);

    // 2–3 · Host resolution and the policy decision, both from Phase 1.
    const decision = evaluate({
      policy: this.options.policy.policy,
      tool: tool.name,
      risk: tool.risk,
      hosts: [host],
      knownHosts: this.options.sshConfig.hosts,
      session: { actionsUsed: session.actionsUsed },
    });

    if (decision.kind === 'deny') {
      return this.refuse({
        tool,
        name,
        host,
        session,
        startedAt,
        decision,
        input,
        result: 'refused',
      });
    }

    // 4 · Approval. Nothing reachable from here can grant one — no MCP tool may
    // create approvals (CLAUDE.md rule 5), and the CLI flow arrives in Phase 4.
    // Until then the honest answer is to stop and say what is needed.
    if (decision.kind === 'approval') {
      return this.refuse({
        tool,
        name,
        host,
        session,
        startedAt,
        decision,
        input,
        result: 'refused',
        code: 'APPROVAL_REQUIRED',
      });
    }

    // 5 · Execute. From here the action has reached a host, so it counts
    // against the session budget whatever happens next.
    session.recordExecuted();

    let raws: RawResult[];
    try {
      raws = await this.run(tool, validated, host);
    } catch (err) {
      const error = DwaraError.from(err);
      await this.write({
        tool,
        name,
        host,
        session,
        decision,
        input,
        result: 'error',
        detail: error.message,
        code: error.code,
        startedAt,
      });

      return {
        ok: false,
        tool: name,
        host,
        decision,
        // Even an error message is server-influenced: stderr reaches it.
        error: this.redactor.redactDeep(error.toJSON()),
        durationMs: Date.now() - startedAt,
      };
    }

    // 6 · Parse, redact, wrap. Order matters: the tool's parser sees the raw
    // text so its structure survives, and redaction happens on the result so
    // nothing reaches the model unfiltered.
    const truncated = raws.some((raw) => raw.truncated);
    let data: unknown;
    try {
      data = tool.parse(raws);
    } catch (err) {
      // Said plainly, because the distinction matters to whoever reads it: the
      // host answered and Dwara could not make sense of the reply. That is a
      // bug here, not a fault on the far end.
      const error = new DwaraError(
        'INTERNAL',
        `could not parse output from ${name}: ${err instanceof Error ? err.message : String(err)}`,
        { details: { tool: name, host }, cause: err },
      );

      await this.write({
        tool,
        name,
        host,
        session,
        decision,
        input,
        result: 'error',
        detail: error.message,
        code: 'INTERNAL',
        startedAt,
      });

      return {
        ok: false,
        tool: name,
        host,
        decision,
        error: this.redactor.redactDeep(error.toJSON()),
        durationMs: Date.now() - startedAt,
      };
    }

    const redacted = this.redactor.redactDeep(data);
    const envelope = wrap(redacted, {
      host,
      tool: name,
      truncated,
      // Scan the raw text, not the parsed shape: a parser may drop the very
      // line an injection attempt was hiding in.
      scan: this.redactor.redact(raws.map((raw) => `${raw.stdout}\n${raw.stderr}`).join('\n')).text,
    });

    const failed = raws.some((raw) => raw.exitCode !== 0);

    // 7 · Audit.
    await this.write({
      tool,
      name,
      host,
      session,
      decision,
      input,
      result: failed ? 'failed' : 'ok',
      detail: summarise(raws, envelope.suspicions.length),
      startedAt,
    });

    return {
      ok: !failed,
      tool: name,
      host,
      decision,
      data: envelope,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Runs a tool's commands in order, stopping at the first transport failure. */
  private async run(tool: RegisteredTool, input: unknown, host: string): Promise<RawResult[]> {
    const commands = tool.build(input);
    const results: RawResult[] = [];

    for (const command of commands) {
      results.push(await this.options.runner.run(host, command));
    }
    return results;
  }

  /** Records a refusal and returns it. Nothing ran. */
  private async refuse(args: {
    tool: RegisteredTool;
    name: string;
    host: string;
    session: Session;
    startedAt: number;
    decision: Decision;
    input: unknown;
    result: 'refused' | 'error';
    code?: string;
  }): Promise<ToolResult<Envelope<unknown>>> {
    args.session.recordRefused();

    const code =
      args.code ?? (args.decision.kind === 'deny' ? args.decision.code : 'APPROVAL_REQUIRED');

    await this.write({
      ...args,
      detail: args.decision.reason,
      code,
    });

    return {
      ok: false,
      tool: args.name,
      host: args.host,
      decision: args.decision,
      error: {
        code: code as DwaraError['code'],
        message: args.decision.reason,
        details: { rule: args.decision.rule },
        ...(args.decision.kind === 'approval'
          ? { hint: 'a human has to approve this; no tool can grant it' }
          : {}),
      },
      durationMs: Date.now() - args.startedAt,
    };
  }

  private async write(args: {
    tool: RegisteredTool;
    name: string;
    host: string;
    session: Session;
    decision: Decision;
    input: unknown;
    result: 'ok' | 'failed' | 'refused' | 'error';
    detail?: string;
    code?: string;
    startedAt: number;
  }): Promise<void> {
    await this.options.audit.append({
      session: args.session.id,
      agent: args.session.agent,
      tool: args.name,
      host: args.host,
      risk: args.tool.risk,
      decision: args.decision.kind,
      rule: args.decision.rule,
      ...(args.code === undefined ? {} : { code: args.code }),
      input: asRecord(args.input),
      result: args.result,
      detail: args.detail ?? '',
      duration_ms: Date.now() - args.startedAt,
      policy_hash: this.options.policy.hash,
    });
  }
}

/** A one-line summary for the audit log. Never the output itself. */
function summarise(raws: readonly RawResult[], suspicions: number): string {
  const codes = raws.map((raw) => raw.exitCode).join(',');
  const bytes = raws.reduce((total, raw) => total + raw.stdout.length + raw.stderr.length, 0);
  const flagged = suspicions > 0 ? `, ${suspicions} suspicious pattern(s)` : '';
  return `${raws.length} command(s), exit ${codes}, ${bytes} bytes${flagged}`;
}

/** Best-effort host from unvalidated arguments, for an audit entry on refusal. */
function readHost(args: unknown): string | undefined {
  if (args !== null && typeof args === 'object' && 'host' in args) {
    const host = (args as { host: unknown }).host;
    if (typeof host === 'string' && host.length > 0) return host;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value: String(value) };
}
