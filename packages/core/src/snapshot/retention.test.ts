import { describe, expect, it } from 'vitest';
import type { Ctx, RemoteCommand } from '../types.js';
import { SNAPSHOT_ROOT } from './manager.js';
import { listSnapshots, pruneSnapshots, removeSnapshot } from './retention.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

/** A host whose snapshot store holds `listing`, printed as `find -printf` does. */
function hostWith(listing: string): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-api',
    sessionId: 's_test',
    httpChecks: [],
    async run(command) {
      calls.push(command);
      const listed = command.argv.includes('-printf');
      return {
        argv: command.argv,
        exitCode: 0,
        stdout: listed ? listing : '',
        stderr: '',
        truncated: false,
        durationMs: 1,
      };
    },
  };
}

function ids(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `${1_700_000_000 + i}.0 snap_${i.toString(16).padStart(8, '0')}`,
  ).join('\n');
}

describe('listSnapshots', () => {
  it('returns snapshots newest first', async () => {
    const ctx = hostWith('1700000001.5 snap_00000001\n1700000009.0 snap_00000009\n');

    expect(await listSnapshots(ctx)).toEqual([
      { id: 'snap_00000009', modifiedAt: 1_700_000_009 },
      { id: 'snap_00000001', modifiedAt: 1_700_000_001.5 },
    ]);
  });

  it('skips directories Dwara did not create', async () => {
    // The listing comes off the host, so it is untrusted data. Dwara does not
    // delete what it did not create, and it does not report it either.
    const ctx = hostWith(
      [
        '1700000001.0 snap_00000001',
        '1700000002.0 evil',
        '1700000003.0 ..',
        '1700000004.0 snap_zz',
      ].join('\n'),
    );

    expect((await listSnapshots(ctx)).map((item) => item.id)).toEqual(['snap_00000001']);
  });

  it('copes with an empty store', async () => {
    expect(await listSnapshots(hostWith(''))).toEqual([]);
  });
});

describe('pruneSnapshots', () => {
  it('drops everything past the keep count, newest kept', async () => {
    const ctx = hostWith(ids(23));
    const result = await pruneSnapshots(ctx, { keep: 20 });

    expect(result.kept).toHaveLength(20);
    // ids() ascends in time, so the three oldest are the lowest-numbered.
    expect(result.removed).toEqual(['snap_00000002', 'snap_00000001', 'snap_00000000']);
  });

  it('keeps everything when the store is under the limit', async () => {
    const result = await pruneSnapshots(hostWith(ids(5)), { keep: 20 });

    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(5);
  });

  it('expires by age with no wildcard anywhere in the command', async () => {
    const ctx = hostWith(ids(1));
    await pruneSnapshots(ctx, { maxAgeDays: 7 });
    const age = ctx.calls[0];

    expect(age?.argv).toEqual([
      'find',
      SNAPSHOT_ROOT,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-type',
      'd',
      '-mtime',
      '+7',
      '-exec',
      'rm',
      '-rf',
      '{}',
      '+',
    ]);
    expect(age?.argv.some((arg) => arg.includes('*'))).toBe(false);
  });

  it('does nothing at all for a nonsensical retention setting', async () => {
    const ctx = hostWith(ids(30));

    expect(await pruneSnapshots(ctx, { keep: -1 })).toEqual({ removed: [], kept: [] });
    expect(await pruneSnapshots(ctx, { maxAgeDays: 1.5 })).toEqual({ removed: [], kept: [] });
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('removeSnapshot', () => {
  it('deletes by basename, never by a path it assembled', async () => {
    const ctx = hostWith('');
    await removeSnapshot(ctx, 'snap_0a1b2c3d');

    // The id is a -name argument. find matches basenames, so it can never
    // address anything outside SNAPSHOT_ROOT, whatever the id turns out to be.
    expect(ctx.calls[0]?.argv).toEqual([
      'find',
      SNAPSHOT_ROOT,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-type',
      'd',
      '-name',
      'snap_0a1b2c3d',
      '-exec',
      'rm',
      '-rf',
      '{}',
      '+',
    ]);
  });

  it('cannot be aimed outside the store even by a hostile id', async () => {
    const ctx = hostWith('');
    await removeSnapshot(ctx, '../../etc');

    const argv = ctx.calls[0]?.argv ?? [];
    // Verified against a lab host: `-name "../../etc"` matches nothing and
    // exits zero. A sudoers grant of `rm -rf <root>/*` would not have been
    // safe here, because a sudoers `*` matches `/` as well.
    expect(argv[argv.indexOf('-name') + 1]).toBe('../../etc');
    expect(argv.join(' ')).not.toContain(`${SNAPSHOT_ROOT}/../../etc`);
    expect(argv[1]).toBe(SNAPSHOT_ROOT);
  });
});
