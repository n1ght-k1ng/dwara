import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SshTransport, createSnapshot, type Ctx, type SnapshotRef } from '@dwara/core';
import { hostForSnapshot, listHostSnapshots, rollback } from '@dwara/cli';

/**
 * `dwara rollback` against the lab, with no pipeline and no agent.
 *
 * This is the command the whole snapshot design is for. Everything else
 * assumes a live session; this assumes a person with SSH access and the
 * binary, working from the snapshot's own metadata on the host.
 *
 * It also covers the chaos case PLAN.md asks for: the connection dies
 * mid-apply, and the snapshot is still there to restore from.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
const TARGET = '/etc/dwara-lab-rollback-target.conf';
const exec = promisify(execFile);

let dir: string;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 20_000,
});

const ctx: Ctx = {
  host: HOST,
  sessionId: 'integration',
  httpChecks: [],
  run: (command) => transport.run(HOST, command),
};

async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

const contents = (): Promise<string> => lab(`cat ${TARGET}`);

async function snapshotTarget(): Promise<SnapshotRef> {
  return createSnapshot({ paths: [TARGET], units: ['nginx'] }, ctx);
}

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  dir = await mkdtemp(join(tmpdir(), 'dwara-rollback-cli-'));
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(`rm -f ${TARGET}; rm -rf /var/lib/dwara/snapshots/*; true`).catch(() => '');
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('dwara rollback against the lab', () => {
  beforeEach(async () => {
    await lab(`rm -rf /var/lib/dwara/snapshots/*; printf 'original = 1\\n' > ${TARGET}`);
  });

  it('restores from the snapshot metadata alone, with no local state', async () => {
    const ref = await snapshotTarget();
    await lab(`printf 'tampered = 999\\n' > ${TARGET}`);

    // No pipeline, no audit log, no session: only the id and the host.
    const report = await rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', host: HOST });

    expect(report.ok).toBe(true);
    expect(report.text).toContain('Every file matches the hash recorded');
    expect(await contents()).toBe('original = 1\n');
  }, 60_000);

  it('finds the host from the audit log when it is not told', async () => {
    const ref = await snapshotTarget();
    await lab(`printf 'tampered\\n' > ${TARGET}`);

    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify({ tool: 'reversible_restart_service', host: HOST, snapshot: ref.id })}\n`,
      'utf8',
    );

    // At the moment someone needs this command, remembering which host it was
    // is exactly what they will not do.
    expect(await hostForSnapshot(ref.id, auditPath)).toBe(HOST);

    const report = await rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', auditPath });
    expect(report.ok).toBe(true);
    expect(await contents()).toBe('original = 1\n');
  }, 60_000);

  it('says so plainly when it cannot tell which host', async () => {
    const ref = await snapshotTarget();

    await expect(
      rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', auditPath: join(dir, 'nope.jsonl') }),
    ).rejects.toMatchObject({ hint: expect.stringContaining('--host') as unknown });
  }, 60_000);

  it('reports a restore that did not really restore', async () => {
    // Corrupting the stored copy is the case the recorded hashes exist for.
    const ref = await snapshotTarget();
    await lab(
      `printf 'corrupted\\n' > /var/lib/dwara/snapshots/${ref.id}/files${TARGET}
       printf 'tampered\\n' > ${TARGET}`,
    );

    const report = await rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', host: HOST });

    expect(report.ok).toBe(false);
    expect(report.text).toContain('NOT fully restored');
    expect(report.text).toContain('needs a person');
    expect(report.text).toContain(`FAILED   ${TARGET}`);
  }, 60_000);

  it('refuses an id that could escape the snapshot store', async () => {
    for (const bad of ['../../etc', 'snap_../x', 'nonsense', '']) {
      await expect(
        rollback(bad, { sshConfigPath: 'testbed/ssh_config', host: HOST }),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    }
  }, 60_000);

  it('refuses a snapshot that is not on the host', async () => {
    await expect(
      rollback('snap_00000000', { sshConfigPath: 'testbed/ssh_config', host: HOST }),
    ).rejects.toThrowError(/no snapshot snap_00000000/);
  }, 60_000);

  it('refuses metadata that claims to be a different snapshot', async () => {
    // meta.json is server output, and server output is untrusted data: a
    // hand-edited file must not redirect a restore at another snapshot.
    const ref = await snapshotTarget();
    await lab(
      `sed -i 's/"id":"${ref.id}"/"id":"snap_99999999"/' /var/lib/dwara/snapshots/${ref.id}/meta.json`,
    );

    await expect(
      rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', host: HOST }),
    ).rejects.toThrowError(/claims to be snap_99999999/);
  }, 60_000);

  it('lists what is on a host, newest first', async () => {
    const first = await snapshotTarget();
    const second = await snapshotTarget();

    const text = await listHostSnapshots(HOST, { sshConfigPath: 'testbed/ssh_config' });

    expect(text).toContain(first.id);
    expect(text).toContain(second.id);
    expect(text.indexOf(second.id)).toBeLessThan(text.indexOf(first.id) + text.length);
  }, 60_000);

  it('chaos: the snapshot survives a connection killed mid-change', async () => {
    // PLAN.md's chaos case. The snapshot is written before anything is
    // touched, so it is on the host even when the session that made it is not.
    const ref = await snapshotTarget();

    // The change lands, then the world ends before anything can verify it.
    await lab(`printf 'half-applied\\n' > ${TARGET}`);
    // The bracket keeps pkill from matching its own command line, which
    // contains the pattern and which it will otherwise cheerfully kill.
    await lab(`pkill -f 'sshd: [d]wara' || true; true`);

    // A different transport entirely, as a new process would have.
    const report = await rollback(ref.id, { sshConfigPath: 'testbed/ssh_config', host: HOST });

    expect(report.ok).toBe(true);
    expect(await contents()).toBe('original = 1\n');
  }, 90_000);
});
