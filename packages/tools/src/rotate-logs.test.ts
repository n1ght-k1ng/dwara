import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand } from '@dwara/core';
import { createRotateLogs, rotateLogs } from './rotate-logs.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

function ctxWith(respond: (command: RemoteCommand, nth: number) => Partial<RawResult>): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-api',
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

const BIG = '/var/log/lab-api/debug.log';

/** A host whose files shrink to zero once truncate has run. */
function host(options: { sizes?: Record<string, number>; failTruncate?: boolean } = {}): FakeCtx {
  const sizes = { ...(options.sizes ?? { [BIG]: 134_217_728 }) };
  let truncated = false;

  return ctxWith((command) => {
    const [program] = command.argv;

    if (program === 'truncate') {
      if (options.failTruncate === true) {
        return { exitCode: 1, stderr: 'truncate: cannot open: Read-only file system' };
      }
      truncated = true;
      return {};
    }
    if (program === 'stat') {
      const lines = Object.entries(sizes).map(
        ([path, bytes]) => `${truncated ? 0 : bytes}|${path}`,
      );
      return { stdout: `${lines.join('\n')}\n` };
    }
    if (program === 'df') {
      return { stdout: `Use%\n ${truncated ? '21' : '100'}%\n` };
    }
    if (program === 'journalctl') {
      if (command.argv[1]?.startsWith('--vacuum') === true) {
        truncated = true;
        return {};
      }
      return {
        stdout: `Archived and active journals take up ${truncated ? '180' : '900'}M in the file system.`,
      };
    }
    return {};
  });
}

describe('rotate_logs shape', () => {
  it('is reversible, declares itself unrestorable, and carries the machinery', () => {
    expect(rotateLogs.risk).toBe('reversible');
    // The honest part: you cannot back up what you are deleting onto the
    // filesystem you are emptying, so the pipeline must not claim otherwise.
    expect(rotateLogs.restorable).toBe(false);
    expect(rotateLogs.snapshot).toBeTypeOf('function');
    expect(rotateLogs.verify).toBeTypeOf('function');
    expect(rotateLogs.rollback).toBeTypeOf('function');
  });

  it('snapshots no files, because copying them is the impossible part', () => {
    expect(
      rotateLogs.snapshot?.({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }),
    ).toEqual({ paths: [] });
    expect(
      rotateLogs.rollback?.({
        id: 'snap_0a1b2c3d',
        host: 'h',
        createdAt: '',
        paths: [],
        hashes: {},
      }),
    ).toEqual([]);
  });

  it('insists on being told what to free', () => {
    const empty = rotateLogs.input.safeParse({ host: 'h' });

    expect(empty.success).toBe(false);
    expect(rotateLogs.input.safeParse({ host: 'h', journal: true }).success).toBe(true);
    expect(rotateLogs.input.safeParse({ host: 'h', paths: [BIG] }).success).toBe(true);
  });
});

describe('rotate_logs path guarding', () => {
  it('refuses anything outside /var/log', async () => {
    const ctx = host();

    for (const path of [
      '/etc/passwd',
      '/var/lib/thing.log',
      '/var/log/../etc/shadow',
      'relative.log',
    ]) {
      await expect(
        rotateLogs.apply({ host: 'h', paths: [path], journal: false, journalKeepMb: 200 }, ctx),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    }
    expect(ctx.calls).toHaveLength(0);
  });

  it('accepts a real log path', async () => {
    await expect(
      rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, host()),
    ).resolves.toBeDefined();
  });
});

describe('rotate_logs behaviour', () => {
  it('truncates rather than deleting, so the writer keeps its inode', async () => {
    const ctx = host();
    await rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, ctx);
    const write = ctx.calls.find((call) => call.argv[0] === 'truncate');

    // Deleting instead would leave the process appending to an unlinked inode:
    // the space would not come back until it restarted, while df said nothing
    // had changed and every report said the fix worked.
    expect(write?.argv).toEqual(['truncate', '-s', '0', '--', BIG]);
    expect(ctx.calls.some((call) => call.argv[0] === 'rm')).toBe(false);
  });

  it('measures before and after, and reports what it freed', async () => {
    const ctx = host();
    const result = rotateLogs.parse(
      await rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, ctx),
    );

    expect(result.files).toEqual([
      { path: BIG, bytesBefore: 134_217_728, bytesAfter: 0, freedBytes: 134_217_728 },
    ]);
    expect(result.freePercentBefore).toBe(0);
    expect(result.freePercentAfter).toBe(79);
    expect(result.assessment).toBe('freed about 128 MB; the filesystem is now 21% used');
  });

  it('one truncate per file, so the sudoers rule can pin the directory', async () => {
    const paths = ['/var/log/a.log', '/var/log/b.log'];
    const ctx = host({ sizes: { '/var/log/a.log': 100, '/var/log/b.log': 200 } });
    await rotateLogs.apply({ host: 'h', paths, journal: false, journalKeepMb: 200 }, ctx);

    expect(ctx.calls.filter((call) => call.argv[0] === 'truncate')).toHaveLength(2);
  });

  it('leaves the journal alone unless asked', async () => {
    const ctx = host();
    await rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, ctx);

    expect(ctx.calls.some((call) => call.argv[0] === 'journalctl')).toBe(false);
  });

  it('vacuums the journal to the size it was given', async () => {
    const ctx = host();
    const result = rotateLogs.parse(
      await rotateLogs.apply({ host: 'h', paths: [], journal: true, journalKeepMb: 200 }, ctx),
    );
    const vacuum = ctx.calls.find((call) => call.argv[1]?.startsWith('--vacuum'));

    expect(vacuum?.argv).toEqual(['journalctl', '--vacuum-size=200M']);
    expect(result.journalBefore).toContain('900M');
    expect(result.journalAfter).toContain('180M');
  });

  it('says plainly when a truncate was refused', async () => {
    const ctx = host({ failTruncate: true });
    const result = rotateLogs.parse(
      await rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, ctx),
    );

    expect(result.files[0]?.error).toContain('Read-only file system');
    expect(result.assessment).toContain('nothing was truncated');
  });

  it('reports an already-empty file as nothing to do, not as a failure', async () => {
    // What a re-run looks like, and it must not read as an error.
    const ctx = host({ sizes: { [BIG]: 0 } });
    const result = rotateLogs.parse(
      await rotateLogs.apply({ host: 'h', paths: [BIG], journal: false, journalKeepMb: 200 }, ctx),
    );

    expect(result.freedBytes).toBe(0);
    expect(result.assessment).toContain('nothing to free');
  });
});

describe('createRotateLogs', () => {
  it('lets the caller set the headroom the filesystem must end up with', () => {
    expect(createRotateLogs({ minFreePercent: 25 }).name).toBe('rotate_logs');
  });
});
