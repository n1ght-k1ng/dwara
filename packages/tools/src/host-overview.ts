import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField, keyValues, lines, toNumber } from './common.js';

const input = z.object({ host: hostField }).strict();
type Input = z.output<typeof input>;

export interface HostOverview {
  readonly host: string;
  readonly kernel: string;
  readonly os: string;
  readonly uptimeSeconds: number | undefined;
  readonly load: { readonly one?: number; readonly five?: number; readonly fifteen?: number };
  readonly memory: {
    readonly totalKb?: number;
    readonly availableKb?: number;
    readonly usedPercent?: number;
  };
  readonly systemd: {
    readonly state: string;
    readonly failedUnits: readonly string[];
  };
}

/**
 * First look at a host: what it is, how loaded it is, and whether systemd is
 * happy.
 *
 * Deliberately the cheapest possible orientation step, so an investigation can
 * start here without knowing anything about the host. The failed-unit list is
 * the part that usually points at the next tool to call.
 */
export const hostOverview: ToolDef<Input, HostOverview> = {
  name: 'host_overview',
  risk: Risk.Read,
  description: [
    'Orientation for a host you know nothing about yet: kernel, distribution, uptime,',
    'load average, memory, whether systemd reports the system as running or degraded,',
    'and the names of any failed units.',
    '',
    'Use this first when asked to look at a host. Check `systemd.state` and',
    '`systemd.failedUnits` before anything else — a failed unit name tells you which',
    'unit to pass to service_status next. High `load.one` against a long uptime is a',
    'different story from high load just after a restart, so read them together.',
    '',
    'Returns nothing about applications. For those, use docker_ps or service_status.',
  ].join('\n'),
  input,

  build: () => [
    { argv: ['uname', '-srm'], timeoutMs: READ_TIMEOUT_MS },
    { argv: ['cat', '/etc/os-release'], timeoutMs: READ_TIMEOUT_MS },
    { argv: ['cat', '/proc/uptime'], timeoutMs: READ_TIMEOUT_MS },
    { argv: ['cat', '/proc/loadavg'], timeoutMs: READ_TIMEOUT_MS },
    { argv: ['head', '-5', '/proc/meminfo'], timeoutMs: READ_TIMEOUT_MS },
    { argv: ['systemctl', 'is-system-running'], sudo: true, timeoutMs: READ_TIMEOUT_MS },
    {
      argv: ['systemctl', 'list-units', '--state=failed', '--no-legend', '--no-pager', '--plain'],
      sudo: true,
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const os = keyValues(at(raws, 1).stdout);
    const load = at(raws, 3).stdout.trim().split(/\s+/);
    const mem = memory(at(raws, 4).stdout);

    // `is-system-running` exits non-zero for `degraded`, which is information
    // rather than failure — the word on stdout is the answer either way.
    const systemdState = at(raws, 5).stdout.trim() || 'unknown';

    return {
      host: '',
      kernel: at(raws, 0).stdout.trim(),
      os: strip(os['PRETTY_NAME'] ?? os['NAME'] ?? ''),
      uptimeSeconds: toNumber(at(raws, 2).stdout.trim().split(/\s+/)[0]),
      load: {
        ...(toNumber(load[0]) === undefined ? {} : { one: toNumber(load[0]) }),
        ...(toNumber(load[1]) === undefined ? {} : { five: toNumber(load[1]) }),
        ...(toNumber(load[2]) === undefined ? {} : { fifteen: toNumber(load[2]) }),
      },
      memory: mem,
      systemd: {
        state: systemdState,
        // Each line is `unit load active sub description`; the unit is first.
        failedUnits: lines(at(raws, 6).stdout).map((line) => line.trim().split(/\s+/)[0] ?? ''),
      },
    };
  },
};

function memory(text: string): HostOverview['memory'] {
  const fields = keyValues(text.replace(/:\s+/g, '='));
  const totalKb = toNumber(fields['MemTotal']?.replace(/\s*kB$/, ''));
  const availableKb = toNumber(fields['MemAvailable']?.replace(/\s*kB$/, ''));

  return {
    ...(totalKb === undefined ? {} : { totalKb }),
    ...(availableKb === undefined ? {} : { availableKb }),
    // MemAvailable rather than MemFree: free memory excludes reclaimable cache
    // and makes every healthy Linux host look nearly out of memory.
    ...(totalKb !== undefined && availableKb !== undefined && totalKb > 0
      ? { usedPercent: Math.round(((totalKb - availableKb) / totalKb) * 100) }
      : {}),
  };
}

function strip(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}
