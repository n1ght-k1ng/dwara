import { z } from 'zod';
import {
  DwaraError,
  Risk,
  filesystemHasHeadroom,
  policyHttpChecks,
  runChecks,
  type RemoteCommand,
  type StagedToolDef,
} from '@dwara/core';
import { DEFAULT_LOG_PATHS, guardPath } from './paths.js';
import { at, hostField, toNumber } from './common.js';

/**
 * Freeing space taken by logs.
 *
 * Two things about this tool are unlike the rest, and both follow from what it
 * is for.
 *
 * **It cannot be undone.** You cannot back up the thing you are deleting onto
 * the filesystem you are emptying, so the snapshot is a record of what went —
 * each path with the size it had — rather than a copy of it. `restorable` is
 * false, and the pipeline reports a failed verification without claiming the
 * host is back as it was.
 *
 * **It truncates rather than deletes.** `truncate -s 0` keeps the inode, so the
 * process holding the file open keeps writing to the same place and the space
 * comes back immediately. Deleting the file instead would leave the writer
 * appending to an unlinked inode: the bytes stay on disk until the process is
 * restarted, so `df` would not move and the outage would continue while every
 * indication said it had been fixed.
 *
 * `logrotate` is deliberately not used. It acts only on files it already has a
 * configuration for, and a file with a working logrotate rule is not usually
 * the one that filled the disk — the runaway writer nobody configured is.
 */

const input = z
  .object({
    host: hostField,
    paths: z
      .array(z.string().min(1))
      .default([])
      .describe('Absolute log files to truncate. Must be under /var/log.'),
    journal: z
      .boolean()
      .default(false)
      .describe('Also shrink the systemd journal to journalKeepMb.'),
    journalKeepMb: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .default(200)
      .describe('Size to shrink the journal to, in MB. Only used when journal is true.'),
  })
  .strict()
  .refine((value) => value.paths.length > 0 || value.journal, {
    message: 'give at least one path, or set journal to true',
  });

type Input = z.output<typeof input>;

/** One file, and what became of it. */
export interface RotatedFile {
  readonly path: string;
  readonly bytesBefore: number | undefined;
  readonly bytesAfter: number | undefined;
  readonly freedBytes: number | undefined;
  readonly error?: string;
}

export interface RotateLogsResult {
  readonly files: readonly RotatedFile[];
  readonly journalBefore?: string;
  readonly journalAfter?: string;
  /** Free space on the filesystem holding the first path, before and after. */
  readonly freePercentBefore: number | undefined;
  readonly freePercentAfter: number | undefined;
  readonly freedBytes: number;
  readonly assessment: string;
}

const READ_MS = 20_000;
const WRITE_MS = 60_000;

export interface RotateLogsOptions {
  readonly verifyTimeoutMs?: number;
  /** Free space the filesystem must have afterwards for this to count. */
  readonly minFreePercent?: number;
  /**
   * Deadline for one truncate.
   *
   * Overridden only by the timeout test. A transport-wide default cannot be
   * used for that, because every command Dwara builds sets its own `timeoutMs`
   * and the default is then never consulted.
   */
  readonly truncateTimeoutMs?: number;
}

