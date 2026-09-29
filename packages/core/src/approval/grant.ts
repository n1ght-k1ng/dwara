import { DwaraError } from '../errors.js';
import {
  DEFAULT_TTL_MS,
  type Approval,
  type ApprovalRequest,
  type FileApprovalStore,
} from './store.js';

/**
 * The only thing in Dwara that creates an approval.
 *
 * It lives alone in its own module so that "no MCP tool can grant an approval"
 * is something you can check by reading imports rather than by reasoning about
 * control flow. `packages/mcp-server` and `packages/tools` do not import this
 * file, and a test asserts they never start.
 *
 * That is the second line of defence. The first is that a tool is handed one
 * capability — `Ctx.run`, which reaches a remote host — and has no way to write
 * a local file at all, so it could not write an approval if it imported this.
 */

export interface GrantOptions {
  /** How long the approval is good for. Defaults to fifteen minutes. */
  readonly ttlMs?: number;
  /** Recorded in the approval and in the audit entry that spends it. */
  readonly approvedBy?: string;
  readonly now?: () => Date;
}

/**
 * Grants an approval for a pending request.
 *
 * The approval carries the request's own plan hash, so it authorises that
 * action and nothing else: a different host, a different tool, or one changed
 * argument all hash differently and will not match.
 *
 * @throws DwaraError `PLAN_MISMATCH` when the request has already been granted.
 */
export async function grantApproval(
  store: FileApprovalStore,
  request: ApprovalRequest,
  options: GrantOptions = {},
): Promise<Approval> {
  const now = (options.now ?? ((): Date => new Date()))();

  const existing = await store.read(request.id);
  if (existing !== undefined) {
    throw new DwaraError('PLAN_MISMATCH', `request ${request.id} has already been decided`, {
      details: { id: request.id, approvedAt: existing.approved_at },
      hint:
        existing.used_at === undefined
          ? 'it is still valid; the agent can retry now'
          : 'it has already been used; ask the agent to request again',
    });
  }

  const approval: Approval = {
    id: request.id,
    plan_hash: request.plan_hash,
    tool: request.tool,
    host: request.host,
    approved_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    approved_by: options.approvedBy ?? 'cli',
  };

  await store.write(approval);
  return approval;
}
