import { describe, expect, it } from 'vitest';
import { asResult, asResults, fixture } from './fixtures.js';
import { dockerPs, type Container, type DockerPs } from './docker-ps.js';
import { containerLogs } from './container-logs.js';
import { containerInspect } from './container-inspect.js';
import { certExpiry } from './cert-expiry.js';
import { readConfig } from './read-config.js';
import { securityAudit } from './security-audit.js';
import { createRegistry } from './index.js';

/**
 * Narrows the containers union on its discriminant.
 *
 * `containers` is either a list or an explicit "docker is unavailable", and a
 * cast would hide the case where a test accidentally got the latter.
 */
function containersOf(result: DockerPs): readonly Container[] {
  const { containers } = result;
  if ('available' in containers) throw new Error(`expected containers, got: ${containers.reason}`);
  return containers;
}

describe('docker_ps', () => {
  it('parses running containers', () => {
    const containers = containersOf(dockerPs.parse(asResults(['healthy/docker_ps.json'])));

    expect(containers).toHaveLength(1);
    expect(containers[0]).toMatchObject({
      name: 'lab-app',
      image: 'dwara-lab-app:dev',
      running: true,
    });
    // --no-trunc, so the id can be handed to container_inspect unchanged.
    expect(containers[0]?.id).toHaveLength(64);
  });

  it('strips the quotes docker puts around the command', () => {
    const containers = containersOf(dockerPs.parse(asResults(['healthy/docker_ps.json'])));
    expect(containers[0]?.command.startsWith('"')).toBe(false);
  });

  it('does not call an empty list a healthy host', () => {
    // The captured fixture is empty because the container was between restarts.
    const result = dockerPs.parse(asResults(['broken/crashloop.docker_ps']));

    expect(result.containers).toEqual([]);
    expect(result.assessment).toContain('between restarts');
  });

  it('never puts a tab in an argument, which the transport would refuse', () => {
    // The tab-delimited --format template made this tool impossible to call:
    // the transport rejects control characters in arguments, by design.
    for (const arg of dockerPs.build({ host: 'h', all: true })[0]?.argv ?? []) {
      expect(arg).not.toContain('\t');
    }
    expect(dockerPs.build({ host: 'h', all: true })[0]?.argv).toContain('{{json .}}');
  });

  it("uses docker's own state word rather than inferring from status text", () => {
    const containers = containersOf(dockerPs.parse(asResults(['healthy/docker_ps.json'])));
    expect(containers[0]?.state).toBe('running');
  });

  it('reads an exit code out of the status text', () => {
    const result = dockerPs.parse([
      asResult(
        JSON.stringify({
          ID: 'abc',
          Image: 'image',
          Command: '"cmd"',
          CreatedAt: '2026-09-28',
          Status: 'Exited (137) 2 minutes ago',
          State: 'exited',
          Ports: '',
          Names: 'lab-app',
        }),
      ),
    ]);
    expect(containersOf(result)[0]).toMatchObject({ exitCode: 137, running: false });
    expect(result.assessment).toContain('not running');
  });

  it('flags a container that started seconds ago', () => {
    const result = dockerPs.parse([
      asResult(
        JSON.stringify({ ID: 'abc', Status: 'Up 1 second', State: 'running', Names: 'lab-app' }),
      ),
    ]);
    expect(result.assessment).toContain('keeps restarting');
  });

  it('flags one that is restarting right now', () => {
    const result = dockerPs.parse([
      asResult(
        JSON.stringify({
          ID: 'abc',
          Status: 'Restarting (1) 3 seconds ago',
          State: 'restarting',
          Names: 'lab-app',
        }),
      ),
    ]);
    expect(result.assessment).toContain('restarting now');
  });

  it('says docker is unavailable rather than reporting no containers', () => {
    const result = dockerPs.parse([
      asResult('', { exitCode: 127, stderr: 'docker: command not found\n' }),
    ]);

    expect(result.containers).toMatchObject({ available: false });
    expect(result.assessment).toContain('not usable');
  });
});

