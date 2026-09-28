import { z } from 'zod';
import { Risk, type BuiltToolDef } from '@dwara/core';
import {
  READ_TIMEOUT_MS,
  at,
  hostField,
  jsonLines,
  unavailable,
  type Unavailable,
} from './common.js';

const input = z
  .object({
    host: hostField,
    all: z
      .boolean()
      .default(true)
      .describe(
        'Include stopped and exited containers. Leave on: a container that is not there is usually the finding.',
      ),
  })
  .strict();

type Input = z.output<typeof input>;

export interface Container {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly command: string;
  readonly createdAt: string;
  readonly status: string;
  readonly ports: string;
  /** Docker's own state word: running, exited, restarting, created, paused. */
  readonly state: string;
  readonly running: boolean;
  /** Set when the status text carries one, e.g. "Exited (137)". */
  readonly exitCode?: number;
  /** Present only when the image defines a health check. */
  readonly health?: string;
}

export interface DockerPs {
  readonly containers: readonly Container[] | Unavailable;
  readonly assessment: string;
}

/**
 * Containers on a host, running or not.
 *
 * `all` defaults to true because the interesting case is usually a container
 * that should be there and is not, and `docker ps` without `-a` hides exactly
 * that.
 */
export const dockerPs: BuiltToolDef<Input, DockerPs> = {
  name: 'docker_ps',
  risk: Risk.Read,
  description: [
    'Containers on a host: id, name, image, command, age, status and published ports.',
    'Includes stopped containers by default.',
    '',
    'An empty list on a host that should be running containers is a real finding, not a',
    'failure — a container in a restart loop is absent between attempts, so calling this',
    'twice a few seconds apart tells you more than calling it once. Read `status` text',
    'carefully: "Up 2 hours" and "Up 1 second" mean very different things, and',
    '"Restarting (1) 3 seconds ago" means it is failing right now.',
    '',
    'For why a container is failing, call container_logs with its name. For its',
    'configuration, restart count and environment, call container_inspect.',
    '',
    'If this reports unavailable, the host has no Docker and the service you are looking',
    'for is probably a systemd unit — use service_status instead.',
  ].join('\n'),
  input,

  build: (params) => [
    {
      // --no-trunc keeps full ids, so an id from here can be passed to
      // container_inspect without the caller guessing at the truncation.
      // `{{json .}}`, not a tab-delimited template. A tab in an argument is a
      // control character, which the transport refuses outright -- so the
      // delimited form made this tool impossible to call. JSON needs no
      // delimiter, and carries Docker's own State and HealthStatus rather than
      // leaving them to be inferred from the status text.
      argv: ['docker', 'ps', ...(params.all ? ['-a'] : []), '--no-trunc', '--format', '{{json .}}'],
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const raw = at(raws, 0);
    const missing = unavailable(raw);
    if (missing)
      return { containers: missing, assessment: `docker is not usable here: ${missing.reason}` };

    const containers: Container[] = jsonLines(raw.stdout).map((entry) => {
      const statusText = str(entry['Status']);
      const exited = /Exited \((\d+)\)/.exec(statusText);
      const state = str(entry['State']);
      const health = str(entry['HealthStatus']);

      return {
        id: str(entry['ID']),
        name: str(entry['Names']),
        image: str(entry['Image']),
        command: str(entry['Command']).replace(/^"|"$/g, ''),
        createdAt: str(entry['CreatedAt']),
        status: statusText,
        ports: str(entry['Ports']),
        state,
        running: state === 'running' || statusText.startsWith('Up'),
        ...(exited ? { exitCode: Number(exited[1]) } : {}),
        ...(health === '' ? {} : { health }),
      };
    });

    return { containers, assessment: assess(containers) };
  },
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function assess(containers: readonly Container[]): string {
  if (containers.length === 0) {
    // Emphatically not "the host is fine": a crash-looping container is absent
    // between attempts, and the captured crash-loop fixture is empty for
    // exactly that reason.
    return 'no containers at all; if one is expected it may be between restarts, so call again';
  }

  const unhealthy = containers.filter((c) => c.health === 'unhealthy');
  const restarting = containers.filter(
    (c) => c.state === 'restarting' || /^Restarting/.test(c.status),
  );
  const down = containers.filter((c) => !c.running);
  const young = containers.filter((c) =>
    /^Up (?:Less than a second|\d+ seconds?)\b/.test(c.status),
  );

  if (restarting.length > 0) return `${restarting.map((c) => c.name).join(', ')} is restarting now`;
  if (young.length > 0) {
    return `${young.map((c) => c.name).join(', ')} started seconds ago, which may mean it keeps restarting`;
  }
  if (down.length > 0) return `${down.map((c) => c.name).join(', ')} is not running`;
  if (unhealthy.length > 0) {
    return `${unhealthy.map((c) => c.name).join(', ')} is running but its health check is failing`;
  }
  return `${containers.length} container(s), all running`;
}
