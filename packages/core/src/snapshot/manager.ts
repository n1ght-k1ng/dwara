import { randomBytes } from 'node:crypto';
import { DwaraError } from '../errors.js';
import { lexicalPathProblem, normalisePath, pathIsDenied } from '../paths.js';
import type {
  Ctx,
  RawResult,
  RemoteCommand,
  SnapshotRef,
  SnapshotSpec,
  UnitState,
} from '../types.js';

/**
 * Server-side backups taken before a change, and the restore that undoes it.
 *
 * Two things make this more than a `cp`:
 *
 * 1. **A snapshot proves itself.** After copying, the copies are hashed and
 *    compared against the originals. A snapshot that silently copied nothing is
 *    worse than no snapshot, because the pipeline would go on to make a change
 *    believing it could be undone.
 * 2. **A restore is checked, not assumed.** `SnapshotRef.hashes` records what
 *    each file contained, and `restoreSnapshot` re-hashes afterwards. "Rollback
 *    restores exact file hashes" is a PLAN.md test, and it is only testable
 *    because the hashes are captured up front.
 */

/** Where snapshots live on every managed host. */
export const SNAPSHOT_ROOT = '/var/lib/dwara/snapshots';

/**
 * The only shape a snapshot ID may take.
 *
 * Narrow on purpose: an ID reaches argv, and IDs read back off a host are
 * untrusted data like any other command output. A name matching this cannot
 * contain a separator, a dot or a shell metacharacter, so it cannot become a
 * path outside `SNAPSHOT_ROOT` however it is concatenated.
 */
const SNAPSHOT_ID = /^snap_[0-9a-f]{8}$/;

const SNAPSHOT_TIMEOUT_MS = 30_000;

/** How the `stat` fields are packed, so one command answers mode and owner. */
const STAT_FORMAT = '%n|%a|%U|%G';

/** Unit properties captured before a change. `Id` is what correlates the blocks. */
const UNIT_PROPERTIES = 'Id,ActiveState,UnitFileState,NRestarts';

/** A fresh, well-formed snapshot ID. */
export function newSnapshotId(): string {
  return `snap_${randomBytes(4).toString('hex')}`;
}

/**
 * The absolute directory for a snapshot.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` when the ID is not well formed.
 */
export function snapshotDir(id: string): string {
  if (!SNAPSHOT_ID.test(id)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `"${id}" is not a snapshot id`, {
      details: { id, expected: SNAPSHOT_ID.source },
    });
  }
  return `${SNAPSHOT_ROOT}/${id}`;
}

/** True for a name that may be used as a snapshot ID. */
export function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID.test(value);
}

/** Where a snapshot keeps its copy of an absolute path. */
export function copyOf(dir: string, path: string): string {
  return `${dir}/files${path}`;
}

/**
 * Checks a path a tool wants snapshotted.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` for a relative path, a traversal, a
 *   control character, or anything on the permanent deny-list.
 */
export function guardSnapshotPath(requested: string): string {
  const problem = lexicalPathProblem(requested);
  if (problem !== undefined) {
    throw new DwaraError('UNSAFE_ARGUMENT', `cannot snapshot "${requested}": ${problem}`, {
      details: { path: requested },
    });
  }

  const path = normalisePath(requested);
  if (pathIsDenied(path)) {
    throw new DwaraError(
      'UNSAFE_ARGUMENT',
      `cannot snapshot "${path}": it is on Dwara's permanent deny-list`,
      {
        details: { path },
        hint: 'a snapshot leaves a root-owned copy behind, so the deny-list applies to it too',
      },
    );
  }

  return path;
}

/** What a restore put back, and what it could not. */
export interface RestoreResult {
  readonly ok: boolean;
  /** Paths whose contents now hash to what the snapshot recorded. */
  readonly restored: readonly string[];
  /** Paths that came back different, or not at all. */
  readonly mismatched: readonly string[];
  readonly detail: string;
}

/**
 * Copies a spec's files and unit states to the host's snapshot store.
 *
 * Absent paths are not an error — `edit_config` may be creating a file that
 * does not exist yet — but they are left out of the returned `paths`, so a
 * restore never tries to put back something that was never there.
 *
 * @throws DwaraError `SNAPSHOT_FAILED` when the store cannot be written, or
 *   when a copy does not hash to the same bytes as its original.
 * @throws DwaraError `UNSAFE_ARGUMENT` for a path a tool should not have asked for.
 */
