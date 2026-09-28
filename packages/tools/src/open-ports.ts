import { z } from 'zod';
import { Risk, type ToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField, lines, toNumber } from './common.js';

const input = z
  .object({
    host: hostField,
    listeningOnly: z
      .boolean()
      .default(true)
      .describe('Only sockets in LISTEN state. Turn off to include UDP and established.'),
  })
  .strict();

type Input = z.output<typeof input>;

export interface OpenPort {
  readonly protocol: string;
  readonly state: string;
  readonly address: string;
  readonly port: number | undefined;
  /** True when the address is not a loopback one, so the port is reachable off-host. */
  readonly exposed: boolean;
  /** One entry per program, with every pid holding the socket. */
  readonly processes: readonly { readonly name: string; readonly pids: readonly number[] }[];
}

export interface OpenPorts {
  readonly ports: readonly OpenPort[];
  readonly exposedCount: number;
}

/**
 * Which sockets a host is listening on, and what is holding them.
 *
 * The `exposed` flag is the point: a service on 127.0.0.1 and the same service
 * on 0.0.0.0 look identical in a process list and are completely different
 * facts.
 */
export const openPorts: ToolDef<Input, OpenPorts> = {
  name: 'open_ports',
  risk: Risk.Read,
  description: [
    'Listening sockets on a host, with the process holding each one, and whether the',
    'socket is bound to loopback or to an address reachable from outside.',
    '',
    'Use this to confirm a service is actually accepting connections on the port you',
    'think it is. A reverse proxy returning 502 while nothing listens on the upstream',
    'port is the signature of a misconfigured upstream — compare what is listening here',
    'against what the proxy config in read_config points at.',
    '',
    '`exposed` true means the socket is not on loopback, so it is reachable off the',
    'host. A database or cache listening on 0.0.0.0 is worth reporting even when it is',
    'not what you were asked about.',
  ].join('\n'),
  input,

  build: (params) => [
    {
      // -H drops the header so there is no row to skip; -p needs root to show
      // which process owns each socket, which is the useful half.
      argv: ['ss', '-H', params.listeningOnly ? '-tlnp' : '-tulnp'],
      sudo: true,
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const ports = lines(at(raws, 0).stdout)
      .map(parseRow)
      .filter((port): port is OpenPort => port !== undefined);

    return { ports, exposedCount: ports.filter((port) => port.exposed).length };
  },
};

/** Loopback and the Docker embedded resolver, none of which are reachable off-host. */
function isLocal(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address === '::1' ||
    address === '[::1]' ||
    address.startsWith('%lo')
  );
}

function parseRow(line: string): OpenPort | undefined {
  // `tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=95,fd=8),...)`
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return undefined;

  const [protocol, state, , , local] = parts;
  if (local === undefined) return undefined;

  // Split on the last colon: an IPv6 address contains colons of its own.
  const separator = local.lastIndexOf(':');
  const address = separator > 0 ? local.slice(0, separator) : local;
  const port = separator > 0 ? toNumber(local.slice(separator + 1)) : undefined;

  return {
    protocol: protocol ?? '',
    state: state ?? '',
    address,
    port,
    exposed: !isLocal(address),
    processes: parseProcesses(line),
  };
}

function parseProcesses(line: string): OpenPort['processes'] {
  // nginx reports one entry per worker, each with its own pid -- nine of them on
  // :443 in the captured fixture. Nine rows saying "nginx" is noise; grouping by
  // program name keeps the fact that matters and still names every pid.
  const byName = new Map<string, Set<number>>();

  for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) {
    const name = match[1]!;
    const pid = toNumber(match[2]);
    if (pid === undefined) continue;

    const pids = byName.get(name) ?? new Set<number>();
    pids.add(pid);
    byName.set(name, pids);
  }

  return [...byName.entries()].map(([name, pids]) => ({
    name,
    pids: [...pids].sort((a, b) => a - b),
  }));
}
