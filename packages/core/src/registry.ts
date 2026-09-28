import type { z } from 'zod';
import { DwaraError } from './errors.js';
import {
  Risk,
  type Ctx,
  type RawResult,
  type RemoteCommand,
  type SnapshotRef,
  type SnapshotSpec,
  type ToolDef,
  type VerifyResult,
} from './types.js';

/** Arguments that failed their schema, with the reasons. */
export interface ValidationFailure {
  readonly ok: false;
  readonly problems: readonly string[];
}

export type ValidationResult = { readonly ok: true; readonly value: unknown } | ValidationFailure;

/**
 * A registered tool with its generic types erased.
 *
 * The registry is heterogeneous — it holds tools whose inputs and outputs have
 * nothing in common — but `ToolDef<I, O>` is invariant in `I`, because a zod
 * schema both produces and consumes its type. So `ToolDef<unknown, unknown>`
 * accepts nothing, and the usual escape is `any`, which `CLAUDE.md` forbids.
 *
 * Erasing behind this interface instead keeps the type safety where it belongs:
 * `register()` is generic and typed against the real `ToolDef`, and the closures
 * it builds are the only place the concrete types are needed.
 */
export interface RegisteredTool {
  readonly name: string;
  /** Risk-prefixed name, as a client sees it. */
  readonly mcpName: string;
  readonly description: string;
  readonly risk: Risk;
  readonly maxOutputBytes: number | undefined;
  /** The zod schema, for the MCP layer to advertise. */
  readonly inputSchema: z.ZodType;
  /** True for a tool that changes remote state. */
  readonly mutates: boolean;

  validate(args: unknown): ValidationResult;
  /** Undefined for a tool that sequences its own commands through `apply`. */
  build(input: unknown): readonly RemoteCommand[] | undefined;
  /** Undefined for a tool whose commands are all known from the input. */
  apply(input: unknown, ctx: Ctx): Promise<readonly RawResult[]> | undefined;
  parse(raws: readonly RawResult[]): unknown;
  snapshot(input: unknown): SnapshotSpec | undefined;
  verify(input: unknown, ctx: Ctx): Promise<VerifyResult> | undefined;
  rollback(snapshot: SnapshotRef): readonly RemoteCommand[] | undefined;
}

/**
 * The name a client sees, prefixed by risk class.
 *
 * `read_tail_logs`, `reversible_restart_service`, `config_edit_config`. The
 * prefix lets a permission rule in the client match on it — Claude Code can
 * allow `read_*` and prompt for everything else without knowing which tools
 * exist. That only holds if the prefix is derived from the declared risk rather
 * than typed by hand, which is why this is a function.
 */
export function mcpName(tool: { risk: Risk; name: string }): string {
  return `${tool.risk}_${tool.name}`;
}

/** Erases a tool's types behind the uniform runtime interface. */
function erase<I, O>(tool: ToolDef<I, O>): RegisteredTool {
  return {
    name: tool.name,
    mcpName: mcpName(tool),
    description: tool.description,
    risk: tool.risk,
    maxOutputBytes: tool.maxOutputBytes,
    inputSchema: tool.input,
    mutates: tool.risk === Risk.Reversible || tool.risk === Risk.Config,

    validate(args) {
      const parsed = tool.input.safeParse(args);
      if (parsed.success) return { ok: true, value: parsed.data };

      return {
        ok: false,
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
        ),
      };
    },

    // Every caller reaches these through `validate` first, so the value really
    // is an I. The assertion is confined to this function rather than spread
    // across the registry and the pipeline.
    build: (input) => tool.build?.(input as I),
    apply: (input, ctx) => tool.apply?.(input as I, ctx),
    parse: (raws) => tool.parse(raws),
    snapshot: (input) => tool.snapshot?.(input as I),
    verify: (input, ctx) => tool.verify?.(input as I, ctx),
    rollback: (snapshot) => tool.rollback?.(snapshot),
  };
}

/**
 * The tools Dwara knows about.
 *
 * Registration is the only way a tool becomes callable, and the pipeline looks
 * tools up here rather than accepting a definition from its caller. A tool that
 * is not registered does not exist, whatever the model asks for.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, RegisteredTool>();

  /**
   * Adds a tool.
   *
   * @throws DwaraError `INTERNAL` on a duplicate name, or on a mutating tool
   *   missing the safety machinery its risk class requires.
   */
  register<I, O>(tool: ToolDef<I, O>): this {
    if (this.byName.has(tool.name)) {
      throw new DwaraError('INTERNAL', `tool "${tool.name}" is already registered`);
    }

    // Exactly one execution path. `build` is the pure one, for commands known
    // from the input alone; `apply` is the staged one, for a later command that
    // depends on an earlier one's output. A tool defining both would have two
    // answers to "what does this run?", and the plan a human approves has to be
    // the thing that actually runs.
    const paths = (['build', 'apply'] as const).filter((hook) => typeof tool[hook] === 'function');
    if (paths.length !== 1) {
      throw new DwaraError(
        'INTERNAL',
        paths.length === 0
          ? `tool "${tool.name}" defines neither build nor apply; it must define exactly one`
          : `tool "${tool.name}" defines both build and apply; it must define exactly one`,
        { details: { tool: tool.name, defines: [...paths] } },
      );
    }

    // CLAUDE.md rule 3: every mutating tool defines snapshot, verify and
    // rollback. Checked here rather than trusted, so a tool that cannot be
    // undone never becomes callable in the first place.
    if (tool.risk === Risk.Reversible || tool.risk === Risk.Config) {
      const missing = (['snapshot', 'verify', 'rollback'] as const).filter(
        (hook) => typeof tool[hook] !== 'function',
      );
      if (missing.length > 0) {
        throw new DwaraError(
          'INTERNAL',
          `tool "${tool.name}" has risk ${tool.risk} but defines no ${missing.join(', ')}`,
          { details: { tool: tool.name, risk: tool.risk, missing: [...missing] } },
        );
      }
    }

    this.byName.set(tool.name, erase(tool));
    return this;
  }

  /**
   * Looks a tool up by either its bare name or its risk-prefixed one.
   *
   * Both work because the MCP layer speaks prefixed names while policy files,
   * audit filters and humans use the bare one.
   */
  get(name: string): RegisteredTool | undefined {
    const direct = this.byName.get(name);
    if (direct) return direct;

    for (const tool of this.byName.values()) {
      if (tool.mcpName === name) return tool;
    }
    return undefined;
  }

  /** Every registered tool, in registration order. */
  list(): readonly RegisteredTool[] {
    return [...this.byName.values()];
  }

  /** Tools of one risk class. */
  byRisk(risk: Risk): readonly RegisteredTool[] {
    return this.list().filter((tool) => tool.risk === risk);
  }

  get size(): number {
    return this.byName.size;
  }
}