describe('container_logs', () => {
  it('reads log lines', () => {
    const raw = asResult(fixture('healthy/container_logs.app'), {
      argv: ['docker', 'logs', '--tail', '20', 'lab-app'],
    });
    const result = containerLogs.parse([raw]);

    expect(result.container).toBe('lab-app');
    expect(result.count).toBeGreaterThan(0);
  });

  it('merges stderr, where the fatal error usually is', () => {
    // docker logs writes the container's stderr to ours. Dropping it would hide
    // exactly the line that explains a crash.
    const result = containerLogs.parse([
      asResult('2026-09-28T05:00:00Z ordinary line\n', {
        argv: ['docker', 'logs', 'lab-app'],
        stderr: '2026-09-28T05:00:01Z ERROR database unreachable\n',
      }),
    ]);

    expect(result.count).toBe(2);
    expect(result.lines.join('\n')).toContain('database unreachable');
  });

  it('reports a missing container', () => {
    const result = containerLogs.parse([
      asResult('', {
        argv: ['docker', 'logs', 'gone'],
        exitCode: 1,
        stderr: 'Error: No such container: gone\n',
      }),
    ]);

    expect(result.error).toContain('No such container');
    expect(result.lines).toEqual([]);
  });

  it('rejects a since value that is not a duration', () => {
    expect(
      containerLogs.input.safeParse({ host: 'h', container: 'c', since: 'yesterday' }).success,
    ).toBe(false);
    expect(containerLogs.input.safeParse({ host: 'h', container: 'c', since: '30m' }).success).toBe(
      true,
    );
  });
});

describe('container_inspect', () => {
  const detail = () => containerInspect.parse(asResults(['healthy/container_inspect.app']));

  it('summarises rather than returning the whole document', () => {
    const result = detail();

    expect(result.name).toBe('lab-app');
    expect(result.state.running).toBe(true);
    expect(result.networkMode).toBe('host');
    // A summary, not thousands of lines of defaults.
    expect(Object.keys(result).length).toBeLessThan(20);
  });

  it('keeps the environment, where a wrong connection target shows up', () => {
    const result = detail();
    expect(result.env.join('\n')).toContain('DATABASE_URL');
  });

  it('calls out an OOM kill, which the logs will never mention', () => {
    const result = containerInspect.parse([
      asResult(
        JSON.stringify([
          {
            Id: 'abc',
            Name: '/lab-app',
            State: { Status: 'exited', Running: false, OOMKilled: true, ExitCode: 137 },
            RestartCount: 0,
            HostConfig: { RestartPolicy: { Name: 'always' } },
            Config: { Image: 'app' },
          },
        ]),
      ),
    ]);

    expect(result.state.oomKilled).toBe(true);
    expect(result.assessment).toContain('memory limit');
  });

  it('explains exit code 137 when it is not flagged as an OOM kill', () => {
    const result = containerInspect.parse([
      asResult(
        JSON.stringify([
          {
            Id: 'abc',
            Name: '/x',
            State: { Status: 'exited', Running: false, ExitCode: 137 },
            HostConfig: {},
            Config: {},
          },
        ]),
      ),
    ]);
    expect(result.assessment).toContain('SIGKILL');
  });

  it('calls a high restart count under an always policy a crash loop', () => {
    const result = containerInspect.parse([
      asResult(
        JSON.stringify([
          {
            Id: 'abc',
            Name: '/x',
            State: { Status: 'running', Running: true },
            RestartCount: 12,
            HostConfig: { RestartPolicy: { Name: 'always' } },
            Config: {},
          },
        ]),
      ),
    ]);
    expect(result.assessment).toContain('crash loop');
  });

  it('reports an unhealthy health check on a running container', () => {
    const result = containerInspect.parse([
      asResult(
        JSON.stringify([
          {
            Id: 'abc',
            Name: '/x',
            State: {
              Status: 'running',
              Running: true,
              Health: { Status: 'unhealthy', FailingStreak: 4 },
            },
            HostConfig: {},
            Config: {},
          },
        ]),
      ),
    ]);

    expect(result.health).toEqual({ status: 'unhealthy', failingStreak: 4 });
    expect(result.assessment).toContain('health check is failing');
  });

  it('handles output that is not JSON', () => {
    const result = containerInspect.parse([asResult('not json at all')]);
    expect(result.error).toContain('did not return JSON');
  });

  it('handles an empty array', () => {
    expect(containerInspect.parse([asResult('[]')]).error).toBe('no such container');
  });
});

