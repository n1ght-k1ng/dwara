import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand, SnapshotRef } from '@dwara/core';
import { PROTECTED_UNITS, createRestartService, restartService } from './restart-service.js';

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

/** systemctl show output in the order a real host answers, not the asked order. */
function unit(fields: Record<string, string>): string {
  return Object.entries({ NRestarts: '0', Result: 'success', MainPID: '0', ...fields })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

const ACTIVE = unit({
  Id: 'nginx.service',
  ActiveState: 'active',
  SubState: 'running',
  MainPID: '412',
});
const INACTIVE = unit({ Id: 'nginx.service', ActiveState: 'inactive', SubState: 'dead' });

describe('restart_service shape', () => {
  it('is reversible and carries the machinery the registry demands', () => {
    expect(restartService.risk).toBe('reversible');
    expect(restartService.snapshot).toBeTypeOf('function');
    expect(restartService.verify).toBeTypeOf('function');
    expect(restartService.rollback).toBeTypeOf('function');
    // Staged, not built: the "before" reading has to be taken while it is true.
    expect(restartService.build).toBeUndefined();
  });

  it('snapshots the unit and no files, because a restart writes nothing', () => {
    expect(restartService.snapshot?.({ host: 'lab-staging', unit: 'nginx' })).toEqual({
      paths: [],
      units: ['nginx.service'],
    });
  });

  it('adds the .service suffix but leaves other unit types alone', () => {
    expect(restartService.snapshot?.({ host: 'h', unit: 'dwara.timer' })?.units).toEqual([
      'dwara.timer',
    ]);
  });
});

describe('restart_service protected units', () => {
  it('refuses the connection it would need to recover', async () => {
    const ctx = ctxWith(() => ({}));

    await expect(
      restartService.apply({ host: 'lab-staging', unit: 'ssh' }, ctx),
    ).rejects.toThrowError(/will not restart ssh\.service/);
    // Nothing reached the host.
    expect(ctx.calls).toHaveLength(0);
  });

  it('refuses every unit on the list, suffix or not', async () => {
    const ctx = ctxWith(() => ({}));

    for (const bare of PROTECTED_UNITS) {
      await expect(
        restartService.apply({ host: 'lab-staging', unit: bare }, ctx),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
      await expect(
        restartService.apply({ host: 'lab-staging', unit: `${bare}.service` }, ctx),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    }
  });

  it('explains why, differently for the lifeline and for the rest', async () => {
    const ctx = ctxWith(() => ({}));

    await expect(restartService.apply({ host: 'h', unit: 'sshd' }, ctx)).rejects.toMatchObject({
      hint: expect.stringContaining('connection Dwara reaches the host through') as unknown,
    });
    await expect(
      restartService.apply({ host: 'h', unit: 'systemd-journald' }, ctx),
    ).rejects.toMatchObject({
      hint: expect.stringContaining('takes systemd or the logs with it') as unknown,
    });
  });

  it('allows an ordinary unit through', async () => {
    const ctx = ctxWith(() => ({ stdout: ACTIVE }));
    await restartService.apply({ host: 'lab-staging', unit: 'nginx' }, ctx);

    expect(ctx.calls.map((call) => call.argv.slice(0, 2))).toEqual([
      ['systemctl', 'show'],
      ['systemctl', 'restart'],
      ['systemctl', 'show'],
    ]);
    expect(ctx.calls.every((call) => call.sudo === true)).toBe(true);
  });
});

describe('restart_service parsing', () => {
  it('reports what changed across the restart', async () => {
    const ctx = ctxWith((_command, nth) => ({ stdout: nth === 0 ? INACTIVE : ACTIVE }));
    const raws = await restartService.apply({ host: 'lab-staging', unit: 'nginx' }, ctx);
    const result = restartService.parse(raws);

    expect(result).toMatchObject({
      unit: 'nginx.service',
      before: { activeState: 'inactive', subState: 'dead', mainPid: undefined },
      after: { activeState: 'active', subState: 'running', mainPid: 412 },
      restarted: true,
      assessment: 'was inactive, now running',
    });
  });

  it('carries systemd its own words when it refuses the restart', async () => {
    const ctx = ctxWith((command) =>
      command.argv[1] === 'restart'
        ? { exitCode: 1, stderr: 'Job for nginx.service failed. See "systemctl status nginx".' }
        : { stdout: unit({ Id: 'nginx.service', ActiveState: 'failed', SubState: 'failed' }) },
    );
    const result = restartService.parse(
      await restartService.apply({ host: 'lab-staging', unit: 'nginx' }, ctx),
    );

    expect(result.restarted).toBe(false);
    expect(result.error).toContain('Job for nginx.service failed');
    expect(result.assessment).toBe('systemd refused the restart; the unit is as it was');
  });

  it('does not call a still-starting unit running', async () => {
    const ctx = ctxWith((_command, nth) => ({
      stdout:
        nth === 2
          ? unit({ Id: 'nginx.service', ActiveState: 'activating', SubState: 'start' })
          : ACTIVE,
    }));
    const result = restartService.parse(
      await restartService.apply({ host: 'lab-staging', unit: 'nginx' }, ctx),
    );

    expect(result.assessment).toBe('still starting up when last checked');
  });
});

describe('restart_service rollback', () => {
  function snapshot(activeState: string): SnapshotRef {
    return {
      id: 'snap_0a1b2c3d',
      host: 'lab-staging',
      createdAt: '2026-09-28T00:00:00.000Z',
      paths: [],
      hashes: {},
      units: { 'nginx.service': { activeState, unitFileState: 'enabled', restarts: 0 } },
    };
  }

  it('clears the failure state before starting a unit that was running', () => {
    expect(restartService.rollback?.(snapshot('active'))).toEqual([
      { argv: ['systemctl', 'reset-failed', 'nginx.service'], sudo: true, timeoutMs: 20_000 },
      { argv: ['systemctl', 'start', 'nginx.service'], sudo: true, timeoutMs: 45_000 },
    ]);
  });

  it('stops a unit that was not running before, and clears the failure first', () => {
    // Two things that are easy to get wrong together. Restarting an inactive
    // unit leaves it running, so putting the host back means stopping it again
    // -- and `systemctl stop` on a unit that crashed leaves ActiveState=failed
    // rather than inactive, so without reset-failed the unit never matches what
    // the snapshot recorded and sits in host_overview's failed list for good.
    expect(restartService.rollback?.(snapshot('inactive'))?.map((c) => c.argv[1])).toEqual([
      'reset-failed',
      'stop',
    ]);
  });

  it('treats a unit that was mid-start as one that should be running', () => {
    expect(restartService.rollback?.(snapshot('activating'))?.[1]?.argv[1]).toBe('start');
  });

  it('has nothing to do for a snapshot that recorded no units', () => {
    expect(restartService.rollback?.({ ...snapshot('active'), units: undefined })).toEqual([]);
  });
});

describe('createRestartService', () => {
  it('lets the integration suite shorten the restart timeout', async () => {
    const quick = createRestartService({ restartTimeoutMs: 3_000 });
    const ctx = ctxWith(() => ({ stdout: ACTIVE }));
    await quick.apply({ host: 'lab-staging', unit: 'nginx' }, ctx);

    expect(ctx.calls[1]?.timeoutMs).toBe(3_000);
    // Reads are unaffected; only the restart can legitimately take a while.
    expect(ctx.calls[0]?.timeoutMs).toBe(20_000);
  });
});
