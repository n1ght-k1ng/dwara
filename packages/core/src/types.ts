import type { z } from 'zod';
import type { DwaraError } from './errors.js';

/**
 * How much damage a tool can do, independent of what it claims to do.
 *
 * The policy engine decides per risk class, never per tool description, because
 * descriptions are written for a model and the model is untrusted.
 */
export enum Risk {
  /** Observes only. No remote state changes. */
  Read = 'read',
  /** Changes state that a restart or a snapshot restore puts back. */
  Reversible = 'reversible',
  /** Edits persistent configuration. Needs a snapshot and a validator. */
  Config = 'config',
  /** Destroys data. Denied unconditionally in the MVP. */
  Destructive = 'destructive',
}

/** The risk classes, ordered from least to most dangerous. */
export const RISK_ORDER: readonly Risk[] = [
  Risk.Read,
  Risk.Reversible,
  Risk.Config,
  Risk.Destructive,
] as const;

/**
 * One command to run on a host.
 *
 * `argv` is an array because the transport escapes each element separately.
 * Nothing in Dwara builds a remote command by string concatenation, so a value
 * that came from the model can never become shell syntax.
 */
export interface RemoteCommand {
  /** Program and arguments. Each element is escaped individually. */
  readonly argv: readonly string[];
  /** Run under `sudo -n`. Never anything that could prompt for a password. */
  readonly sudo?: boolean;
  /** Hard wall-clock limit for this command. */
  readonly timeoutMs: number;
  /** Fed to the command's stdin, for content too large or too structured for argv. */
  readonly stdin?: string;
}

/** What actually came back from a host. Untrusted data. */
export interface RawResult {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when output hit the cap and was cut. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * A policy verdict.
 *
 * `rule` names the thing that decided, so an audit entry can be traced back to
 * a line of policy rather than to "the engine said no".
 */
export type Decision =
  | { readonly kind: 'allow'; readonly reason: string; readonly rule: string }
  | { readonly kind: 'approval'; readonly reason: string; readonly rule: string }
  | {
      readonly kind: 'deny';
      readonly reason: string;
      readonly rule: string;
      readonly code: DwaraError['code'];
    };

/** Where a snapshot lives on the host, and what it captured. */
export interface SnapshotSpec {
  /** Absolute paths to copy before the change. */
  readonly paths: readonly string[];
  /** Units whose state is recorded so it can be put back. */
  readonly units?: readonly string[];
}

/** A snapshot that exists, referenced when rolling back. */
export interface SnapshotRef {
  readonly id: string;
  readonly host: string;
  readonly createdAt: string;
  readonly paths: readonly string[];
}

/** The outcome of checking postconditions after a change. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
  }[];
  readonly durationMs: number;
}

/** What a tool is given at execution time, beyond its own validated input. */
export interface Ctx {
  readonly host: string;
  readonly sessionId: string;
  /** Runs a command on the host through the policy-checked transport. */
  run(command: RemoteCommand): Promise<RawResult>;
}

/**
 * A tool definition: schema, risk, how to build the commands, how to read the
 * output, and — for anything that mutates — how to snapshot, verify and undo.
 *
 * `description` is written for the model: when to use it, what it returns, what
 * to check next.
 */
export interface ToolDef<I, O> {
  readonly name: string;
  readonly description: string;
  readonly risk: Risk;
  /** Always includes `host`. */
  readonly input: z.ZodType<I>;
  build(input: I): readonly RemoteCommand[];
  parse(raw: readonly RawResult[]): O;
  /** Required for reversible and config tools. */
  snapshot?(input: I): SnapshotSpec;
  /** Required for reversible and config tools. Failure triggers rollback. */
  verify?(input: I, ctx: Ctx): Promise<VerifyResult>;
  /** Required for reversible and config tools. */
  rollback?(snapshot: SnapshotRef): readonly RemoteCommand[];
  /** Output cap for this tool, if it differs from the transport default. */
  readonly maxOutputBytes?: number;
}

/**
 * What the MCP layer returns.
 *
 * Server output is untrusted data, so it is carried in `data` under an envelope
 * rather than spliced into prose the model might read as instructions.
 */
export interface ToolResult<O> {
  readonly ok: boolean;
  readonly tool: string;
  readonly host: string;
  readonly decision: Decision;
  readonly data?: O;
  readonly error?: ReturnType<DwaraError['toJSON']>;
  readonly truncated?: boolean;
  readonly verify?: VerifyResult;
  readonly snapshot?: SnapshotRef;
  readonly durationMs: number;
}
