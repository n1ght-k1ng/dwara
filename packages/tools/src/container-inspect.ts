import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField, toNumber, unavailable } from './common.js';

const input = z
  .object({
    host: hostField,
    container: z.string().min(1).describe('Container name or full id, as docker_ps reports it.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface ContainerDetail {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: {
    readonly status: string;
    readonly running: boolean;
    readonly restarting: boolean;
    readonly exitCode: number | undefined;
    readonly oomKilled: boolean;
    readonly error: string;
    readonly startedAt: string;
    readonly finishedAt: string;
  };
  readonly restartCount: number | undefined;
  readonly restartPolicy: string;
  readonly health:
    { readonly status: string; readonly failingStreak: number | undefined } | undefined;
  readonly networkMode: string;
  readonly ports: readonly string[];
  readonly mounts: readonly string[];
  /** Environment as `KEY=value`. Values pass through the redactor. */
  readonly env: readonly string[];
  readonly assessment: string;
  readonly error?: string;
}

/**
 * The detail behind one container: why it stopped, how often it has restarted,
 * and what it was configured with.
 *
 * Returns a summary rather than the whole `docker inspect` document. The raw
 * output is several thousand lines of mostly irrelevant defaults, and DESIGN
 * asks for compact, structured results.
 */
export const containerInspect: ToolDef<Input, ContainerDetail> = {
  name: 'container_inspect',
  risk: Risk.Read,
  description: [
    'Why a container is in the state it is in: exit code, whether the kernel OOM-killed',
    'it, how many times Docker has restarted it, its restart policy, health check result,',
    'network mode, published ports, mounts and environment.',
    '',
    'Read `state.oomKilled` and `state.exitCode` first. OOM-killed means the container hit',
    'a memory limit and nothing in its own logs will say so. A high `restartCount` with',
    'restartPolicy "always" is a crash loop that will continue until the cause is fixed.',
    'Exit code 137 is SIGKILL (often OOM), 139 is a segfault, 1 is usually the application',
    'exiting on its own error.',
    '',
    '`env` often explains a connection failure: the host, port or database name a service',
    'was given may simply be wrong. Credentials in it are redacted, but the host and',
    'database remain visible, which is the diagnostically useful part.',
  ].join('\n'),
  input,

  build: (params) => [
    { argv: ['docker', 'inspect', params.container], timeoutMs: READ_TIMEOUT_MS },
  ],

  parse: (raws) => {
    const raw = at(raws, 0);
    const missing = unavailable(raw);
    if (missing) return { ...blank(raw), error: missing.reason, assessment: missing.reason };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.stdout);
    } catch {
      return {
        ...blank(raw),
        error: 'docker inspect did not return JSON',
        assessment: 'could not read container detail',
      };
    }

    const entry = Array.isArray(parsed)
      ? (parsed[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!entry)
      return { ...blank(raw), error: 'no such container', assessment: 'no such container' };

    const state = record(entry['State']);
    const config = record(entry['Config']);
    const hostConfig = record(entry['HostConfig']);
    const health = record(state['Health']);

    const detail: ContainerDetail = {
      id: string(entry['Id']),
      // Docker prefixes the name with a slash.
      name: string(entry['Name']).replace(/^\//, ''),
      image: string(config['Image']) || string(entry['Image']),
      state: {
        status: string(state['Status']),
        running: state['Running'] === true,
        restarting: state['Restarting'] === true,
        exitCode: toNumber(String(state['ExitCode'] ?? '')),
        oomKilled: state['OOMKilled'] === true,
        error: string(state['Error']),
        startedAt: string(state['StartedAt']),
        finishedAt: string(state['FinishedAt']),
      },
      restartCount: toNumber(String(entry['RestartCount'] ?? '')),
      restartPolicy: string(record(hostConfig['RestartPolicy'])['Name']),
      health:
        Object.keys(health).length > 0
          ? {
              status: string(health['Status']),
              failingStreak: toNumber(String(health['FailingStreak'] ?? '')),
            }
          : undefined,
      networkMode: string(hostConfig['NetworkMode']),
      ports: Object.keys(record(config['ExposedPorts'])),
      mounts: (Array.isArray(entry['Mounts']) ? entry['Mounts'] : []).map((mount) => {
        const m = record(mount);
        return `${string(m['Source']) || string(m['Name'])} -> ${string(m['Destination'])}`;
      }),
      env: Array.isArray(config['Env']) ? config['Env'].map((value) => String(value)) : [],
      assessment: '',
    };

    return { ...detail, assessment: assess(detail) };
  },
};

function assess(detail: ContainerDetail): string {
  if (detail.state.oomKilled) {
    return 'the kernel killed this container for exceeding its memory limit; nothing in its own logs will say so';
  }
  if (detail.state.restarting) return 'restarting right now';
  if ((detail.restartCount ?? 0) > 3 && detail.restartPolicy !== 'no') {
    return `restarted ${detail.restartCount} times under policy "${detail.restartPolicy}"; this is a crash loop and will continue until the cause is fixed`;
  }
  if (detail.health?.status === 'unhealthy') return 'running but its own health check is failing';
  if (!detail.state.running) {
    const code = detail.state.exitCode;
    return `not running, exit code ${code ?? 'unknown'}${code === 137 ? ' (SIGKILL, often out of memory)' : ''}`;
  }
  return 'running';
}

function blank(raw: { argv: readonly string[] }): ContainerDetail {
  return {
    id: '',
    name: raw.argv[raw.argv.length - 1] ?? '',
    image: '',
    state: {
      status: 'unknown',
      running: false,
      restarting: false,
      exitCode: undefined,
      oomKilled: false,
      error: '',
      startedAt: '',
      finishedAt: '',
    },
    restartCount: undefined,
    restartPolicy: '',
    health: undefined,
    networkMode: '',
    ports: [],
    mounts: [],
    env: [],
    assessment: '',
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
