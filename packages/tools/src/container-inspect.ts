import { z } from 'zod';
import { Risk, type BuiltToolDef } from '@dwara/core';
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
  /**
   * Environment as `KEY=value`, with **every value withheld** unless its key is
   * on a short operational allow-list. See `SHOWABLE_ENV`.
   */
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
export const containerInspect: BuiltToolDef<Input, ContainerDetail> = {
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
    '`env` often explains a connection failure: a service may simply have been given',
    'the wrong settings. **Values are withheld.** You get each variable name and',
    'whether it is set or empty -- which answers "is this configured at all" -- but not',
    'the value, because on a container orchestrator the environment is where injected',
    'secrets live, and that includes the host and database names next to them.',
    '',
    'A few operational keys are shown in full: PORT, NODE_ENV, LOG_LEVEL and similar.',
    'If a withheld value is genuinely blocking you, name the variable, say what you',
    'would do with it, and ask the person to read it for you. Do not guess at it.',
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
      env: Array.isArray(config['Env'])
        ? config['Env'].map((value) => redactEnv(String(value)))
        : [],
      assessment: '',
    };

    return { ...detail, assessment: assess(detail) };
  },
};

/**
 * Environment keys whose values may be shown.
 *
 * Everything else is withheld, which is the opposite of how the redactor works
 * elsewhere in this repo -- and deliberately so. On a container orchestrator the
 * environment **is** the credential store: ECS injects Secrets Manager values
 * straight into `Config.Env`, and `docker inspect` prints them in plain text. A
 * reviewer looking at a real UAT cluster found Razorpay keys, AWS access keys,
 * messaging tokens and a database URI for a host shared with production, all
 * sitting in the environment of ordinary containers.
 *
 * Pattern matching is the wrong tool for that. Measured against those exact
 * shapes, the redactor caught every secret whose key name contained KEY, SECRET,
 * TOKEN, URI or PASSWORD, and every value with a known vendor prefix -- and
 * missed `RZP=rzp_live_...`, because the name says nothing and `rzp_` was not a
 * pattern it knew. Adding `rzp_` would fix that one case and leave the next
 * vendor open. A deny-list of secret shapes can only ever be as current as its
 * last update; an allow-list of *operational* keys is small, stable, and fails
 * closed for everything it has never heard of.
 *
 * The list is kept to what a diagnosis genuinely reads. `PORT` is here because a
 * benchmark run used it to prove an application was listening on 3000 while nginx
 * proxied to 3999 -- that is the shape of thing this tool exists for. A value not
 * on this list is still *reported as set*, which answers most questions on its
 * own; for the rest, a person can look.
 */
const SHOWABLE_ENV: readonly string[] = [
  'PORT',
  'NODE_ENV',
  'ENVIRONMENT',
  'ENV',
  'STAGE',
  'LOG_LEVEL',
  'TZ',
  'LANG',
  'HOSTNAME',
  'HOME',
  'PWD',
  'SHELL',
  'TERM',
  'PATH',
  'NODE_VERSION',
  'PYTHON_VERSION',
];

/**
 * Withholds an environment value unless its key is operational.
 *
 * Reports whether the variable is set and whether it is empty, because "the
 * variable is missing" and "the variable is set to the wrong thing" are different
 * diagnoses and the first is answerable without the value.
 */
function redactEnv(entry: string): string {
  const split = entry.indexOf('=');
  if (split < 0) return entry;

  const key = entry.slice(0, split);
  const value = entry.slice(split + 1);

  if (SHOWABLE_ENV.includes(key.toUpperCase())) return entry;
  if (value === '') return `${key}=`;

  return `${key}=[REDACTED:env-value]`;
}

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