export function createRotateLogs(
  options: RotateLogsOptions = {},
): StagedToolDef<Input, RotateLogsResult> {
  return {
    name: 'rotate_logs',
    risk: Risk.Reversible,
    description: [
      'Frees space taken by log files. Truncates the log files you name, and',
      'optionally shrinks the systemd journal, then checks the filesystem can be',
      'written to again.',
      '',
      'Use this when disk_usage shows a log filesystem full or nearly full and you',
      'have identified which files are responsible. Name those files; do not guess.',
      '',
      'It truncates rather than deletes, on purpose. The process writing the file',
      'keeps the same inode and carries on, and the space is returned immediately.',
      'Deleting the file instead would leave the writer appending to an unlinked',
      'inode — the space would not come back until that service restarted, while',
      'everything reported success.',
      '',
      'THIS CANNOT BE UNDONE. The contents are gone; only the sizes are recorded.',
      'You cannot back up a log onto the filesystem you are emptying. Read what you',
      'need with tail_logs before calling this, because afterwards it is not there.',
      '',
      'Only paths under /var/log are accepted. Freeing space is a stopgap: a log',
      'that filled a disk once will do it again, so say in your summary what was',
      'writing it and what would stop it recurring.',
    ].join('\n'),
    input,

    // Cannot be undone, and says so rather than offering an empty rollback that
    // the pipeline would report as a successful restore.
    restorable: false,

    // A record of what went, not a copy of it. `paths: []` because copying
    // these files is exactly the thing that is impossible here.
    snapshot: () => ({ paths: [] }),

    async apply(params, ctx) {
      const paths = params.paths.map(guardLogPath);
      const target = paths[0] ?? '/var/log';

      // Fixed positions whether or not each part applies, so `parse` can index
      // them without re-deriving what the caller asked for.
      const before = paths.length > 0 ? await ctx.run(sizes(paths)) : blank;
      const freeBefore = paths.length > 0 ? await ctx.run(free(target)) : blank;
      const journalBefore = params.journal
        ? await ctx.run({ argv: ['journalctl', '--disk-usage'], sudo: true, timeoutMs: READ_MS })
        : blank;

      // One truncate per file: the sudoers rule can then pin the directory, and
      // a failure names the file it happened to.
      const truncations: (typeof before)[] = [];
      for (const path of paths) {
        truncations.push(
          await ctx.run({
            argv: ['truncate', '-s', '0', '--', path],
            sudo: true,
            timeoutMs: options.truncateTimeoutMs ?? WRITE_MS,
          }),
        );
      }

      const vacuum = params.journal
        ? await ctx.run({
            argv: ['journalctl', `--vacuum-size=${params.journalKeepMb}M`],
            sudo: true,
            timeoutMs: WRITE_MS,
          })
        : blank;

      const after = paths.length > 0 ? await ctx.run(sizes(paths)) : blank;
      const freeAfter = paths.length > 0 ? await ctx.run(free(target)) : blank;
      const journalAfter = params.journal
        ? await ctx.run({ argv: ['journalctl', '--disk-usage'], sudo: true, timeoutMs: READ_MS })
        : blank;

      return [
        before,
        freeBefore,
        journalBefore,
        ...truncations,
        vacuum,
        after,
        freeAfter,
        journalAfter,
      ];
    },

    parse: (raws) => {
      // apply returns 7 fixed results plus one truncate per file.
      const count = raws.length - 7;
      const before = parseSizes(at(raws, 0).stdout);
      const freeBefore = parseFree(at(raws, 1).stdout);
      const journalBefore = at(raws, 2).stdout.trim();
      const truncations = raws.slice(3, 3 + count);
      const after = parseSizes(at(raws, 3 + count + 1).stdout);
      const freeAfter = parseFree(at(raws, 3 + count + 2).stdout);
      const journalAfter = at(raws, 3 + count + 3).stdout.trim();

      const files: RotatedFile[] = truncations.map((result) => {
        // argv is ['truncate', '-s', '0', '--', path].
        const path = result.argv[4] ?? '';
        const bytesBefore = before[path];
        const bytesAfter = after[path];
        const failed = result.exitCode !== 0;

        return {
          path,
          bytesBefore,
          bytesAfter,
          freedBytes:
            bytesBefore === undefined || bytesAfter === undefined
              ? undefined
              : Math.max(0, bytesBefore - bytesAfter),
          ...(failed
            ? {
                error: result.stderr.trim().split('\n')[0] || `truncate exited ${result.exitCode}`,
              }
            : {}),
        };
      });

      const freedBytes = files.reduce((total, file) => total + (file.freedBytes ?? 0), 0);

      return {
        files,
        ...(journalBefore === '' ? {} : { journalBefore }),
        ...(journalAfter === '' ? {} : { journalAfter }),
        freePercentBefore: freeBefore,
        freePercentAfter: freeAfter,
        freedBytes,
        assessment: assess(files, freedBytes, freeAfter),
      };
    },

    verify: (params, ctx) =>
      runChecks(
        [
          filesystemHasHeadroom(params.paths[0] ?? '/var/log', options.minFreePercent),
          // Services that were failing to write are the reason anyone cared.
          ...policyHttpChecks(ctx),
        ],
        ctx,
        options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs },
      ),

    // Nothing to give back. `restorable: false` is what the pipeline reads; this
    // is here because the registry requires every mutating tool to define it.
    rollback: () => [],
  };
}

/** The registered instance. */
export const rotateLogs = createRotateLogs();

const blank = {
  argv: [] as readonly string[],
  exitCode: 0,
  stdout: '',
  stderr: '',
  truncated: false,
  durationMs: 0,
};

function sizes(paths: readonly string[]): RemoteCommand {
  return {
    argv: ['stat', '-c', '%s|%n', '--', ...paths],
    sudo: true,
    timeoutMs: READ_MS,
  };
}

function free(path: string): RemoteCommand {
  return {
    argv: ['df', '--output=pcent', '--', path],
    sudo: true,
    timeoutMs: READ_MS,
  };
}

/**
 * @throws DwaraError `UNSAFE_ARGUMENT` for anything outside /var/log.
 */
function guardLogPath(requested: string): string {
  const guard = guardPath(requested, DEFAULT_LOG_PATHS);
  if (!guard.ok) {
    throw new DwaraError('UNSAFE_ARGUMENT', `cannot truncate that path: ${guard.reason}`, {
      details: { path: requested, allowed: [...DEFAULT_LOG_PATHS] },
      hint: 'rotate_logs only truncates files under /var/log',
    });
  }
  return guard.path;
}

/** `<size>|<path>` per line. Absent files simply do not appear. */
function parseSizes(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('|');
    if (index <= 0) continue;
    const bytes = toNumber(line.slice(0, index));
    if (bytes !== undefined) out[line.slice(index + 1)] = bytes;
  }
  return out;
}

/** Free percent from `df --output=pcent`, which prints a header then " 21%". */
function parseFree(stdout: string): number | undefined {
  const row = stdout.trim().split('\n')[1];
  const used = toNumber((row ?? '').trim().replace('%', ''));
  return used === undefined ? undefined : 100 - used;
}

function assess(
  files: readonly RotatedFile[],
  freedBytes: number,
  freePercentAfter: number | undefined,
): string {
  const failed = files.filter((file) => file.error !== undefined);
  if (failed.length > 0 && failed.length === files.length) {
    return `nothing was truncated: ${failed[0]?.error ?? 'every file failed'}`;
  }

  const mb = Math.round(freedBytes / 1024 / 1024);
  const room =
    freePercentAfter === undefined ? '' : `; the filesystem is now ${100 - freePercentAfter}% used`;

  if (freedBytes === 0) {
    return `nothing to free — the files named were already empty${room}`;
  }

  const partial = failed.length > 0 ? `, but ${failed.length} file(s) could not be truncated` : '';
  return `freed about ${mb} MB${partial}${room}`;
}
