import type { Ctx, RawResult, RemoteCommand } from '../types.js';
import { SNAPSHOT_ROOT, isSnapshotId } from './manager.js';

/**
 * Keeping the snapshot store from growing without bound.
 *
 * Deletion is the one genuinely dangerous verb in Dwara, so it is expressed in
 * a form that cannot be aimed anywhere else. Every delete goes through:
 *
 * ```
 * find /var/lib/dwara/snapshots -mindepth 1 -maxdepth 1 -type d -name <id> -exec rm -rf {} +
 * ```
 *
 * `-name` matches a **basename**, never a path, so a name containing `..` or a
 * separator matches nothing at all — verified on a lab host, where
 * `-name "../../etc"` deleted nothing and exited zero. That matters because the
 * IDs come back from `find` on the host, which is untrusted data like any other
 * command output, and because sudoers wildcards do not help: `*` in a sudoers
 * rule matches `/` too, so an `rm -rf /var/lib/dwara/snapshots/*` grant would
 * have permitted `.../snapshots/../../..`. Dwara never asks for such a grant.
 */

/** Defaults from DESIGN section 10. */
export const KEEP_PER_HOST = 20;
export const MAX_AGE_DAYS = 7;

const RETENTION_TIMEOUT_MS = 30_000;

/** One snapshot directory on a host, newest first when listed. */
export interface StoredSnapshot {
  readonly id: string;
  /** Directory mtime, epoch seconds. */
  readonly modifiedAt: number;
}

export interface RetentionOptions {
  readonly keep?: number;
  readonly maxAgeDays?: number;
}

/** What a prune removed. */
export interface PruneResult {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

/**
 * Every snapshot on the host, newest first.
 *
 * Directories whose names are not well-formed snapshot IDs are skipped rather
 * than reported: something else put them there, and Dwara does not delete what
 * it did not create.
 */
export async function listSnapshots(ctx: Ctx): Promise<readonly StoredSnapshot[]> {
  const result = await ctx.run(
    root([
      'find',
      SNAPSHOT_ROOT,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-type',
      'd',
      '-printf',
      '%T@ %f\n',
    ]),
  );

  const found: StoredSnapshot[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+(?:\.\d+)?) (.+)$/.exec(line);
    const id = match?.[2];
    if (id === undefined || !isSnapshotId(id)) continue;
    found.push({ id, modifiedAt: Number(match?.[1]) });
  }

  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Applies the retention policy: keep the newest `keep`, drop anything older
 * than `maxAgeDays`.
 *
 * Age is applied by `find -mtime` in a single command with no wildcard at all;
 * the count limit is applied per ID, each through the `-name` form above.
 */
export async function pruneSnapshots(
  ctx: Ctx,
  options: RetentionOptions = {},
): Promise<PruneResult> {
  const keep = options.keep ?? KEEP_PER_HOST;
  const maxAgeDays = options.maxAgeDays ?? MAX_AGE_DAYS;

  // Integers from Dwara's own configuration, but stringified into argv, so they
  // are checked rather than trusted.
  if (!Number.isInteger(keep) || keep < 0 || !Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    return { removed: [], kept: [] };
  }

  await ctx.run(
    root([
      'find',
      SNAPSHOT_ROOT,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-type',
      'd',
      '-mtime',
      `+${maxAgeDays}`,
      '-exec',
      'rm',
      '-rf',
      '{}',
      '+',
    ]),
  );

  const remaining = await listSnapshots(ctx);
  const excess = remaining.slice(keep);

  for (const snapshot of excess) {
    await ctx.run(removeCommand(snapshot.id));
  }

  return {
    removed: excess.map((snapshot) => snapshot.id),
    kept: remaining.slice(0, keep).map((snapshot) => snapshot.id),
  };
}

/** Removes one snapshot by ID. Safe for any string: see the module comment. */
export async function removeSnapshot(ctx: Ctx, id: string): Promise<RawResult> {
  return ctx.run(removeCommand(id));
}

function removeCommand(id: string): RemoteCommand {
  return root([
    'find',
    SNAPSHOT_ROOT,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-type',
    'd',
    '-name',
    id,
    '-exec',
    'rm',
    '-rf',
    '{}',
    '+',
  ]);
}

function root(argv: readonly string[]): RemoteCommand {
  return { argv, sudo: true, timeoutMs: RETENTION_TIMEOUT_MS };
}
