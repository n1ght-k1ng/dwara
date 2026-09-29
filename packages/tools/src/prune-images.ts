import { z } from 'zod';
import {
  DwaraError,
  Risk,
  filesystemHasHeadroom,
  runChecks,
  validatorCommand,
  type RemoteCommand,
  type StagedToolDef,
} from '@dwara/core';
import { at, hostField, jsonLines, toNumber } from './common.js';

/**
 * Reclaiming space taken by unused Docker images.
 *
 * **Dangling images only, never `-a`.** A dangling image is one no tag points
 * at and no container references; removing it cannot take a running service
 * with it. `docker image prune -a` removes every image not currently used by a
 * container, which includes the previous release you would roll back to and
 * every image a stopped container will need when it next starts. That is a
 * different and much larger action, and this tool cannot be made to perform
 * it — the `-a` flag is never built.
 *
 * The limit lives here rather than in the lab's sudoers, because it cannot live
 * there: the `dwara` user is in the `docker` group, so every docker command
 * already runs with the daemon's full authority and a sudoers rule would be
 * decoration. A grant that looks like a constraint and is none is worse than no
 * grant at all.
 *
 * Like `rotate_logs`, this cannot be undone: deleted layers are gone, so the
 * snapshot is the removal list rather than a copy.
 */

const input = z
  .object({
    host: hostField,
    olderThan: z
      .string()
      .regex(/^[0-9]+(h|m|s)$/, 'must be a duration such as "24h", "90m" or "3600s"')
      .optional()
      .describe('Only remove images created before this age, e.g. "168h" for a week.'),
  })
  .strict();

type Input = z.output<typeof input>;

/** One image that was dangling before the prune. */
export interface DanglingImage {
  readonly id: string;
  readonly size: string;
  readonly createdSince: string;
}

export interface PruneImagesResult {
  /** What was dangling when Dwara looked, whether or not it went. */
  readonly candidates: readonly DanglingImage[];
  /** Image ids Docker reported deleting. */
  readonly deleted: readonly string[];
  /** Docker's own words, e.g. "3.424kB". Often far less than the sizes suggest. */
  readonly reclaimed: string;
  readonly freePercentBefore: number | undefined;
  readonly freePercentAfter: number | undefined;
  readonly error?: string;
  readonly assessment: string;
}

const READ_MS = 20_000;
const PRUNE_MS = 120_000;

/** Where Docker keeps its layers, and so what pruning frees. */
const DOCKER_ROOT = '/var/lib/docker';

export interface PruneImagesOptions {
  readonly verifyTimeoutMs?: number;
  readonly minFreePercent?: number;
  /** Overridden only by the timeout test. */
  readonly pruneTimeoutMs?: number;
}

