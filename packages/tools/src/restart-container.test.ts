import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand, SnapshotRef } from '@dwara/core';
import {
  PROTECTED_CONTAINERS,
  createRestartContainer,
  restartContainer,
} from './restart-container.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

function ctxWith(respond: (command: RemoteCommand, nth: number) => Partial<RawResult>): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-staging',
    sessionId: 's_test',
    httpChecks: [],
    async run(command) {
      const nth = calls.length;
      calls.push(command);
      return {
        argv: command.argv,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        ...respond(command, nth),
      };
    },
  };
}

/** A line in the format the tool and the snapshot manager both use. */
function line(over: Partial<Record<'running' | 'status' | 'restarts', string>> = {}): string {
  return `/lab-app|${over.running ?? 'true'}|${over.status ?? 'running'}|${over.restarts ?? '0'}|dwara-lab-app:dev`;
}

describe('restart_container shape', () => {
  it('is reversible and carries the machinery the registry demands', () => {
    expect(restartContainer.risk).toBe('reversible');
    expect(restartContainer.verify).toBeTypeOf('function');
    expect(restartContainer.rollback).toBeTypeOf('function');
    expect(restartContainer.build).toBeUndefined();
  });

  it('snapshots the container and no files, because a restart writes nothing', () => {
    expect(restartContainer.snapshot?.({ host: 'lab-staging', container: 'lab-app' })).toEqual({
      paths: [],
      containers: ['lab-app'],
    });
  });

  it('never uses sudo, because docker group membership already carries it', async () => {
    const ctx = ctxWith(() => ({ stdout: line() }));
    await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx);

    expect(ctx.calls.every((call) => call.sudo === undefined)).toBe(true);
    expect(ctx.calls.map((call) => call.argv.slice(0, 2))).toEqual([
      ['docker', 'inspect'],
      ['docker', 'restart'],
      ['docker', 'inspect'],
    ]);
  });

  it('passes the name after --, so a name cannot be read as an option', async () => {
    const ctx = ctxWith(() => ({ stdout: line() }));
    await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx);

    expect(ctx.calls[1]?.argv).toEqual(['docker', 'restart', '--', 'lab-app']);
  });
});

describe('restart_container name guarding', () => {
  it('refuses a name that is not a container name', async () => {
    const ctx = ctxWith(() => ({}));

    for (const bad of ['--force', 'a b', '../x', '-rm', '']) {
      await expect(
        restartContainer.apply({ host: 'lab-staging', container: bad }, ctx),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    }
    expect(ctx.calls).toHaveLength(0);
  });

  it('refuses the containers that carry Dwara its own connection', async () => {
    const ctx = ctxWith(() => ({}));

    for (const name of PROTECTED_CONTAINERS) {
      await expect(
        restartContainer.apply({ host: 'lab-staging', container: name }, ctx),
      ).rejects.toThrowError(/will not restart/);
    }
  });

  it('accepts ordinary names, including ids and dotted ones', async () => {
    const ctx = ctxWith(() => ({ stdout: line() }));

    for (const name of ['lab-app', 'a1b2c3d4e5f6', 'web.1', 'my_worker']) {
      await expect(
        restartContainer.apply({ host: 'lab-staging', container: name }, ctx),
      ).resolves.toBeDefined();
    }
  });
});

describe('restart_container parsing', () => {
  it('reports what changed, trimming the leading slash from the name', async () => {
    const ctx = ctxWith((_command, nth) => ({
      stdout: nth === 0 ? line({ running: 'false', status: 'exited' }) : line(),
    }));
    const result = restartContainer.parse(
      await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx),
    );

    expect(result).toMatchObject({
      container: 'lab-app',
      image: 'dwara-lab-app:dev',
      before: { running: false, status: 'exited' },
      after: { running: true, status: 'running', restartCount: 0 },
      restarted: true,
      assessment: 'was exited, now running',
    });
  });

  it('calls out a climbing restart count, which reads as running at a glance', async () => {
    // Docker reports "running" most instants you look at a looping container,
    // because it has just been started again.
    const ctx = ctxWith((_command, nth) => ({
      stdout: nth === 2 ? line({ restarts: '6' }) : line({ restarts: '1' }),
    }));
    const result = restartContainer.parse(
      await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx),
    );

    expect(result.assessment).toContain('restart count went from 1 to 6');
    expect(result.assessment).toContain('loop');
  });

  it('carries docker its own words when it refuses', async () => {
    const ctx = ctxWith((command) =>
      command.argv[1] === 'restart'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such container: lab-app' }
        : { stdout: line() },
    );
    const result = restartContainer.parse(
      await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx),
    );

    expect(result.restarted).toBe(false);
    expect(result.error).toContain('No such container');
    expect(result.assessment).toBe('docker refused the restart; the container is as it was');
  });

  it('does not call a container that came back stopped a success', async () => {
    const ctx = ctxWith((_command, nth) => ({
      stdout: nth === 2 ? line({ running: 'false', status: 'exited' }) : line(),
    }));
    const result = restartContainer.parse(
      await restartContainer.apply({ host: 'lab-staging', container: 'lab-app' }, ctx),
    );

    expect(result.assessment).toBe('came back exited; read its logs for the reason');
  });
});

describe('restart_container rollback', () => {
  function snapshot(running: boolean): SnapshotRef {
    return {
      id: 'snap_0a1b2c3d',
      host: 'lab-staging',
      createdAt: '2026-09-28T00:00:00.000Z',
      paths: [],
      hashes: {},
      containers: {
        'lab-app': {
          running,
          status: running ? 'running' : 'exited',
          restartCount: 0,
          image: 'dwara-lab-app:dev',
        },
      },
    };
  }

  it('starts a container that was up before', () => {
    expect(restartContainer.rollback?.(snapshot(true))).toEqual([
      { argv: ['docker', 'start', '--', 'lab-app'], timeoutMs: 45_000 },
    ]);
  });

  it('stops a container that was down before', () => {
    // Restarting a stopped container leaves it running, so putting the host
    // back means stopping it again.
    expect(restartContainer.rollback?.(snapshot(false))?.[0]?.argv[1]).toBe('stop');
  });

  it('has nothing to do for a snapshot that recorded no containers', () => {
    expect(restartContainer.rollback?.({ ...snapshot(true), containers: undefined })).toEqual([]);
  });
});

describe('createRestartContainer', () => {
  it('lets the integration suite shorten the restart timeout', async () => {
    const quick = createRestartContainer({ restartTimeoutMs: 3_000 });
    const ctx = ctxWith(() => ({ stdout: line() }));
    await quick.apply({ host: 'lab-staging', container: 'lab-app' }, ctx);

    expect(ctx.calls[1]?.timeoutMs).toBe(3_000);
    expect(ctx.calls[0]?.timeoutMs).toBe(20_000);
  });
});
