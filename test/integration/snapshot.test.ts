import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SshTransport,
  copyOf,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  removeSnapshot,
  restoreSnapshot,
  snapshotDir,
  type Ctx,
  type SnapshotRef,
} from '@dwara/core';

/**
 * The snapshot manager against a real host.
 *
 * `lab-staging` rather than `lab-api`: staging is the host whose policy allows
 * reversible work without an approval, and these tests write to /etc, so they
 * belong somewhere disposable.
 *
 * Two channels on purpose. The **code under test** reaches the host over SSH as
 * the `dwara` user, with only the sudo verbs the lab grants it — that is the
 * thing being tested, and if a command needed a grant it does not have, these
 * tests must fail. **Fixture setup** goes in out of band as root through
 * `docker exec`, because arranging the world is the harness's job and Dwara is
 * deliberately not permitted to do it.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
/** Inside an allowed snapshot source tree, and nothing real depends on it. */
const TARGET = '/etc/dwara-lab-snapshot-target.conf';

const exec = promisify(execFile);

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 20_000,
});

const ctx: Ctx = {
  host: HOST,
  sessionId: 's_integration',
  httpChecks: [],
  run: (command) => transport.run(HOST, command),
};

/** Runs a command on the lab host as root, out of band. Fixtures only. */
async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

async function writeTarget(contents: string): Promise<void> {
  await lab(`cat > ${TARGET} <<'EOF'\n${contents}EOF`);
}

const readTarget = (): Promise<string> => lab(`cat ${TARGET}`);

/** Hashed through the transport, since `sha256sum` is a verb Dwara really has. */
async function sha(path: string): Promise<string> {
  const result = await transport.run(HOST, {
    argv: ['sha256sum', '--', path],
    sudo: true,
    timeoutMs: 20_000,
  });
  return result.stdout.slice(0, 64);
}

const created: string[] = [];

async function snapshotTarget(): Promise<SnapshotRef> {
  const ref = await createSnapshot({ paths: [TARGET] }, ctx);
  created.push(ref.id);
  return ref;
}

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(`rm -rf /var/lib/dwara/snapshots/* ${TARGET}`).catch(() => '');
});

