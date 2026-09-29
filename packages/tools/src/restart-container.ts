import { z } from 'zod';
import {
  DwaraError,
  Risk,
  containerRunningAndHealthy,
  policyHttpChecks,
  runChecks,
  type ContainerSnapshot,
  type RemoteCommand,
  type StagedToolDef,
} from '@dwara/core';
import { at, hostField } from './common.js';

/**
 * Container names Dwara will not restart.
 *
 * Narrower than the unit list, because a container almost never carries the
 * host's own plumbing. What it must not do is restart whatever is proxying the
 * SSH connection or the Docker daemon's own helpers — the same reasoning as
 * `PROTECTED_UNITS`: losing the connection is the one failure Dwara cannot
 * recover from.
 */
export const PROTECTED_CONTAINERS: readonly string[] = ['dwara', 'sshd', 'ssh'] as const;

/**
 * Docker names are a restricted alphabet, and this is checked rather than
 * assumed: the name reaches argv, and a value that looks like an option would
 * be read as one. `--` guards that too, but two guards cost nothing here.
 */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const input = z
  .object({
    host: hostField,
    container: z
      .string()
      .min(1)
      .describe('Container name or id, as docker_ps reports it. Not an image name.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface ContainerReading {
  readonly running: boolean;
  readonly status: string;
  readonly restartCount: number | undefined;
}

export interface RestartContainerResult {
  readonly container: string;
  readonly image: string;
  readonly before: ContainerReading;
  readonly after: ContainerReading;
  readonly restarted: boolean;
  readonly error?: string;
  readonly assessment: string;
}

const READ_MS = 20_000;
export const RESTART_TIMEOUT_MS = 45_000;

/** One line per container, matching what the snapshot manager records. */
const FORMAT = '{{.Name}}|{{.State.Running}}|{{.State.Status}}|{{.RestartCount}}|{{.Config.Image}}';

export interface RestartContainerOptions {
  readonly restartTimeoutMs?: number;
  readonly stableForMs?: number;
  /** A failing verify retries to this deadline, so it sets what a rollback costs. */
  readonly verifyTimeoutMs?: number;
}

/**
 * Restarts one container, then proves it came back.
 *
 * A factory so the integration suite can shorten the timeouts; the registry
 * gets the default instance.
 */
export function createRestartContainer(
  options: RestartContainerOptions = {},
): StagedToolDef<Input, RestartContainerResult> {
  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS;

  return {
    name: 'restart_container',
    risk: Risk.Reversible,
    description: [
      'Restarts a Docker container and then checks it actually came back: running, its',
      'own health check passing if it defines one, and still running a few seconds',
      'later. Any HTTP health check the policy declares for the host is checked too.',
      '',
      'If verification fails the restart is undone — the container is returned to the',
      'state it was in — and the result says which check failed. A restart reported ok',
      'has been verified; there is no need to call docker_ps afterwards to confirm.',
      '',
      'Use this for a container that is running but wedged: a stuck worker, a leaked',
      'connection pool, a process that needs its configuration re-read. It does not fix',
      'a container that exits on boot — it will exit again the same way, and you will',
      'get its restart count back. Read container_logs first to find out why it died.',
      '',
      'A container in a restart loop reports "running" at most instants you look,',
      'because Docker has just started it again. A climbing restartCount is the tell.',
      '',
      'This restarts a container, not the service that supervises it. If the container',
      'is managed by a systemd unit or a compose project, that supervisor may replace',
      'or revert what this does.',
    ].join('\n'),
    input,

    // Nothing on disk changes, so there is nothing to copy. The recorded
    // running state is what the rollback puts back.
    snapshot: (params) => ({ paths: [], containers: [guardName(params.container)] }),

    async apply(params, ctx) {
      const container = guardName(params.container);

      const before = await ctx.run(inspect(container));
      // No sudo anywhere: docker group membership already carries the daemon's
      // authority, and none of the Phase 2 docker tools use it either.
      const restart = await ctx.run({
        argv: ['docker', 'restart', '--', container],
        timeoutMs: restartTimeoutMs,
      });
      const after = await ctx.run(inspect(container));

      return [before, restart, after];
    },

    parse: (raws) => {
      const before = parseLine(at(raws, 0).stdout);
      const restart = at(raws, 1);
      const after = parseLine(at(raws, 2).stdout);
      const failed = restart.exitCode !== 0;

      return {
        container: after.name || before.name,
        image: after.image || before.image,
        before: before.reading,
        after: after.reading,
        restarted: !failed,
        ...(failed
          ? {
              error:
                restart.stderr.trim().split('\n')[0] || `docker restart exited ${restart.exitCode}`,
            }
          : {}),
        assessment: assess(before.reading, after.reading, failed),
      };
    },

    verify: (params, ctx) =>
      runChecks(
        [
          containerRunningAndHealthy(guardName(params.container), options.stableForMs),
          ...policyHttpChecks(ctx),
        ],
        ctx,
        options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs },
      ),

    // Restores whether the container was meant to be up. As with a unit, this
    // restores intent rather than health: a container that dies on boot will
    // die again, and the pipeline's post-undo check notices and says so.
    rollback: (snapshot) =>
      Object.entries(snapshot.containers ?? {}).map(([container, state]) => ({
        argv: ['docker', state.running ? 'start' : 'stop', '--', container],
        timeoutMs: restartTimeoutMs,
      })),
  };
}

/** The registered instance, with production timeouts. */
export const restartContainer = createRestartContainer();

function inspect(container: string): RemoteCommand {
  return {
    argv: ['docker', 'inspect', '--format', FORMAT, '--', container],
    timeoutMs: READ_MS,
  };
}

/**
 * @throws DwaraError `UNSAFE_ARGUMENT` for a malformed or protected name.
 */
function guardName(requested: string): string {
  if (!CONTAINER_NAME.test(requested)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `"${requested}" is not a container name`, {
      details: { container: requested },
      hint: 'use the name or id exactly as docker_ps reports it',
    });
  }

  if (PROTECTED_CONTAINERS.includes(requested)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `Dwara will not restart the "${requested}" container`, {
      details: { container: requested, protected: [...PROTECTED_CONTAINERS] },
      hint: 'this is how Dwara reaches the host; restart it from somewhere else',
    });
  }

  return requested;
}

function parseLine(stdout: string): {
  name: string;
  image: string;
  reading: ContainerReading;
} {
  const parts = (stdout.split('\n')[0] ?? '').split('|');
  const restarts = Number(parts[3]);

  return {
    // `.Name` arrives with a leading slash.
    name: (parts[0] ?? '').replace(/^\//, ''),
    image: parts[4] ?? '',
    reading: {
      running: parts[1] === 'true',
      status: parts[2] ?? 'unknown',
      restartCount: Number.isFinite(restarts) ? restarts : undefined,
    },
  };
}

function assess(before: ContainerReading, after: ContainerReading, failed: boolean): string {
  if (failed) return 'docker refused the restart; the container is as it was';
  if (!after.running) return `came back ${after.status}; read its logs for the reason`;

  const climbed =
    after.restartCount !== undefined &&
    before.restartCount !== undefined &&
    after.restartCount > before.restartCount;

  if (climbed) {
    return `running, but its restart count went from ${before.restartCount} to ${after.restartCount}, which looks like a loop`;
  }

  return before.running ? 'restarted and running' : `was ${before.status}, now running`;
}

/** Re-exported so the snapshot's container shape is visible to callers. */
export type { ContainerSnapshot };