describe('cert_expiry', () => {
  it('reads the certificate the lab actually serves', () => {
    const raw = asResult(fixture('healthy/cert_expiry.pem'), {
      argv: ['openssl', 's_client', '-connect', '127.0.0.1:443', '-showcerts'],
    });
    const result = certExpiry.parse([raw]);

    expect(result.endpoint).toBe('127.0.0.1:443');
    expect(result.certificate?.subject).toContain('lab-api');
    expect(result.certificate?.selfSigned).toBe(true);
    expect(typeof result.certificate?.daysRemaining).toBe('number');
  });

  it('reports a handshake that produced no certificate', () => {
    const result = certExpiry.parse([
      asResult('', {
        argv: ['openssl', 's_client', '-connect', '127.0.0.1:443'],
        exitCode: 1,
        stderr: 'connect: Connection refused\n',
      }),
    ]);

    expect(result.certificate).toBeUndefined();
    expect(result.error).toContain('Connection refused');
  });

  it('handles a PEM block that is not a certificate', () => {
    const result = certExpiry.parse([
      asResult('-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n'),
    ]);
    expect(result.certificate).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('builds one command with an argument vector, not a shell pipeline', () => {
    const commands = certExpiry.build({ host: 'h', port: 8443, target: '127.0.0.1' });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toContain('-showcerts');
    expect(commands[0]?.argv).toContain('127.0.0.1:8443');
    expect(commands[0]?.argv.join(' ')).not.toContain('|');
    // s_client waits on stdin for data to forward; an empty stdin makes it exit.
    expect(commands[0]?.stdin).toBe('');
  });
});

describe('read_config', () => {
  it('reads an allowed file', () => {
    const result = readConfig.parse([
      asResult('/etc/nginx/sites-available/lab-api\n'),
      asResult(fixture('healthy/read_config.nginx-site'), {
        argv: ['find', '/etc/nginx/sites-available/lab-api'],
      }),
    ]);

    expect(result.content).toContain('proxy_pass');
    expect(result.lineCount).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it('refuses a denied path before building any command', () => {
    // Nothing is sent to the host: the refusal is lexical.
    expect(() =>
      readConfig.build({ host: 'h', path: '/etc/shadow', extraAllowed: [] }),
    ).toThrowError(/deny-list/);
    expect(() =>
      readConfig.build({ host: 'h', path: '/home/dwara/.ssh/id_ed25519', extraAllowed: [] }),
    ).toThrowError(/deny-list/);
    expect(() => readConfig.build({ host: 'h', path: '/app/.env', extraAllowed: [] })).toThrowError(
      /deny-list/,
    );
  });

  it('refuses traversal', () => {
    // A captured fixture shows readlink -f /etc/nginx/../shadow resolving to
    // /etc/shadow on a real host, so this must be caught before the read.
    expect(() =>
      readConfig.build({ host: 'h', path: '/etc/nginx/../shadow', extraAllowed: [] }),
    ).toThrowError(/must not contain/);
  });

  it('refuses a path on neither list', () => {
    expect(() =>
      readConfig.build({ host: 'h', path: '/opt/app/config.yml', extraAllowed: [] }),
    ).toThrowError(/not in the allowed paths/);
  });

  it('accepts a path the policy added', () => {
    expect(() =>
      readConfig.build({ host: 'h', path: '/opt/app/config.yml', extraAllowed: ['/opt/app/**'] }),
    ).not.toThrow();
  });

  it('never lets policy override the deny-list', () => {
    // The whole point of the two lists having different standing.
    expect(() =>
      readConfig.build({
        host: 'h',
        path: '/etc/shadow',
        extraAllowed: ['/etc/**', '/etc/shadow'],
      }),
    ).toThrowError(/deny-list/);
  });

  it('asks the host not to follow a symlink standing in for the file', () => {
    const argv = readConfig.build({
      host: 'h',
      path: '/etc/nginx/nginx.conf',
      extraAllowed: [],
    })[1]?.argv;

    expect(argv).toContain('!');
    expect(argv).toContain('-type');
    expect(argv).toContain('l');
  });

  it('withholds content when the host resolved the path somewhere denied', () => {
    // A symlink higher up the tree can land inside an allowed directory.
    const result = readConfig.parse([
      asResult('/etc/shadow\n'),
      asResult('root:$6$hash:19000:0:99999:7:::\n', { argv: ['find', '/etc/nginx/conf.d/evil'] }),
    ]);

    expect(result.content).toBe('');
    expect(result.error).toContain('deny-list');
    expect(result.error).toContain('contents withheld');
  });

  it('explains an empty read caused by a symlink', () => {
    const result = readConfig.parse([
      asResult('/etc/nginx/sites-available/lab-api\n'),
      asResult('', { argv: ['find', '/etc/nginx/sites-enabled/lab-api'] }),
    ]);

    expect(result.error).toContain('is a symlink to');
  });

  it('reports a missing file', () => {
    const result = readConfig.parse([
      asResult('/etc/nginx/nope\n'),
      asResult('', { argv: ['find', '/etc/nginx/nope'] }),
    ]);
    expect(result.error).toContain('no such file');
  });
});

describe('security_audit', () => {
  const healthy = () =>
    securityAudit.parse(
      asResults([
        'healthy/security_audit.sshd',
        'healthy/security_audit.listening',
        'healthy/security_audit.world-writable',
        'healthy/security_audit.updates',
      ]),
    );

  it('finds nothing high-severity on the hardened lab host', () => {
    const result = healthy();
    expect(result.counts.high).toBe(0);
    expect(result.findings.some((f) => f.check === 'sshd.PermitRootLogin')).toBe(false);
  });

  it('reports sockets listening beyond loopback as information, not a fault', () => {
    // Whether it matters depends on the network in front of the host, which
    // Dwara cannot see.
    const exposed = healthy().findings.find((f) => f.check === 'exposed-sockets');
    expect(exposed?.severity).toBe('info');
  });

  it('flags root login and password authentication', () => {
    const result = securityAudit.parse([
      asResult('permitrootlogin yes\npasswordauthentication yes\npermitemptypasswords yes\n'),
      asResult(''),
      asResult(''),
      asResult('Listing...\n'),
    ]);

    const checks = result.findings.map((f) => f.check);
    expect(checks).toContain('sshd.PermitRootLogin');
    expect(checks).toContain('sshd.PasswordAuthentication');
    expect(checks).toContain('sshd.PermitEmptyPasswords');
    expect(result.counts.high).toBe(2);
  });

  it('flags world-writable files under /etc', () => {
    const result = securityAudit.parse([
      asResult('permitrootlogin no\n'),
      asResult(''),
      asResult('/etc/cron.d/backup\n/etc/app.conf\n'),
      asResult('Listing...\n'),
    ]);

    const finding = result.findings.find((f) => f.check === 'world-writable');
    expect(finding?.severity).toBe('high');
    expect(finding?.detail).toContain('/etc/cron.d/backup');
  });

  it('counts pending updates without treating the apt header as one', () => {
    const result = securityAudit.parse([
      asResult('permitrootlogin no\n'),
      asResult(''),
      asResult(''),
      asResult(
        'Listing...\nnginx/noble 1.24.0-2ubuntu7.4 amd64 [upgradable from: 1.24.0-2ubuntu7]\n',
      ),
    ]);

    expect(result.findings.find((f) => f.check === 'pending-updates')?.detail).toContain(
      '1 package',
    );
  });

  it('reports a check it could not run instead of passing it silently', () => {
    // A report that quietly skips a check reads as a clean host.
    const result = securityAudit.parse([
      asResult('', { exitCode: 1, stderr: 'sudo: a password is required\n' }),
      asResult(''),
      asResult(''),
      asResult('Listing...\n'),
    ]);

    expect(result.skipped).toEqual([{ check: 'sshd', reason: 'sudo: a password is required' }]);
    expect(result.assessment).toContain('not a full picture');
  });
});

describe('the registry', () => {
  it('holds the eleven read tools and the mutating ones', () => {
    const registry = createRegistry();

    expect(registry.byRisk('read' as never)).toHaveLength(11);
    expect(registry.byRisk('reversible' as never).map((tool) => tool.name)).toEqual([
      'restart_service',
    ]);
    expect(registry.size).toBe(12);
  });

  it('prefixes every tool name with its risk class', () => {
    // Client permission rules match on the prefix, so it has to be there, and
    // it has to come from the declared risk rather than from a hand-typed name.
    for (const tool of createRegistry().list()) {
      expect(tool.mcpName, tool.name).toBe(`${tool.risk}_${tool.name}`);
    }
    expect(createRegistry().get('restart_service')?.mcpName).toBe('reversible_restart_service');
  });

  it('gives every mutating tool the machinery it cannot be registered without', () => {
    for (const tool of createRegistry().list()) {
      if (!tool.mutates) continue;
      expect(tool.snapshot({ host: 'h', unit: 'nginx' }), tool.name).toBeDefined();
      expect(tool.rollback, tool.name).toBeTypeOf('function');
    }
  });

  it('gives every tool a description written for a model', () => {
    for (const tool of createRegistry().list()) {
      // Long enough to say when to use it and what to check next, not a label.
      expect(tool.description.length, tool.name).toBeGreaterThan(200);
      expect(tool.description, tool.name).toMatch(/\n/);
    }
  });

  it('requires a host on every tool', () => {
    for (const tool of createRegistry().list()) {
      expect(tool.validate({}).ok, tool.name).toBe(false);
    }
  });
});