describeTestbed('snapshot manager against the lab', () => {
  beforeEach(async () => {
    await lab('rm -rf /var/lib/dwara/snapshots/*').catch(() => '');
    created.length = 0;
    await writeTarget('original = 1\n');
  });

  it('copies a real file, preserving its bytes exactly', async () => {
    const before = await sha(TARGET);
    const ref = await snapshotTarget();

    expect(ref.paths).toEqual([TARGET]);
    expect(ref.hashes[TARGET]).toBe(before);
    // The copy on disk, not merely the hash Dwara recorded for it.
    expect(await sha(copyOf(snapshotDir(ref.id), TARGET))).toBe(before);
  });

  it('preserves mode and ownership', async () => {
    await lab(`chmod 640 ${TARGET}`);
    const ref = await snapshotTarget();
    const both = await lab(`stat -c '%a|%U|%G' ${TARGET} ${copyOf(snapshotDir(ref.id), TARGET)}`);
    const [original, copy] = both.trim().split('\n');

    expect(copy).toBe(original);
    expect(original).toBe('640|root|root');
  });

  it('writes metadata a restore can be driven from with no local state', async () => {
    const ref = await snapshotTarget();
    const parsed = JSON.parse(await lab(`cat ${snapshotDir(ref.id)}/meta.json`)) as SnapshotRef;

    expect(parsed.id).toBe(ref.id);
    expect(parsed.host).toBe(HOST);
    expect(parsed.hashes[TARGET]).toBe(ref.hashes[TARGET]);
  });

  it('restores a file changed after the snapshot, and proves the hashes match', async () => {
    const ref = await snapshotTarget();
    await writeTarget('tampered = 999\n');
    expect(await readTarget()).toBe('tampered = 999\n');

    const restore = await restoreSnapshot(ref, ctx);

    expect(restore.ok).toBe(true);
    expect(restore.mismatched).toEqual([]);
    expect(await readTarget()).toBe('original = 1\n');
    expect(await sha(TARGET)).toBe(ref.hashes[TARGET]);
  });

  it('restores a file that was deleted outright', async () => {
    const ref = await snapshotTarget();
    await lab(`rm -f ${TARGET}`);

    const restore = await restoreSnapshot(ref, ctx);

    expect(restore.ok).toBe(true);
    expect(await readTarget()).toBe('original = 1\n');
  });

  it('is idempotent: restoring twice leaves the same bytes', async () => {
    const ref = await snapshotTarget();
    await writeTarget('tampered\n');

    const first = await restoreSnapshot(ref, ctx);
    const second = await restoreSnapshot(ref, ctx);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await sha(TARGET)).toBe(ref.hashes[TARGET]);
  });

  it('reports a restore as failed when the stored copy no longer matches', async () => {
    // The case the recorded hashes exist to catch: cp exits zero, the file is
    // put back, and the bytes are still wrong.
    const ref = await snapshotTarget();
    await lab(`echo corrupted > ${copyOf(snapshotDir(ref.id), TARGET)}`);

    const restore = await restoreSnapshot(ref, ctx);

    expect(restore.ok).toBe(false);
    expect(restore.mismatched).toEqual([TARGET]);
    expect(restore.detail).toContain(TARGET);
  });

  it('leaves an absent path out rather than failing the snapshot', async () => {
    const ref = await createSnapshot({ paths: [TARGET, '/etc/does-not-exist.conf'] }, ctx);
    created.push(ref.id);

    expect(ref.paths).toEqual([TARGET]);
  });

  it('captures real unit state from systemd', async () => {
    const ref = await createSnapshot({ paths: [], units: ['ssh', 'nginx'] }, ctx);
    created.push(ref.id);

    expect(ref.units?.['ssh.service']?.activeState).toBe('active');
    expect(ref.units?.['nginx.service']?.activeState).toBe('active');
    expect(ref.units?.['ssh.service']?.restarts).toBeTypeOf('number');
  });

  it('refuses a deny-listed path without touching the host', async () => {
    await expect(createSnapshot({ paths: ['/etc/shadow'] }, ctx)).rejects.toThrowError(/deny-list/);
  });

  it('lists what it created and prunes down to the keep count', async () => {
    for (let i = 0; i < 3; i += 1) await snapshotTarget();

    const before = await listSnapshots(ctx);
    expect(before).toHaveLength(3);

    const pruned = await pruneSnapshots(ctx, { keep: 1, maxAgeDays: 3650 });
    const after = await listSnapshots(ctx);

    expect(after).toHaveLength(1);
    expect(pruned.removed).toHaveLength(2);
    // The survivor is the newest, and its directory is really still there.
    expect(pruned.kept).toEqual([before[0]?.id]);
    expect(await lab(`ls -d ${snapshotDir(after[0]?.id ?? 'snap_00000000')}`)).toContain('snap_');
  });

  it('ignores directories it did not create, and never deletes them', async () => {
    await lab('mkdir -p /var/lib/dwara/snapshots/not-ours');
    await snapshotTarget();

    expect((await listSnapshots(ctx)).map((item) => item.id)).not.toContain('not-ours');
    await pruneSnapshots(ctx, { keep: 0, maxAgeDays: 3650 });

    expect(await lab('ls /var/lib/dwara/snapshots')).toContain('not-ours');
  });

  it('cannot be aimed outside the store by a hostile id', async () => {
    const ref = await snapshotTarget();
    // find matches basenames, so this deletes nothing -- and /etc survives.
    await removeSnapshot(ctx, '../../../etc');

    expect(await lab('ls /etc/hostname')).toContain('/etc/hostname');
    expect(await lab(`ls -d ${snapshotDir(ref.id)}`)).toContain(ref.id);
  });
});