export async function createSnapshot(spec: SnapshotSpec, ctx: Ctx): Promise<SnapshotRef> {
  const paths = spec.paths.map(guardSnapshotPath);
  const units = spec.units ?? [];
  const id = newSnapshotId();
  const dir = snapshotDir(id);
  const createdAt = new Date().toISOString();

  // `stat` exits non-zero when any path is missing but still reports the ones
  // that exist, so presence is read from stdout rather than from the exit code.
  const modes =
    paths.length === 0
      ? {}
      : parseStat(await ctx.run(sudo(['stat', '-c', STAT_FORMAT, '--', ...paths])));
  const present = paths.filter((path) => modes[path] !== undefined);

  const hashes =
    present.length === 0 ? {} : parseSums(await ctx.run(sudo(['sha256sum', '--', ...present])));

  await must(
    ctx,
    sudo(['mkdir', '-p', '--', `${dir}/files`]),
    'could not create the snapshot directory',
  );

  if (present.length > 0) {
    // One `cp` per file, not one for all of them. A batched copy takes a
    // variable number of source arguments, and a sudoers rule cannot then pin
    // the destination — the lab would have to grant `cp --parents -- *`, which
    // is a grant to copy anything anywhere as root. One source at a time lets
    // the rule fix the destination inside the snapshot store, and it says which
    // file failed when one does.
    //
    // `--parents` mirrors each absolute path under the destination, so
    // /etc/nginx/nginx.conf lands at <dir>/files/etc/nginx/nginx.conf and two
    // files with the same basename cannot collide.
    for (const path of present) {
      await must(
        ctx,
        sudo(['cp', '--preserve=all', '--parents', '--', path, `${dir}/files`]),
        `could not copy ${path} into the snapshot`,
      );
    }

    // The step that makes this a snapshot rather than a hope.
    const copies = present.map((path) => copyOf(dir, path));
    const copied = parseSums(await ctx.run(sudo(['sha256sum', '--', ...copies])));
    const bad = present.filter((path) => copied[copyOf(dir, path)] !== hashes[path]);

    if (bad.length > 0) {
      throw new DwaraError(
        'SNAPSHOT_FAILED',
        `snapshot ${id} did not copy ${bad.length} file(s) faithfully; refusing to change anything`,
        { details: { snapshot: id, host: ctx.host, paths: bad } },
      );
    }
  }

  const unitStates =
    units.length === 0
      ? undefined
      : parseUnits(
          await ctx.run(
            sudo(['systemctl', 'show', ...units, '--no-pager', `--property=${UNIT_PROPERTIES}`]),
          ),
        );

  const ref: SnapshotRef = {
    id,
    host: ctx.host,
    createdAt,
    paths: present,
    hashes,
    ...(unitStates === undefined ? {} : { units: unitStates }),
  };

  // Written last, so a directory with a meta.json is a snapshot that completed.
  // `dwara rollback` reads this, which is what lets a restore happen from the
  // CLI with no agent and no local state.
  await must(
    ctx,
    {
      ...sudo(['tee', '--', `${dir}/meta.json`]),
      stdin: JSON.stringify({ ...ref, modes, absent: paths.filter((p) => !present.includes(p)) }),
    },
    'could not write the snapshot metadata',
  );

  return ref;
}

/**
 * Puts a snapshot's files back, then proves it.
 *
 * Never throws for a failed restore: the caller is usually already handling a
 * failed change, and it needs both outcomes in one result rather than a second
 * exception hiding the first.
 */
export async function restoreSnapshot(ref: SnapshotRef, ctx: Ctx): Promise<RestoreResult> {
  const dir = snapshotDir(ref.id);

  if (ref.paths.length === 0) {
    return { ok: true, restored: [], mismatched: [], detail: 'snapshot held no files' };
  }

  const failures: string[] = [];
  for (const path of ref.paths) {
    const result = await ctx.run(sudo(['cp', '--preserve=all', '--', copyOf(dir, path), path]));
    if (result.exitCode !== 0) failures.push(path);
  }

  // The proof. A `cp` that exited zero and wrote different bytes — a full disk
  // truncating the write is the realistic case — is still a failed restore.
  const after = parseSums(await ctx.run(sudo(['sha256sum', '--', ...ref.paths])));
  const mismatched = ref.paths.filter((path) => after[path] !== ref.hashes[path]);
  const ok = mismatched.length === 0;

  return {
    ok,
    restored: ref.paths.filter((path) => !mismatched.includes(path)),
    mismatched,
    detail: ok
      ? `restored ${ref.paths.length} file(s); every hash matches the snapshot`
      : `${mismatched.length} of ${ref.paths.length} file(s) do not match the snapshot: ${mismatched.join(', ')}`,
  };
}

/** Every command a snapshot issues needs root, and none of them may prompt. */
function sudo(argv: readonly string[]): RemoteCommand {
  return { argv, sudo: true, timeoutMs: SNAPSHOT_TIMEOUT_MS };
}

/** Runs a command that has to succeed, or fails the whole snapshot. */
async function must(ctx: Ctx, command: RemoteCommand, what: string): Promise<RawResult> {
  const result = await ctx.run(command);
  if (result.exitCode !== 0) {
    throw new DwaraError('SNAPSHOT_FAILED', `${what}: ${firstLine(result)}`, {
      details: { host: ctx.host, argv: [...command.argv], exitCode: result.exitCode },
    });
  }
  return result;
}

function firstLine(result: RawResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return (text.split('\n')[0] ?? `exited ${result.exitCode}`).slice(0, 200);
}

/** `<path>|<mode>|<owner>|<group>` per line, for the paths that exist. */
function parseStat(result: RawResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 4 || parts[0] === undefined || parts[0] === '') continue;
    out[parts[0]] = parts.slice(1).join('|');
  }
  return out;
}

/** `<sha256>  <path>` per line, as `sha256sum` prints it. */
function parseSums(result: RawResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[2]] = match[1];
  }
  return out;
}

/**
 * One `key=value` block per unit, blank-line separated.
 *
 * Keyed by `Id` rather than by position, because `systemctl show` does not
 * return the properties in the order they were asked for — a real host answers
 * `NRestarts` first whatever the `--property` order says.
 */
function parseUnits(result: RawResult): Record<string, UnitState> {
  const out: Record<string, UnitState> = {};

  for (const block of result.stdout.split(/\n\s*\n/)) {
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
    }

    const id = fields['Id'];
    if (id === undefined || id === '') continue;

    const restarts = Number(fields['NRestarts']);
    out[id] = {
      activeState: fields['ActiveState'] ?? 'unknown',
      unitFileState: fields['UnitFileState'] ?? 'unknown',
      restarts: Number.isFinite(restarts) ? restarts : undefined,
    };
  }

  return out;
}
