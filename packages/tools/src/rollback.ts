import { z } from 'zod';
import {
  DwaraError,
  Risk,
  confirmRestored,
  isSnapshotId,
  policyHttpChecks,
  readSnapshot,
  restoreSnapshot,
  runChecks,
  type RawResult,
  type StagedToolDef,
} from '@dwara/core';
import { at, hostField } from './common.js';

/**
 * Putting a host back to a snapshot, deliberately.
 *
 * The pipeline already rolls back automatically when a change fails to verify.
 * This is for the other case: a change that verified, and turned out hours
 * later to be the wrong change. The snapshot describes itself on the host, so
 * this needs no local state and works from a different machine entirely — the
 * same reason `dwara rollback` exists as a command.
 *
 * `restorable: false`, which reads oddly for a tool whose whole job is
 * restoring. It is accurate: if this restore does not verify, there is nothing
 * further to undo, and the honest thing is to say the host is not as it was and
 * a person should look. Undoing an undo is not something Dwara does.
 */

const input = z
  .object({
    host: hostField,
    snapshot: z
      .string()
      .min(1)
      .describe('Snapshot id, as a previous result or the audit log reported it.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface RollbackResult {
  readonly snapshot: string;
  readonly takenAt: string;
  readonly restored: readonly string[];
  readonly mismatched: readonly string[];
  /** Whether units and containers came back as the snapshot recorded them. */
  readonly stateConfirmed: boolean;
  readonly detail: string;
  readonly assessment: string;
}

export interface RollbackOptions {
  readonly verifyTimeoutMs?: number;
}

export function createRollback(
  options: RollbackOptions = {},
): StagedToolDef<Input, RollbackResult> {
  return {
    name: 'rollback',
    risk: Risk.Config,
    description: [
      'Restores a host to a snapshot Dwara took before an earlier change, and proves',
      'it by comparing every file against the hash recorded at the time.',
      '',
      'You do not need this for a change that failed — those are undone automatically',
      'and the result says so. Use it when a change verified at the time and turned',
      'out to be wrong afterwards.',
      '',
      'Pass the snapshot id from the earlier result, or from the audit log. Snapshots',
      'are kept for seven days or the last twenty per host, whichever comes first.',
      '',
      'Restoring files is not always the whole job: a config file that is back on disk',
      'does nothing until its service re-reads it. Check the service afterwards, and',
      'reload or restart it if the result says the state was not confirmed.',
      '',
      'If this restore does not verify there is nothing further to undo, and the',
      'result will say the host needs a person.',
    ].join('\n'),
    input,

    // Nothing to snapshot: the state being restored is already recorded, and
    // taking another copy of a host mid-recovery helps nobody.
    restorable: false,
    snapshot: () => ({ paths: [] }),

    async apply(params, ctx) {
      if (!isSnapshotId(params.snapshot)) {
        throw new DwaraError('UNSAFE_ARGUMENT', `"${params.snapshot}" is not a snapshot id`, {
          details: { snapshot: params.snapshot },
          hint: 'ids look like snap_0a1b2c3d, and appear in earlier results and the audit log',
        });
      }

      // Read on the host, from the snapshot's own metadata. Staged execution
      // is what makes this possible at all: the paths to restore are not known
      // until the first command has answered.
      const ref = await readSnapshot(params.snapshot, ctx);
      const restore = await restoreSnapshot(ref, ctx);
      const state = await confirmRestored(ref, ctx);

      return [carry({ ...ref, restore, state })];
    },

    parse: (raws) => {
      const payload = JSON.parse(at(raws, 0).stdout) as {
        id: string;
        createdAt: string;
        restore: { ok: boolean; restored: string[]; mismatched: string[]; detail: string };
        state: { ok: boolean; detail: string };
      };

      const ok = payload.restore.ok && payload.state.ok;

      return {
        snapshot: payload.id,
        takenAt: payload.createdAt,
        restored: payload.restore.restored,
        mismatched: payload.restore.mismatched,
        stateConfirmed: payload.state.ok,
        detail: [payload.restore.detail, payload.state.detail].filter(Boolean).join('; '),
        assessment: ok
          ? `restored ${payload.restore.restored.length} file(s); every hash matches what was recorded`
          : payload.restore.mismatched.length > 0
            ? `${payload.restore.mismatched.length} file(s) did not come back as recorded; this host needs a person`
            : 'the files are back but the services are not; reload or restart them and check again',
      };
    },

    verify: (_params, ctx) =>
      runChecks(policyHttpChecks(ctx), ctx, {
        ...(options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs }),
      }),

    // Already the undo. There is no further step.
    rollback: () => [],
  };
}

/** The registered instance. */
export const rollback = createRollback();

/** Carries a computed value into `parse` without a round trip to the host. */
function carry(value: unknown): RawResult {
  return {
    argv: [],
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    truncated: false,
    durationMs: 0,
  };
}
