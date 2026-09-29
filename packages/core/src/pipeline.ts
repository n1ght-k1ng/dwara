import type { AuditLog } from './audit/log.js';
import { wrap, type Envelope } from './envelope.js';
import { DwaraError } from './errors.js';
import { evaluate } from './policy/evaluate.js';
import type { LoadedPolicy } from './policy/load.js';
import { selectHostRules } from './policy/match.js';
import { defaultRedactor, type Redactor } from './redact/redact.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';
import { confirmRestored, createSnapshot, restoreSnapshot } from './snapshot/manager.js';
import { pruneSnapshots } from './snapshot/retention.js';
import { summariseVerify } from './verify/run.js';
import {
  newRequestId,
  planHash,
  type Approval,
  type ApprovalRequest,
  type ApprovalStore,
} from './approval/store.js';
import type { Session } from './session.js';
import type { SshConfig } from './ssh/config.js';
import type {
  Ctx,
  Decision,
  HttpCheck,
  RawResult,
  RemoteCommand,
  RollbackOutcome,
  SnapshotRef,
  ToolResult,
  VerifyResult,
} from './types.js';

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
  /**
   * Where human approvals are read from.
   *
   * Without one, a policy that requires approval simply refuses — which is what
   * Phase 2 did, and is still the correct answer when no approval flow exists.
   */
  readonly approvals?: ApprovalStore;
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

    // 4 · Approval. Nothing reachable from here can grant one: no MCP tool may
    // create approvals (CLAUDE.md rule 5), and a tool's only capability is
    // `Ctx.run`, which reaches a remote host and cannot write a local file.
    // What the pipeline may do is spend an approval a human already granted.
    let approval: Approval | undefined;

    if (decision.kind === 'approval') {
      const hash = planHash({ tool: tool.name, host, input });
      approval = await this.options.approvals?.find(hash);

      if (approval === undefined) {
        // Record what was asked for, so `dwara approve` can show a person the
        // arguments rather than an opaque id. A request is not permission.
        const request: ApprovalRequest = {
          id: newRequestId(),
          plan_hash: hash,
          tool: name,
          host,
          risk: tool.risk,
          input: this.redactor.redactDeep(input) as Record<string, unknown>,
          reason: decision.reason,
          created_at: new Date().toISOString(),
        };
        await this.options.approvals?.record(request);

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
          request,
        });
      }

      // Spent before the action runs, not after. If the process dies midway the
      // approval is gone, which is the safe direction to fail: a human grants
      // another. Spending it afterwards would leave a window in which the same
      // approval could authorise a second action.
      await this.options.approvals?.consume(approval.id);
    }

    // 5 · Execute. From here the action has reached a host, so it counts
    // against the session budget whatever happens next.
    session.recordExecuted();

    // 5a · Snapshot, before anything changes. A mutating tool that cannot be
    // backed up does not run at all: the alternative is changing a host while
    // believing in a restore point that does not exist.
    let snapshot: SnapshotRef | undefined;
    if (tool.mutates) {
      try {
        // `snapshot()` is inside the try because a tool may guard its arguments
        // there, and that is the right place for it -- a refusal raised while
        // describing what to back up happens before anything reaches the host.
        // It must still come back as a typed result: CLAUDE.md is explicit that
        // tools never throw raw errors at the MCP layer.
        //
        // The registry refuses a mutating tool with no snapshot(), so a missing
        // spec here would be a bug in this file rather than in the tool.
        const spec = tool.snapshot(validated) ?? { paths: [] };
        snapshot = await createSnapshot(spec, this.context(host, session));
      } catch (err) {
        const error = DwaraError.from(err, 'SNAPSHOT_FAILED');
        // A tool that refused its own arguments keeps its code and its wording:
        // "cannot snapshot" would be the wrong thing to tell someone who asked
        // to restart a container Dwara will not touch.
        const refused = error.code !== 'SNAPSHOT_FAILED';

        await this.write({
          tool,
          name,
          host,
          session,
          decision,
          input,
          result: refused ? 'refused' : 'error',
          detail: refused ? error.message : `nothing was changed: ${error.message}`,
          code: error.code,
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
    }

    const ctx = this.context(host, session, snapshot);

    let raws: RawResult[];
    try {
      raws = await this.run(tool, validated, host, ctx);
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
        ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
        ...(approval === undefined ? {} : { approval: approval.id }),
      });

      return {
        ok: false,
        tool: name,
        host,
        decision,
        // Even an error message is server-influenced: stderr reaches it.
        error: this.redactor.redactDeep(error.toJSON()),
        // The action died part-way. The snapshot is the way back, and the id
        // has to reach the caller or `dwara rollback` has nothing to work with.
        ...(snapshot === undefined ? {} : { snapshot }),
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

    // 7 · Verify, and undo if the postconditions do not hold. This is the
    // guarantee the whole phase exists for: a change that did not work is not
    // left in place for a human to find later.
    let verify: VerifyResult | undefined;
    let rollback: RollbackOutcome | undefined;

    if (tool.mutates) {
      verify = await tool.verify(validated, ctx);

      if (verify !== undefined && !verify.ok) {
        rollback = await this.undo(tool, snapshot, ctx);

        const error = rollback.ok
          ? new DwaraError(
              'VERIFY_FAILED',
              `${name} did not work, and was undone: ${summariseVerify(verify)}`,
              {
                details: {
                  tool: name,
                  host,
                  ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
                },
                hint: 'the host is back as it was; read the failing check and try a different change',
              },
            )
          : !tool.restorable
            ? new DwaraError(
                'VERIFY_FAILED',
                `${name} did not work, and cannot be undone: ${summariseVerify(verify)}`,
                {
                  details: {
                    tool: name,
                    host,
                    ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
                  },
                  // Not ROLLBACK_FAILED: nothing went wrong with the undo,
                  // because there was never an undo to attempt. What must not
                  // happen is telling anyone the host is back as it was.
                  hint: 'the change stands and the host is not as it was; the snapshot records what went',
                },
              )
            : new DwaraError(
                'ROLLBACK_FAILED',
                `${name} did not work and could not be undone: ${summariseVerify(verify)}. Rollback: ${rollback.detail}`,
                {
                  details: {
                    tool: name,
                    host,
                    ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
                  },
                  // The loudest thing Dwara can say. A human has to look.
                  // Only offer `dwara rollback` when there is something for it
                  // to put back. A units-only snapshot holds no files, and
                  // sending someone to a command that cannot help wastes the one
                  // moment they most need a straight answer.
                  hint:
                    snapshot === undefined || snapshot.paths.length === 0
                      ? 'this host needs a human; Dwara changed it and could not put it back'
                      : `this host needs a human. Try: dwara rollback ${snapshot.id}`,
                },
              );

        await this.write({
          tool,
          name,
          host,
          session,
          decision,
          input,
          result: 'rolled_back',
          detail: error.message,
          code: error.code,
          startedAt,
          ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
          ...(approval === undefined ? {} : { approval: approval.id }),
        });

        return {
          ok: false,
          tool: name,
          host,
          decision,
          error: this.redactor.redactDeep(error.toJSON()),
          verify,
          rollback,
          ...(snapshot === undefined ? {} : { snapshot }),
          durationMs: Date.now() - startedAt,
        };
      }

      // The change stuck. Tidy the store now rather than letting it grow until
      // a full disk becomes the next incident; a failure here is not the
      // caller's problem, since the action itself succeeded.
      await pruneSnapshots(ctx).catch(() => undefined);
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

    // 8 · Audit.
    await this.write({
      tool,
      name,
      host,
      session,
      decision,
      input,
      result: failed ? 'failed' : verify === undefined ? 'ok' : 'verified',
      detail: [
        summarise(raws, envelope.suspicions.length),
        verify === undefined ? '' : summariseVerify(verify),
      ]
        .filter((part) => part !== '')
        .join('; '),
      startedAt,
      ...(snapshot === undefined ? {} : { snapshot: snapshot.id }),
      ...(approval === undefined ? {} : { approval: approval.id }),
    });

    return {
      ok: !failed,
      tool: name,
      host,
      decision,
      data: envelope,
      truncated,
      ...(verify === undefined ? {} : { verify }),
      ...(snapshot === undefined ? {} : { snapshot }),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Runs a tool's commands, stopping at the first transport failure.
   *
   * A tool that defines `apply` sequences its own commands, because a later one
   * depends on an earlier one's output. It runs them through the same `ctx.run`
   * this method would have used, so the transport, the escaping and the output
   * cap are identical either way — the only difference is who decides what comes
   * next. The registry guarantees exactly one of the two is defined.
   */
  private async run(
    tool: RegisteredTool,
    input: unknown,
    host: string,
    ctx: Ctx,
  ): Promise<RawResult[]> {
    const staged = tool.apply(input, ctx);
    if (staged !== undefined) return [...(await staged)];

    const results: RawResult[] = [];
    for (const command of tool.build(input) ?? []) {
      results.push(await this.options.runner.run(host, command));
    }
    return results;
  }

  /**
   * Puts a host back after a change that did not verify.
   *
   * Two steps, in this order. The snapshot restores the **bytes**, checked
   * against the hashes taken before the change, because that is the part that
   * can be proven. Then the tool's own `rollback` commands run, because bytes
   * on disk are not the whole state — a restored config does nothing until the
   * service reloads, and a unit that was stopped before needs stopping again.
   *
   * Never throws. The caller is already handling a failure and needs both
   * outcomes in one result, not a second exception hiding the first.
   */
  private async undo(
    tool: RegisteredTool,
    snapshot: SnapshotRef | undefined,
    ctx: Ctx,
  ): Promise<RollbackOutcome> {
    // A tool that declares itself unrestorable has nothing to attempt. Saying
    // so plainly beats running an empty rollback and calling it a success.
    if (!tool.restorable) {
      return {
        attempted: false,
        ok: false,
        detail: 'this change cannot be undone; the snapshot records what it removed',
      };
    }

    const notes: string[] = [];
    let ok = true;

    if (snapshot !== undefined && snapshot.paths.length > 0) {
      try {
        const restore = await restoreSnapshot(snapshot, ctx);
        ok &&= restore.ok;
        notes.push(restore.detail);
      } catch (err) {
        ok = false;
        notes.push(`restoring files threw: ${DwaraError.from(err).message}`);
      }
    }

    const commands = snapshot === undefined ? undefined : tool.rollback(snapshot);
    if (commands !== undefined && commands.length > 0) {
      try {
        for (const command of commands) {
          const result = await ctx.run(command);
          if (result.exitCode !== 0) {
            ok = false;
            notes.push(
              `${command.argv.join(' ')} exited ${result.exitCode}: ${result.stderr.trim().split('\n')[0] ?? ''}`,
            );
          }
        }
      } catch (err) {
        ok = false;
        notes.push(`recovery commands threw: ${DwaraError.from(err).message}`);
      }
    }

    // The recovery commands exiting zero is not the claim being made. A
    // `Type=simple` unit reports a successful `systemctl start` as soon as the
    // fork succeeds, so a service whose binary dies immediately rolls back
    // "successfully" and keeps crash-looping. Dwara would then say the host is
    // back as it was, which is the one thing it must never get wrong. So the
    // units are watched for a moment and compared against what was recorded.
    if (snapshot !== undefined) {
      try {
        const restored = await confirmRestored(snapshot, ctx);
        ok &&= restored.ok;
        notes.push(restored.detail);
      } catch (err) {
        ok = false;
        notes.push(`could not confirm the restore: ${DwaraError.from(err).message}`);
      }
    }

    return {
      attempted: true,
      ok,
      detail: notes.length > 0 ? notes.join('; ') : 'nothing needed restoring',
    };
  }

  /** The execution context handed to `apply`, `verify` and `rollback`. */
  private context(host: string, session: Session, snapshot?: SnapshotRef): Ctx {
    return {
      host,
      sessionId: session.id,
      run: (command) => this.options.runner.run(host, command),
      httpChecks: this.httpChecksFor(host),
      ...(snapshot === undefined ? {} : { snapshot }),
    };
  }

  /**
   * The host's HTTP postconditions, translated out of policy.
   *
   * Every rule that tied on specificity contributes, matching how the evaluator
   * treats a tie: a check named by any winning rule is one the operator asked
   * for, and silently dropping it would weaken verification rather than policy.
   */
  private httpChecksFor(host: string): readonly HttpCheck[] {
    return selectHostRules(this.options.policy.policy.hosts, host).flatMap((rule) =>
      (rule.health_checks ?? []).map((check) => ({
        url: check.http,
        expectStatus: check.expect_status,
      })),
    );
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
    request?: ApprovalRequest;
  }): Promise<ToolResult<Envelope<unknown>>> {
    args.session.recordRefused();

    const code =
      args.code ?? (args.decision.kind === 'deny' ? args.decision.code : 'APPROVAL_REQUIRED');

    await this.write({
      ...args,
      detail: args.decision.reason,
      code,
      ...(args.request === undefined ? {} : { approval: args.request.id }),
    });

    return {
      ok: false,
      tool: args.name,
      host: args.host,
      decision: args.decision,
      error: {
        code: code as DwaraError['code'],
        message: args.decision.reason,
        details: {
          rule: args.decision.rule,
          ...(args.request === undefined
            ? {}
            : { approval_id: args.request.id, plan_hash: args.request.plan_hash }),
        },
        ...(args.decision.kind === 'approval'
          ? {
              hint:
                args.request === undefined
                  ? 'a human has to approve this; no tool can grant it'
                  : `a human has to approve this; no tool can grant it. Ask them to run: dwara approve ${args.request.id}`,
            }
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
    result: 'ok' | 'verified' | 'rolled_back' | 'failed' | 'refused' | 'error';
    detail?: string;
    code?: string;
    startedAt: number;
    snapshot?: string;
    approval?: string;
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
      ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
      ...(args.approval === undefined ? {} : { approval: args.approval }),
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
