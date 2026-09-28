import { describe, expect, it } from 'vitest';
import { asResult, asResults, fixture } from './fixtures.js';
import { hostOverview } from './host-overview.js';
import { serviceStatus } from './service-status.js';
import { tailLogs } from './tail-logs.js';
import { diskUsage } from './disk-usage.js';
import { openPorts } from './open-ports.js';

/**
 * Parsers against real captured output.
 *
 * Every parser also gets an empty input: a host returning nothing is a real
 * answer, and treating it as a failure breaks the tool exactly when the host is
 * broken. `crashloop.docker_ps` is empty because the container was between
 * restarts when it was captured.
 */

describe('host_overview', () => {
  const healthy = () =>
    hostOverview.parse(
      asResults([
        'healthy/host_overview.uname',
        'healthy/host_overview.os-release',
        'healthy/host_overview.uptime',
        'healthy/host_overview.loadavg',
        'healthy/host_overview.meminfo',
        'healthy/host_overview.is-system-running',
        'healthy/host_overview.failed-units',
        'healthy/disk_usage.df-all',
      ]),
    );

  it('reads the kernel, distribution and uptime', () => {
    const result = healthy();
    expect(result.kernel).toBe('Linux 6.10.14-linuxkit x86_64');
    expect(result.os).toContain('Ubuntu 24.04');
    expect(result.uptimeSeconds).toBeGreaterThan(0);
  });

  it('reads all three load averages', () => {
    expect(healthy().load).toEqual({ one: 3.43, five: 1.54, fifteen: 0.59 });
  });

  it('computes used memory from MemAvailable, not MemFree', () => {
    // MemFree excludes reclaimable cache, which makes every healthy Linux host
    // look nearly out of memory.
    const memory = healthy().memory;
    expect(memory.totalKb).toBe(7803032);
    expect(memory.availableKb).toBe(6035432);
    expect(memory.usedPercent).toBe(23);
  });

  it('reports systemd state and no failed units on a healthy host', () => {
    expect(healthy().systemd).toEqual({ state: 'running', failedUnits: [] });
  });

  it('reads degraded state even though the command exits non-zero', () => {
    // `systemctl is-system-running` exits 1 for degraded. That is information,
    // not failure, and the word on stdout is the answer.
    const result = hostOverview.parse(
      asResults([
        'healthy/host_overview.uname',
        'healthy/host_overview.os-release',
        'healthy/host_overview.uptime',
        'healthy/host_overview.loadavg',
        'healthy/host_overview.meminfo',
        asResult('degraded\n', { exitCode: 1 }),
        asResult('nginx.service loaded failed failed A high performance web server\n'),
        'healthy/disk_usage.df-all',
      ]),
    );

    expect(result.systemd.state).toBe('degraded');
    expect(result.systemd.failedUnits).toEqual(['nginx.service']);
  });

  it('reports filesystem pressure, which orientation has to include', () => {
    // The Phase 2 exit gate failed the disk-full scenario with twenty tool calls
    // and not one of them reaching disk_usage. The orientation tool reported
    // memory and said nothing about disk, so nothing pointed that way.
    const result = healthy();

    expect(result.disk.root.usedPercent).toBeGreaterThanOrEqual(0);
    expect(result.disk.nearlyFull).toEqual([]);
  });

  it('names a full bounded mount even when / is fine', () => {
    const result = hostOverview.parse(
      asResults([
        'healthy/host_overview.uname',
        'healthy/host_overview.os-release',
        'healthy/host_overview.uptime',
        'healthy/host_overview.loadavg',
        'healthy/host_overview.meminfo',
        'healthy/host_overview.is-system-running',
        'healthy/host_overview.failed-units',
        'broken/diskfull.df-all',
      ]),
    );

    const full = result.disk.nearlyFull.find((mount) => mount.mountedOn === '/var/log');
    expect(full).toMatchObject({ usedPercent: 100, availableBytes: 0 });
    // The asymmetry is the whole point: / is healthy, /var/log is not.
    expect(result.disk.root.usedPercent).toBeLessThan(85);
  });

  it('survives every command returning nothing', () => {
    const result = hostOverview.parse(asResults(Array.from({ length: 8 }, () => asResult(''))));
    expect(result.systemd.state).toBe('unknown');
    expect(result.load).toEqual({});
    expect(result.memory.usedPercent).toBeUndefined();
    expect(result.disk.nearlyFull).toEqual([]);
  });
});

