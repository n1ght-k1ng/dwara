import { describe, expect, it } from 'vitest';
import { DwaraError } from '../errors.js';
import type { Ctx, RawResult, RemoteCommand, SnapshotRef } from '../types.js';
import {
  SNAPSHOT_ROOT,
  copyOf,
  createSnapshot,
  guardSnapshotPath,
  isSnapshotId,
  newSnapshotId,
  restoreSnapshot,
  snapshotDir,
} from './manager.js';

const NGINX = '/etc/nginx/nginx.conf';
const HOSTS = '/etc/hosts';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

function ctxWith(respond: (command: RemoteCommand) => Partial<RawResult>): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-api',
    sessionId: 's_test',
    httpChecks: [],
    async run(command) {
      calls.push(command);
      return {
        argv: command.argv,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        ...respond(command),
      };
    },
  };
}

/**
 * A host where `files` exist with the given contents-hash, and everything else
 * succeeds silently. `copies` overrides what the snapshot's copy hashes to,
 * which is how a faithless copy is simulated.
 */
function labHost(options: {
  files: Record<string, string>;
  copies?: Record<string, string>;
  units?: string;
  fail?: string;
}): FakeCtx {
  return ctxWith((command) => {
    const [program, ...args] = command.argv;

    if (program === options.fail) return { exitCode: 1, stderr: `${program}: refused` };

    if (program === 'stat') {
      const lines = args
        .filter((arg) => options.files[arg] !== undefined)
        .map((arg) => `${arg}|644|root|root`);
      return {
        stdout: `${lines.join('\n')}\n`,
        exitCode: lines.length === args.length - 3 ? 0 : 1,
      };
    }

    if (program === 'sha256sum') {
      const lines: string[] = [];
      for (const arg of args) {
        if (arg === '--') continue;
        // A copy path is the original with the snapshot's files/ prefix, so the
        // original is recoverable by stripping it.
        const original = arg.replace(new RegExp(`^${SNAPSHOT_ROOT}/snap_[0-9a-f]{8}/files`), '');
        const hash =
          arg === original ? options.files[arg] : (options.copies ?? options.files)[original];
        if (hash !== undefined) lines.push(`${hash}  ${arg}`);
      }
      return { stdout: `${lines.join('\n')}\n` };
    }

    if (program === 'systemctl') return { stdout: options.units ?? '' };

    return {};
  });
}

describe('snapshot identity', () => {
  it('generates ids that match the only accepted shape', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isSnapshotId(newSnapshotId())).toBe(true);
    }
  });

  it('refuses to build a directory for anything that is not an id', () => {
    // Every one of these would escape SNAPSHOT_ROOT if concatenated blindly,
    // and ids come back off a host, which is untrusted data.
    for (const bad of [
      '..',
      '../../etc',
      'snap_../x',
      'snap_ZZZZZZZZ',
      'snap_1234567',
      '',
      'evil',
    ]) {
      expect(() => snapshotDir(bad)).toThrowError(DwaraError);
      expect(isSnapshotId(bad)).toBe(false);
    }
  });

  it('puts a snapshot under the documented root', () => {
    expect(snapshotDir('snap_0a1b2c3d')).toBe(`${SNAPSHOT_ROOT}/snap_0a1b2c3d`);
    expect(copyOf(snapshotDir('snap_0a1b2c3d'), NGINX)).toBe(
      `${SNAPSHOT_ROOT}/snap_0a1b2c3d/files${NGINX}`,
    );
  });
});

describe('guardSnapshotPath', () => {
  it('accepts an ordinary config path and normalises it', () => {
    expect(guardSnapshotPath('/etc//nginx/nginx.conf/')).toBe(NGINX);
  });

  it('refuses relative paths, traversal and control characters', () => {
    expect(() => guardSnapshotPath('etc/nginx.conf')).toThrowError(/absolute/);
    expect(() => guardSnapshotPath('/etc/nginx/../shadow')).toThrowError(/\.\./);
    expect(() => guardSnapshotPath('/etc/ngin\u0000x')).toThrowError(/control characters/);
  });

  it('refuses the permanent deny-list, because a snapshot leaves a copy behind', () => {
    for (const denied of ['/etc/shadow', '/root/.bashrc', '/home/u/.ssh/id_rsa', '/srv/app/.env']) {
      expect(() => guardSnapshotPath(denied)).toThrowError(/deny-list/);
    }
  });
});