export function createPruneImages(
  options: PruneImagesOptions = {},
): StagedToolDef<Input, PruneImagesResult> {
  return {
    name: 'prune_images',
    risk: Risk.Reversible,
    description: [
      'Removes dangling Docker images — ones no tag points at and no container',
      'references — and reports how much space came back.',
      '',
      'Use this when disk_usage shows the Docker filesystem filling up and a host has',
      'accumulated untagged layers from repeated builds or pulls. Pass olderThan to',
      'restrict it to images above a certain age, e.g. "168h".',
      '',
      'It removes dangling images ONLY. It will not remove images that are merely',
      'unused, so the previous release you might roll back to, and the images stopped',
      'containers need in order to start, are all left alone. If you need those gone,',
      'a person has to do it.',
      '',
      'THIS CANNOT BE UNDONE. Deleted layers have to be pulled or rebuilt. The result',
      'lists what was removed.',
      '',
      'Expect the space reclaimed to be much smaller than the listed image sizes:',
      'layers are shared, and only those no surviving image references are actually',
      'freed. If little comes back, the space is being used by something else — check',
      'container logs and volumes with disk_usage.',
    ].join('\n'),
    input,

    // Deleted layers cannot be put back, so the snapshot is the removal list
    // reported in the result rather than a copy of anything.
    restorable: false,
    snapshot: () => ({ paths: [] }),

    async apply(params, ctx) {
      const before = await ctx.run(free());
      const candidates = await ctx.run({
        argv: ['docker', 'images', '--filter', 'dangling=true', '--format', '{{json .}}'],
        timeoutMs: READ_MS,
      });

      // No sudo, and no `-a`, ever. The flag list is built here and nowhere
      // else, so there is no argument a caller can pass that adds it.
      const argv = ['docker', 'image', 'prune', '-f'];
      if (params.olderThan !== undefined) {
        argv.push('--filter', `until=${guardDuration(params.olderThan)}`);
      }

      const prune = await ctx.run({ argv, timeoutMs: options.pruneTimeoutMs ?? PRUNE_MS });
      const after = await ctx.run(free());

      return [before, candidates, prune, after];
    },

    parse: (raws) => {
      const freeBefore = parseFree(at(raws, 0).stdout);
      const candidates = jsonLines(at(raws, 1).stdout).map((row) => ({
        id: String(row['ID'] ?? ''),
        size: String(row['Size'] ?? ''),
        createdSince: String(row['CreatedSince'] ?? ''),
      }));
      const prune = at(raws, 2);
      const freeAfter = parseFree(at(raws, 3).stdout);
      const failed = prune.exitCode !== 0;

      const deleted = [...prune.stdout.matchAll(/^deleted: sha256:([0-9a-f]+)$/gm)].map((match) =>
        (match[1] ?? '').slice(0, 12),
      );
      const reclaimed = /Total reclaimed space:\s*(.+)$/m.exec(prune.stdout)?.[1]?.trim() ?? '0B';

      return {
        candidates,
        deleted,
        reclaimed,
        freePercentBefore: freeBefore,
        freePercentAfter: freeAfter,
        ...(failed
          ? { error: prune.stderr.trim().split('\n')[0] || `docker exited ${prune.exitCode}` }
          : {}),
        assessment: assess(candidates.length, deleted.length, reclaimed, failed),
      };
    },

    verify: (_params, ctx) =>
      runChecks(
        [
          filesystemHasHeadroom(DOCKER_ROOT, options.minFreePercent),
          // Pruning should never take the daemon with it. Cheap to check and
          // the one thing that would turn housekeeping into an outage.
          validatorCommand('docker is still responding', {
            argv: ['docker', 'ps', '--quiet'],
            timeoutMs: READ_MS,
          }),
        ],
        ctx,
        options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs },
      ),

    // Nothing to give back; `restorable: false` is what the pipeline reads.
    rollback: () => [],
  };
}

/** The registered instance. */
export const pruneImages = createPruneImages();

function free(): RemoteCommand {
  return {
    argv: ['df', '--output=pcent', '--', DOCKER_ROOT],
    sudo: true,
    timeoutMs: READ_MS,
  };
}

/**
 * Re-checks the duration even though zod already did.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` for anything that is not a plain duration.
 */
function guardDuration(value: string): string {
  if (!/^[0-9]+(h|m|s)$/.test(value)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `"${value}" is not a duration`, {
      details: { olderThan: value },
      hint: 'use a value like 24h, 90m or 3600s',
    });
  }
  return value;
}

function parseFree(stdout: string): number | undefined {
  const row = stdout.trim().split('\n')[1];
  const used = toNumber((row ?? '').trim().replace('%', ''));
  return used === undefined ? undefined : 100 - used;
}

function assess(candidates: number, deleted: number, reclaimed: string, failed: boolean): string {
  if (failed) return 'docker refused the prune; nothing was removed';
  if (candidates === 0) return 'there were no dangling images to remove';
  if (deleted === 0) {
    return `${candidates} dangling image(s) were found but none were removed; they are still referenced`;
  }

  // Worth saying every time: the arithmetic surprises people.
  const shared =
    /^0*\.?0*\s*[kKmM]?B$/.test(reclaimed) || reclaimed.endsWith('kB')
      ? '; most of their layers are shared with images that remain, so little space came back'
      : '';

  return `removed ${deleted} dangling image(s), reclaiming ${reclaimed}${shared}`;
}