describe('service_status', () => {
  it('reads a healthy unit', () => {
    const result = serviceStatus.parse(asResults(['healthy/service_status.nginx']));

    expect(result).toMatchObject({
      unit: 'nginx.service',
      exists: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      enabled: 'enabled',
      mainPid: 86,
      restarts: 0,
    });
    expect(result.assessment).toBe('running normally');
  });

  it('reports a unit systemd has never heard of', () => {
    const result = serviceStatus.parse(asResults(['healthy/service_status.missing']));

    expect(result.exists).toBe(false);
    expect(result.loadState).toBe('not-found');
    expect(result.assessment).toContain('no such unit');
  });

  it('calls a climbing restart count a crash loop', () => {
    // The captured unit reports activeState=active because systemd had just
    // restarted it. Reading activeState alone would call this healthy.
    const result = serviceStatus.parse(asResults(['broken/crashloop.service_status']));

    expect(result.activeState).toBe('active');
    expect(result.restarts).toBe(4);
    expect(result.assessment).toContain('crash loop');
  });

  it('reports a masked unit as unable to start', () => {
    const result = serviceStatus.parse(asResults(['broken/redisdown.service_status']));

    expect(result.loadState).toBe('masked');
    expect(result.activeState).toBe('inactive');
    expect(result.mainPid).toBeUndefined();
    expect(result.assessment).toContain('masked');
  });

  it('omits MainPID 0 rather than reporting pid zero', () => {
    expect(
      serviceStatus.parse(asResults(['broken/redisdown.service_status'])).mainPid,
    ).toBeUndefined();
  });

  it('appends .service only when the unit has no suffix', () => {
    expect(serviceStatus.build({ host: 'h', unit: 'nginx' })[0]?.argv).toContain('nginx.service');
    expect(serviceStatus.build({ host: 'h', unit: 'nginx.service' })[0]?.argv).toContain(
      'nginx.service',
    );
    expect(serviceStatus.build({ host: 'h', unit: 'dwara.timer' })[0]?.argv).toContain(
      'dwara.timer',
    );
  });

  it('survives empty output', () => {
    expect(serviceStatus.parse(asResults([asResult('')])).exists).toBe(true);
  });
});