describe('createSnapshot', () => {
  it('copies, then proves the copy, then writes the metadata last', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A } });
    const ref = await createSnapshot({ paths: [NGINX] }, ctx);

    expect(ref.paths).toEqual([NGINX]);
    expect(ref.hashes).toEqual({ [NGINX]: HASH_A });
    expect(ref.host).toBe('lab-api');

    // Order is the guarantee: nothing is copied before there is somewhere to
    // put it, and meta.json appears only once the copy has been verified, so a
    // directory holding one is a snapshot that completed.
    expect(ctx.calls.map((call) => call.argv[0])).toEqual([
      'stat',
      'sha256sum',
      'mkdir',
      'cp',
      'sha256sum',
      'tee',
    ]);
  });

  it('runs every command as root and none of them interactively', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A } });
    await createSnapshot({ paths: [NGINX] }, ctx);

    expect(ctx.calls.every((call) => call.sudo === true)).toBe(true);
  });

  it('preserves mode and owner, and mirrors the absolute path', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A } });
    const ref = await createSnapshot({ paths: [NGINX] }, ctx);
    const cp = ctx.calls.find((call) => call.argv[0] === 'cp');

    expect(cp?.argv).toEqual([
      'cp',
      '--preserve=all',
      '--parents',
      '--',
      NGINX,
      `${snapshotDir(ref.id)}/files`,
    ]);
  });

  it('leaves out a path that does not exist rather than failing', async () => {
    // edit_config may be creating a file. A restore must not then try to put
    // back something that was never there.
    const ctx = labHost({ files: { [NGINX]: HASH_A } });
    const ref = await createSnapshot({ paths: [NGINX, '/etc/absent.conf'] }, ctx);

    expect(ref.paths).toEqual([NGINX]);
    expect(ref.hashes).toEqual({ [NGINX]: HASH_A });
  });

  it('fails when a copy does not hash to the same bytes as its original', async () => {
    // The whole reason the manager re-hashes. A snapshot that silently copied
    // nothing is worse than no snapshot: the pipeline would change the host
    // believing it could undo it.
    const ctx = labHost({ files: { [NGINX]: HASH_A }, copies: { [NGINX]: HASH_B } });

    await expect(createSnapshot({ paths: [NGINX] }, ctx)).rejects.toThrowError(
      /did not copy 1 file\(s\) faithfully; refusing to change anything/,
    );
    expect(ctx.calls.some((call) => call.argv[0] === 'tee')).toBe(false);
  });

  it('fails with SNAPSHOT_FAILED when the store cannot be created', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A }, fail: 'mkdir' });

    await expect(createSnapshot({ paths: [NGINX] }, ctx)).rejects.toMatchObject({
      code: 'SNAPSHOT_FAILED',
    });
    expect(ctx.calls.some((call) => call.argv[0] === 'cp')).toBe(false);
  });

  it('records unit state keyed by Id, whatever order systemctl answers in', async () => {
    // A real host returns NRestarts first however --property is ordered, which
    // is why the blocks are keyed by Id rather than by position.
    const ctx = labHost({
      files: {},
      units: [
        'NRestarts=3',
        'Id=nginx.service',
        'ActiveState=active',
        'UnitFileState=enabled',
        '',
        'NRestarts=0',
        'Id=dwara-app.service',
        'ActiveState=failed',
        'UnitFileState=disabled',
      ].join('\n'),
    });

    const ref = await createSnapshot({ paths: [], units: ['nginx', 'dwara-app'] }, ctx);

    expect(ref.units).toEqual({
      'nginx.service': { activeState: 'active', unitFileState: 'enabled', restarts: 3 },
      'dwara-app.service': { activeState: 'failed', unitFileState: 'disabled', restarts: 0 },
    });
  });

  it('takes a units-only snapshot without touching the filesystem', async () => {
    const ctx = labHost({ files: {}, units: 'Id=nginx.service\nActiveState=active\n' });
    await createSnapshot({ paths: [], units: ['nginx'] }, ctx);

    expect(ctx.calls.map((call) => call.argv[0])).toEqual(['mkdir', 'systemctl', 'tee']);
  });

  it('refuses a deny-listed path before issuing any command', async () => {
    const ctx = labHost({ files: {} });

    await expect(createSnapshot({ paths: ['/etc/shadow'] }, ctx)).rejects.toThrowError(/deny-list/);
    expect(ctx.calls).toHaveLength(0);
  });

  it('writes metadata the CLI can restore from without the agent', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A } });
    const ref = await createSnapshot({ paths: [NGINX] }, ctx);
    const tee = ctx.calls.find((call) => call.argv[0] === 'tee');
    const meta = JSON.parse(tee?.stdin ?? '{}') as SnapshotRef;

    expect(tee?.argv).toEqual(['tee', '--', `${snapshotDir(ref.id)}/meta.json`]);
    expect(meta).toMatchObject({ id: ref.id, host: 'lab-api', paths: [NGINX], hashes: ref.hashes });
  });
});

describe('restoreSnapshot', () => {
  const ref: SnapshotRef = {
    id: 'snap_0a1b2c3d',
    host: 'lab-api',
    createdAt: '2026-09-28T00:00:00.000Z',
    paths: [NGINX, HOSTS],
    hashes: { [NGINX]: HASH_A, [HOSTS]: HASH_B },
  };

  it('puts every file back and confirms each hash', async () => {
    const ctx = labHost({ files: { [NGINX]: HASH_A, [HOSTS]: HASH_B } });
    const result = await restoreSnapshot(ref, ctx);

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([NGINX, HOSTS]);
    expect(result.mismatched).toEqual([]);
    expect(ctx.calls.map((call) => call.argv[0])).toEqual(['cp', 'cp', 'sha256sum']);
  });

  it('reports a file that came back different, even when cp exited zero', async () => {
    // A full disk truncating the write is the realistic case. cp succeeds and
    // the bytes are wrong, so the exit code is not the thing to trust.
    const ctx = labHost({ files: { [NGINX]: HASH_A, [HOSTS]: HASH_C } });
    const result = await restoreSnapshot(ref, ctx);

    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([HOSTS]);
    expect(result.restored).toEqual([NGINX]);
    expect(result.detail).toContain(HOSTS);
  });

  it('does not throw when the restore fails, so the caller keeps both outcomes', async () => {
    const ctx = labHost({ files: {}, fail: 'cp' });
    const result = await restoreSnapshot(ref, ctx);

    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([NGINX, HOSTS]);
  });

  it('succeeds trivially for a snapshot that held no files', async () => {
    const ctx = labHost({ files: {} });
    const result = await restoreSnapshot({ ...ref, paths: [], hashes: {} }, ctx);

    expect(result.ok).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });
});
