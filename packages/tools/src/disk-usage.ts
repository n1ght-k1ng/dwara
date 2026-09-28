import { z } from 'zod';
import { Risk, type BuiltToolDef } from '@dwara/core';
import {
  READ_TIMEOUT_MS,
  at,
  columns,
  hostField,
  jsonLines,
  toNumber,
  unavailable,
  type Unavailable,
} from './common.js';

const input = z
  .object({
    host: hostField,
    path: z
      .string()
      .min(1)
      .default('/')
      .describe('Absolute path whose filesystem to measure. Defaults to /.'),
    includeDocker: z
      .boolean()
      .default(false)
      .describe('Also report what Docker is using. Only useful on a host running containers.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface Filesystem {
  readonly filesystem: string;
  readonly mountedOn: string;
  readonly totalBytes: number | undefined;
  readonly usedBytes: number | undefined;
  readonly availableBytes: number | undefined;
  readonly usedPercent: number | undefined;
}

export interface DirectorySize {
  readonly path: string;
  readonly bytes: number | undefined;
}

export interface DockerUsage {
  readonly type: string;
  readonly total: number | undefined;
  readonly active: number | undefined;
  readonly size: string;
  readonly reclaimable: string;
}

export interface DiskUsage {
  readonly filesystem: Filesystem | undefined;
  /** Immediate children of the requested path, largest first. */
  readonly largestDirectories: readonly DirectorySize[];
  readonly docker?: readonly DockerUsage[] | Unavailable;
  /** Plain reading of the numbers, so a full disk is not missed. */
  readonly assessment: string;
}

/**
 * How full a filesystem is, and which directories underneath it account for it.
 *
 * Byte counts throughout, via `df -B1` and `du -B1`, because human-readable
 * units ("1.2G") are a parsing hazard and cannot be compared arithmetically.
 */
export const diskUsage: BuiltToolDef<Input, DiskUsage> = {
  name: 'disk_usage',
  risk: Risk.Read,
  description: [
    'How full the filesystem holding a path is, and which directories directly under',
    'that path are largest. Sizes are in bytes. Optionally includes what Docker is',
    'using.',
    '',
    'Start with path "/" and follow `largestDirectories` downward — call again with the',
    'largest child to descend. `usedPercent` at or near 100 with `availableBytes` of 0',
    'is a full filesystem, which makes services fail in ways that look unrelated:',
    'databases refuse writes, journald drops messages, nginx cannot log.',
    '',
    'Pass includeDocker on a host running containers; images and build cache are a',
    'common cause of a disk filling up without any application growing.',
    '',
    'Note that a bounded mount such as /var/log can be full while / has plenty free,',
    'so check the specific path a failing service writes to rather than only /.',
  ].join('\n'),
  input,

  build: (params) => {
    const commands = [
      { argv: ['df', '-P', '-B1', '--', params.path], timeoutMs: READ_TIMEOUT_MS },
      // -d1 keeps this to one level: a recursive du on / is slow enough to hit
      // the timeout on a real host and returns far more than anyone can read.
      { argv: ['du', '-B1', '-d1', '--', params.path], sudo: true, timeoutMs: READ_TIMEOUT_MS },
    ];

    if (params.includeDocker) {
      // `{{json .}}` rather than a tab-delimited template: a tab is a control
      // character and the transport refuses those in arguments.
      commands.push({
        argv: ['docker', 'system', 'df', '--format', '{{json .}}'],
        timeoutMs: READ_TIMEOUT_MS,
      });
    }

    return commands;
  },

  parse: (raws) => {
    const filesystem = parseDf(at(raws, 0).stdout);
    const requested = at(raws, 1).argv[at(raws, 1).argv.length - 1] ?? '';

    const sizes = columns(at(raws, 1).stdout, 2)
      .map(([bytes, path]) => ({ path: (path ?? '').trim(), bytes: toNumber(bytes) }))
      // du prints the requested directory itself last; the children are what
      // tell you where the space went.
      .filter((entry) => entry.path !== '' && entry.path !== requested)
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      .slice(0, 20);

    const dockerRaw = raws[2];
    const docker =
      dockerRaw === undefined
        ? undefined
        : (unavailable(dockerRaw) ??
          jsonLines(dockerRaw.stdout).map((entry) => ({
            type: typeof entry['Type'] === 'string' ? entry['Type'] : '',
            total: toNumber(String(entry['TotalCount'] ?? '')),
            active: toNumber(String(entry['Active'] ?? '')),
            size: typeof entry['Size'] === 'string' ? entry['Size'] : '',
            reclaimable: typeof entry['Reclaimable'] === 'string' ? entry['Reclaimable'] : '',
          })));

    return {
      filesystem,
      largestDirectories: sizes,
      ...(docker === undefined ? {} : { docker }),
      assessment: assess(filesystem),
    };
  },
};

function parseDf(text: string): Filesystem | undefined {
  // Row 0 is the header; -P guarantees one row per filesystem even for long
  // device names, which is the whole reason for using it.
  const rows = columns(text).slice(1);
  const row = rows[0];
  if (!row || row.length < 6) return undefined;

  return {
    filesystem: row[0]!,
    mountedOn: row[5]!,
    totalBytes: toNumber(row[1]),
    usedBytes: toNumber(row[2]),
    availableBytes: toNumber(row[3]),
    usedPercent: toNumber(row[4]?.replace('%', '')),
  };
}

function assess(filesystem: Filesystem | undefined): string {
  if (!filesystem) return 'could not read filesystem usage for that path';

  const percent = filesystem.usedPercent;
  const available = filesystem.availableBytes;

  if (available === 0 || percent === 100) {
    return `${filesystem.mountedOn} is completely full; writes to it are failing now`;
  }
  if ((percent ?? 0) >= 95) return `${filesystem.mountedOn} is ${percent}% full and about to fill`;
  if ((percent ?? 0) >= 85) return `${filesystem.mountedOn} is ${percent}% full, worth watching`;
  return `${filesystem.mountedOn} is ${percent}% full, which is fine`;
}
