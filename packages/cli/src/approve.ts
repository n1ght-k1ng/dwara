import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_APPROVAL_DIR,
  DEFAULT_TTL_MS,
  DwaraError,
  FileApprovalStore,
  grantApproval,
  type Approval,
  type ApprovalRequest,
} from '@dwara/core';

/**
 * `dwara approve <id>` — the only way an approval comes into existence.
 *
 * This runs in the developer's own terminal, not in the MCP server, and that
 * separation is the point. The agent can ask; a person answers. There is no
 * path from a tool call to this function.
 *
 * What it shows matters as much as what it writes. An approval bound to a plan
 * hash is worthless if the human granting it could not see what the plan was,
 * so the arguments are printed in full before the question is asked.
 */

export interface ApproveOptions {
  readonly dir?: string;
  readonly ttlMs?: number;
  /** Skips the prompt. For non-interactive use, and it says so in the output. */
  readonly yes?: boolean;
  /** Injected by tests. */
  confirm?(question: string): Promise<boolean>;
}

export interface ApproveResult {
  readonly ok: boolean;
  readonly text: string;
  readonly approval?: Approval;
}

/** Everything waiting on a human, oldest last. */
export async function listPending(dir = DEFAULT_APPROVAL_DIR): Promise<string> {
  const store = new FileApprovalStore({ dir });
  const pending = await store.pending();

  if (pending.length === 0) return 'Nothing is waiting for approval.';

  const lines = ['Waiting for approval:', ''];
  for (const request of pending) {
    const granted = await store.read(request.id);
    const state =
      granted === undefined
        ? 'needs you'
        : granted.used_at === undefined
          ? 'approved, not yet used'
          : 'already used';
    lines.push(`  ${request.id}  ${request.tool} on ${request.host}  (${state})`);
  }

  lines.push('', 'Run `dwara approve <id>` to see the full plan and decide.');
  return lines.join('\n');
}

/** The plan, written for a person deciding whether to allow it. */
export function formatRequest(request: ApprovalRequest): string {
  const args = Object.entries(request.input)
    .filter(([key]) => key !== 'host')
    .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`);

  return [
    '',
    `  Request:  ${request.id}`,
    `  Tool:     ${request.tool}`,
    `  Host:     ${request.host}`,
    `  Risk:     ${request.risk}`,
    `  Asked at: ${request.created_at}`,
    '',
    args.length > 0 ? '  Arguments:' : '  Arguments: none',
    ...args,
    '',
    `  Why it stopped: ${request.reason}`,
    '',
    // Said plainly, because it is the thing people get wrong about approvals.
    '  Approving authorises exactly this, once. Different arguments, a',
    '  different host or a second attempt all need asking again.',
    '',
  ].join('\n');
}

/**
 * Grants an approval for a pending request, after showing it to a human.
 *
 * @throws DwaraError `INTERNAL` when there is no such request.
 */
export async function approve(id: string, options: ApproveOptions = {}): Promise<ApproveResult> {
  const store = new FileApprovalStore({ dir: options.dir ?? DEFAULT_APPROVAL_DIR });
  const request = await store.readRequest(id);

  if (request === undefined) {
    throw new DwaraError('INTERNAL', `no request "${id}" is waiting for approval`, {
      details: { id },
      hint: 'run `dwara approve --list` to see what is pending',
    });
  }

  const plan = formatRequest(request);

  if (options.yes !== true) {
    const confirm = options.confirm ?? askTerminal;
    if (!(await confirm(`${plan}  Approve this? [y/N] `))) {
      return { ok: false, text: `${plan}\nNot approved. Nothing was granted.` };
    }
  }

  const approval = await grantApproval(store, request, {
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });

  const minutes = Math.round((options.ttlMs ?? DEFAULT_TTL_MS) / 60_000);

  return {
    ok: true,
    approval,
    text: [
      `Approved ${approval.id}: ${approval.tool} on ${approval.host}.`,
      `Valid for ${minutes} minute(s), for this one action. The agent can retry now.`,
    ].join('\n'),
  };
}

/** Asks on the terminal. Anything but an explicit yes is a no. */
async function askTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
