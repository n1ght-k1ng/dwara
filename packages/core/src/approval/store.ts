import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalise } from '../audit/entry.js';
import { DwaraError } from '../errors.js';

/**
 * Approvals, and the requests that ask for them.
 *
 * The rule this file exists to enforce is `CLAUDE.md` rule 5: **the agent can
 * never approve its own action.** Nothing here creates an approval — that lives
 * in `grant.ts`, which only the CLI imports. This module can find one, check it
 * and spend it, and that is all.
 *
 * The deeper guarantee is not this split, though, it is the shape of `Ctx`: a
 * tool is handed exactly one capability, `run(command)`, which reaches a remote
 * host. No tool can write a local file at all, so no tool can write an
 * approval, whatever it imports. The split is defence in depth on top of that.
 *
 * **Binding.** An approval is bound to a plan hash — the tool, the host and the
 * exact arguments. Approving "restart nginx on lab-api" does not approve
 * restarting anything else, on any other host, and an agent that changes one
 * character of the arguments after asking gets a different hash and is refused.
 */

/** Requests and approvals live beside the audit log. */
export const DEFAULT_APPROVAL_DIR = '.dwara';

/** Fifteen minutes. Long enough to read a diff, short enough to not linger. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

const ID = /^apr_[0-9a-f]{8}$/;

export const approvalRequestSchema = z
  .object({
    id: z.string().regex(ID),
    /** SHA-256 over the tool, host and arguments. */
    plan_hash: z.string().length(64),
    tool: z.string(),
    host: z.string(),
    risk: z.string(),
    /** Redacted arguments, so the human can see what they are approving. */
    input: z.record(z.string(), z.unknown()).default({}),
    /** Why policy stopped it, in the policy's own words. */
    reason: z.string().default(''),
    created_at: z.string(),
  })
  .strict();

export type ApprovalRequest = z.output<typeof approvalRequestSchema>;

export const approvalSchema = z
  .object({
    id: z.string().regex(ID),
    plan_hash: z.string().length(64),
    tool: z.string(),
    host: z.string(),
    approved_at: z.string(),
    expires_at: z.string(),
    /** Who granted it. `cli` is the only issuer today. */
    approved_by: z.string(),
    /** Set the moment it is spent. An approval is good for one action. */
    used_at: z.string().optional(),
  })
  .strict();

export type Approval = z.output<typeof approvalSchema>;

/** A fresh, well-formed request id. */
export function newRequestId(): string {
  return `apr_${randomBytes(4).toString('hex')}`;
}

/** True for a string that may be used as a request id. */
export function isRequestId(value: string): boolean {
  return ID.test(value);
}

/**
 * The hash an approval is bound to.
 *
 * Covers the tool, the host and every argument. Two calls hash the same only if
 * they would do the same thing, which is what makes "approve this, not that"
 * meaningful — and what makes an agent that edits its arguments after asking
 * fail rather than slip through.
 */
export function planHash(plan: {
  tool: string;
  host: string;
  input: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(canonicalise({ tool: plan.tool, host: plan.host, input: plan.input }), 'utf8')
    .digest('hex');
}

/** What the pipeline needs of an approval store. */
export interface ApprovalStore {
  /** An unused, unexpired approval bound to this plan, if one exists. */
  find(planHash: string): Promise<Approval | undefined>;
  /** Marks an approval spent. An approval is good for exactly one action. */
  consume(id: string): Promise<void>;
  /** Records what was asked for, so a human can read it before deciding. */
  record(request: ApprovalRequest): Promise<void>;
}

/**
 * Approvals on disk, under `.dwara/approvals/` and `.dwara/pending/`.
 *
 * Note which direction each method goes. `record` writes a *request*, which is
 * not permission for anything; `find` and `consume` read and spend approvals
 * that something else created. There is no method here that grants one.
 */
export class FileApprovalStore implements ApprovalStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(options: { dir?: string; now?: () => Date } = {}) {
    this.dir = options.dir ?? DEFAULT_APPROVAL_DIR;
    this.now = options.now ?? ((): Date => new Date());
  }

  get approvalsDir(): string {
    return join(this.dir, 'approvals');
  }

  get pendingDir(): string {
    return join(this.dir, 'pending');
  }

  async find(hash: string): Promise<Approval | undefined> {
    const now = this.now().getTime();

    for (const approval of await this.all()) {
      if (approval.plan_hash !== hash) continue;
      // Both checks matter and for different reasons: `used_at` stops one
      // approval authorising a second identical action, and `expires_at` stops
      // an approval granted this morning being spent this evening.
      if (approval.used_at !== undefined) continue;
      if (Date.parse(approval.expires_at) <= now) continue;
      return approval;
    }

    return undefined;
  }

  async consume(id: string): Promise<void> {
    const approval = await this.read(id);
    if (approval === undefined) {
      throw new DwaraError('INTERNAL', `no approval "${id}" to spend`);
    }

    await this.write({ ...approval, used_at: this.now().toISOString() });
  }

  async record(request: ApprovalRequest): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true });
    await writeFile(
      join(this.pendingDir, `${request.id}.json`),
      `${JSON.stringify(request, null, 2)}\n`,
      'utf8',
    );
  }

  /** A pending request by id, for the CLI to show before it decides. */
  async readRequest(id: string): Promise<ApprovalRequest | undefined> {
    if (!isRequestId(id)) return undefined;

    try {
      const raw: unknown = JSON.parse(await readFile(join(this.pendingDir, `${id}.json`), 'utf8'));
      const parsed = approvalRequestSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every pending request, newest first. */
  async pending(): Promise<readonly ApprovalRequest[]> {
    let names: string[];
    try {
      names = await readdir(this.pendingDir);
    } catch {
      return [];
    }

    const found: ApprovalRequest[] = [];
    for (const name of names) {
      const request = await this.readRequest(name.replace(/\.json$/, ''));
      if (request !== undefined) found.push(request);
    }

    return found.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /** An approval by id, spent or not. */
  async read(id: string): Promise<Approval | undefined> {
    if (!isRequestId(id)) return undefined;

    try {
      const raw: unknown = JSON.parse(
        await readFile(join(this.approvalsDir, `${id}.json`), 'utf8'),
      );
      const parsed = approvalSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every approval on disk, valid or otherwise. */
  async all(): Promise<readonly Approval[]> {
    let names: string[];
    try {
      names = await readdir(this.approvalsDir);
    } catch {
      return [];
    }

    const found: Approval[] = [];
    for (const name of names) {
      const approval = await this.read(name.replace(/\.json$/, ''));
      if (approval !== undefined) found.push(approval);
    }

    return found;
  }

  /**
   * Writes an approval file.
   *
   * Internal on purpose, and not part of `ApprovalStore`. Granting goes through
   * `grant.ts`, which the MCP server and the tools do not import.
   *
   * @internal
   */
  async write(approval: Approval): Promise<void> {
    await mkdir(this.approvalsDir, { recursive: true });
    await writeFile(
      join(this.approvalsDir, `${approval.id}.json`),
      `${JSON.stringify(approval, null, 2)}\n`,
      'utf8',
    );
  }
}