describe('tail_logs', () => {
  it('reads journal lines for a unit', () => {
    const raw = asResult(fixture('healthy/tail_logs.journal-unit'), {
      argv: ['journalctl', '-u', 'nginx.service'],
    });
    const result = tailLogs.parse([raw]);

    expect(result.source).toBe('journal');
    expect(result.target).toBe('nginx.service');
    expect(result.count).toBeGreaterThan(0);
    expect(result.lines[0]).toContain('Starting nginx.service');
  });

  it('reads a log file', () => {
    const raw = asResult(fixture('healthy/tail_logs.file'), {
      argv: ['tail', '-n', '20', '--', '/var/log/nginx/lab-api.access.log'],
    });
    const result = tailLogs.parse([raw]);

    expect(result.source).toBe('file');
    expect(result.target).toBe('/var/log/nginx/lab-api.access.log');
  });

  it('treats no grep matches as an answer, not an error', () => {
    // journalctl --grep exits 1 with no output when nothing matched, and "no
    // lines match" is frequently the useful finding.
    const result = tailLogs.parse([
      asResult('', { argv: ['journalctl', '--grep', 'nothing'], exitCode: 1 }),
    ]);

    expect(result.count).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('reports a real failure', () => {
    const result = tailLogs.parse([
      asResult('', { argv: ['journalctl'], exitCode: 1, stderr: 'Failed to open journal\n' }),
    ]);
    expect(result.error).toBe('Failed to open journal');
  });

  it('refuses a file outside /var/log', () => {
    // A tool whose job is "print the end of a file" is otherwise the easiest
    // route to /etc/shadow.
    expect(() =>
      tailLogs.build({ host: 'h', source: 'file', path: '/etc/shadow', lines: 10 }),
    ).toThrowError(/deny-list/);

    expect(() =>
      tailLogs.build({ host: 'h', source: 'file', path: '/etc/nginx/nginx.conf', lines: 10 }),
    ).toThrowError(/not in the allowed paths/);
  });

  it('refuses a traversal attempt before building a command', () => {
    expect(() =>
      tailLogs.build({ host: 'h', source: 'file', path: '/var/log/../etc/shadow', lines: 10 }),
    ).toThrowError(/must not contain/);
  });

  it('refuses a since value that is not a time spec', () => {
    expect(() =>
      tailLogs.build({ host: 'h', source: 'journal', lines: 10, since: '; rm -rf /' }),
    ).toThrowError(/not a time specification/);

    expect(() =>
      tailLogs.build({ host: 'h', source: 'journal', lines: 10, since: '-30min' }),
    ).not.toThrow();
  });

  it('passes grep through as an argument rather than a shell fragment', () => {
    const argv = tailLogs.build({ host: 'h', source: 'journal', lines: 10, grep: 'a|b' })[0]?.argv;
    expect(argv).toContain('--grep');
    expect(argv).toContain('a|b');
  });
});

describe('disk_usage', () => {
  it('reads a filesystem in bytes', () => {
    const result = diskUsage.parse(asResults(['healthy/disk_usage.df', 'healthy/disk_usage.du']));

    expect(result.filesystem).toMatchObject({
      filesystem: 'overlay',
      mountedOn: '/',
      usedPercent: 15,
    });
    expect(result.filesystem?.totalBytes).toBe(489634406400);
    expect(result.assessment).toContain('15% full');
  });

  it('lists children largest first and drops the directory itself', () => {
    const raws = [
      asResult(fixture('healthy/disk_usage.df')),
      asResult(fixture('healthy/disk_usage.du'), { argv: ['du', '-B1', '-d1', '--', '/var/log'] }),
    ];
    const result = diskUsage.parse(raws);

    expect(result.largestDirectories.map((entry) => entry.path)).toEqual([
      '/var/log/journal',
      '/var/log/nginx',
      '/var/log/private',
    ]);
    expect(result.largestDirectories[0]?.bytes).toBe(16777216);
  });

  it('calls a full filesystem full', () => {
    const result = diskUsage.parse(asResults(['broken/diskfull.df', 'broken/diskfull.du']));

    expect(result.filesystem?.usedPercent).toBe(100);
    expect(result.filesystem?.availableBytes).toBe(0);
    expect(result.assessment).toContain('completely full');
  });

  it('includes docker usage only when asked', () => {
    expect(diskUsage.build({ host: 'h', path: '/', includeDocker: false })).toHaveLength(2);
    expect(diskUsage.build({ host: 'h', path: '/', includeDocker: true })).toHaveLength(3);
  });

  it('parses docker usage rows', () => {
    const result = diskUsage.parse(
      asResults([
        'healthy/disk_usage.df',
        'healthy/disk_usage.du',
        'healthy/disk_usage.docker-json',
      ]),
    );

    expect(Array.isArray(result.docker)).toBe(true);
    expect(result.docker).toContainEqual({
      type: 'Images',
      total: 1,
      active: 1,
      size: '323.9MB',
      reclaimable: '0B (0%)',
    });
  });

  it('says docker is unavailable rather than reporting zero usage', () => {
    // Silently returning an empty list would tell the model this host has no
    // containers, which is a different and wrong conclusion.
    const result = diskUsage.parse([
      asResult(fixture('healthy/disk_usage.df')),
      asResult(fixture('healthy/disk_usage.du')),
      asResult('', { exitCode: 127, stderr: 'docker: command not found\n' }),
    ]);

    expect(result.docker).toEqual({ available: false, reason: 'docker: command not found' });
  });

  it('survives empty output', () => {
    const result = diskUsage.parse(asResults([asResult(''), asResult('')]));
    expect(result.filesystem).toBeUndefined();
    expect(result.assessment).toContain('could not read');
  });
});

describe('open_ports', () => {
  it('parses the default -tlnp shape, which has no protocol column', () => {
    // ss omits Netid when only one protocol is requested. The tool's default is
    // -tlnp, so this is the shape that actually matters; assuming the column was
    // always present shifted every field and produced ports with no number.
    const result = openPorts.parse(asResults(['healthy/open_ports.ss-tcp-only']));
    const https = result.ports.find((port) => port.port === 443);

    expect(https).toMatchObject({ protocol: 'tcp', state: 'LISTEN', address: '0.0.0.0' });
    expect(result.ports.every((port) => port.port !== undefined)).toBe(true);
  });

  it('builds the -tlnp form by default', () => {
    expect(openPorts.build({ host: 'h', listeningOnly: true })[0]?.argv).toContain('-tlnp');
    expect(openPorts.build({ host: 'h', listeningOnly: false })[0]?.argv).toContain('-tulnp');
  });

  it('parses listening sockets with their processes', () => {
    const result = openPorts.parse(asResults(['healthy/open_ports.ss']));
    const https = result.ports.find((port) => port.port === 443);

    expect(https).toMatchObject({ protocol: 'tcp', state: 'LISTEN', address: '0.0.0.0' });
    expect(https?.processes[0]?.name).toBe('nginx');
    expect(https?.processes[0]?.pids.length).toBeGreaterThan(1);
  });

  it('groups nine nginx workers into one entry listing their pids', () => {
    // The workers have distinct pids, so deduplicating by name and pid keeps all
    // nine. One row per program is what a reader wants; the pids are kept.
    const result = openPorts.parse(asResults(['healthy/open_ports.ss']));
    const https = result.ports.find((port) => port.port === 443);

    expect(https?.processes).toHaveLength(1);
    expect(https?.processes[0]?.pids).toHaveLength(9);
    expect(https?.processes[0]?.pids).toEqual(
      [...(https?.processes[0]?.pids ?? [])].sort((a, b) => a - b),
    );
  });

  it('distinguishes loopback from a socket reachable off-host', () => {
    const result = openPorts.parse([
      asResult(
        [
          'tcp LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1,fd=1))',
          'tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=2,fd=2))',
          'tcp LISTEN 0 128 [::1]:5432 [::]:* users:(("postgres",pid=3,fd=3))',
        ].join('\n'),
      ),
    ]);

    expect(result.ports.find((p) => p.port === 3000)?.processes[0]?.pids).toEqual([1]);
    expect(result.ports.find((p) => p.port === 3000)?.exposed).toBe(false);
    expect(result.ports.find((p) => p.port === 443)?.exposed).toBe(true);
    expect(result.ports.find((p) => p.port === 5432)?.exposed).toBe(false);
    expect(result.exposedCount).toBe(1);
  });

  it('splits an IPv6 address on the last colon', () => {
    const result = openPorts.parse([asResult('tcp LISTEN 0 128 [::]:22 [::]:*')]);
    expect(result.ports[0]).toMatchObject({ address: '[::]', port: 22 });
  });

  it('keeps a socket with no owning process', () => {
    // -p shows nothing for a socket owned by another namespace; the port is
    // still listening and still worth reporting.
    const result = openPorts.parse([asResult('tcp LISTEN 0 4096 127.0.0.11:45677 0.0.0.0:*')]);
    expect(result.ports[0]?.processes).toEqual([]);
  });

  it('survives empty output', () => {
    expect(openPorts.parse(asResults([asResult('')])).ports).toEqual([]);
  });
});
