import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import {
  READ_TIMEOUT_MS,
  at,
  hostField,
  tabRows,
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
  /** Read from the status text, which is where Docker puts it. */
  readonly running: boolean;
  /** Set when the status says the container exited, with the code. */
  readonly exitCode?: number;
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
export const dockerPs: ToolDef<Input, DockerPs> = {
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
      argv: [
        'docker',
        'ps',
        ...(params.all ? ['-a'] : []),
        '--no-trunc',
        '--format',
        '{{.ID}}\t{{.Image}}\t{{.Command}}\t{{.CreatedAt}}\t{{.Status}}\t{{.Ports}}\t{{.Names}}',
      ],
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const raw = at(raws, 0);
    const missing = unavailable(raw);
    if (missing)
      return { containers: missing, assessment: `docker is not usable here: ${missing.reason}` };

    const containers = tabRows(raw.stdout).map(
      ([id, image, command, createdAt, status, ports, name]) => {
        const statusText = status ?? '';
        const exited = /^Exited \((\d+)\)/.exec(statusText);

        return {
          id: id ?? '',
          name: name ?? '',
          image: image ?? '',
          command: (command ?? '').replace(/^"|"$/g, ''),
          createdAt: createdAt ?? '',
          status: statusText,
          ports: ports ?? '',
          running: statusText.startsWith('Up'),
          ...(exited ? { exitCode: Number(exited[1]) } : {}),
        };
      },
    );

    return { containers, assessment: assess(containers) };
  },
};

function assess(containers: readonly Container[]): string {
  if (containers.length === 0) {
    // Emphatically not "the host is fine": a crash-looping container is absent
    // between attempts, and the captured crash-loop fixture is empty for
    // exactly that reason.
    return 'no containers at all; if one is expected it may be between restarts, so call again';
  }

  const restarting = containers.filter((c) => /^Restarting/.test(c.status));
  const down = containers.filter((c) => !c.running);
  const young = containers.filter((c) =>
    /^Up (?:Less than a second|\d+ seconds?)\b/.test(c.status),
  );

  if (restarting.length > 0) return `${restarting.map((c) => c.name).join(', ')} is restarting now`;
  if (young.length > 0) {
    return `${young.map((c) => c.name).join(', ')} started seconds ago, which may mean it keeps restarting`;
  }
  if (down.length > 0) return `${down.map((c) => c.name).join(', ')} is not running`;
  return `${containers.length} container(s), all running`;
}
