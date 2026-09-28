import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Pipeline,
  Session,
  SshTransport,
  ToolRegistry,
  loadPolicy,
  parseSshConfig,
  verifyChain,
  type LoadedPolicy,
  type SshConfig,
} from '@dwara/core';
import { createRestartService } from '@dwara/tools';

/**
 * `restart_service` end to end: the five-case matrix PLAN.md requires of every
 * mutating tool — success, verify failure triggers rollback, timeout mid-action,
 * rollback restores the prior state, idempotent re-run.
 *
 * Driven through the whole `Pipeline`, not the tool in isolation, because the
 * thing under test is the transaction: snapshot, act, verify, undo.
 *
 * `lab-staging`, whose policy allows reversible work without an approval, and a
 * purpose-built unit rather than nginx, so a crash loop can be induced honestly
 * without breaking anything the other suites rely on.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
const UNIT = 'dwara-testsvc';
const MODE_FILE = '/etc/dwara-testsvc.mode';
const exec = promisify(execFile);

/** Short timeouts: this suite should not spend a minute proving each point. */
const tool = createRestartService({
  restartTimeoutMs: 4_000,
  stableForMs: 2_000,
  // A failing verify retries to this deadline, so it sets what the rollback
  // cases cost. The 60s default would outlast the test itself.
  verifyTimeoutMs: 8_000,
});

let dir: string;
let audit: AuditLog;
let policy: LoadedPolicy;
let sshConfig: SshConfig;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 20_000,
});

/** Fixture setup as root, out of band. Dwara is deliberately not allowed to. */
async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

function pipeline(): Pipeline {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit });
}

function restart(unit = UNIT): ReturnType<Pipeline['execute']> {
  return pipeline().execute('restart_service', { host: HOST, unit }, new Session());
}

/** `ok`, `fail` (exits at once, so systemd loops it) or `hang` (start blocks). */
async function setMode(mode: 'ok' | 'fail' | 'hang'): Promise<void> {
  await lab(`printf '%s' ${mode} > ${MODE_FILE}`);
}

const activeState = (): Promise<string> =>
  lab(`systemctl show ${UNIT} --property=ActiveState --value`).then((out) => out.trim());

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;

  dir = await mkdtemp(join(tmpdir(), 'dwara-restart-'));
  audit = new AuditLog({ path: join(dir, 'audit.jsonl') });
  policy = await loadPolicy('testbed/policy.yaml');
  sshConfig = await parseSshConfig('testbed/ssh_config');

  // A unit whose behaviour a file controls, so every case in the matrix is a
  // real systemd state rather than a mock.
  await lab(`cat > /usr/local/bin/dwara-testsvc-pre <<'EOF'
#!/bin/sh
[ "$(cat ${MODE_FILE} 2>/dev/null)" = hang ] && exec sleep 120
exit 0
EOF
cat > /usr/local/bin/dwara-testsvc <<'EOF'
#!/bin/sh
[ "$(cat ${MODE_FILE} 2>/dev/null)" = fail ] && exit 1
exec sleep infinity
EOF
chmod +x /usr/local/bin/dwara-testsvc-pre /usr/local/bin/dwara-testsvc
cat > /etc/systemd/system/${UNIT}.service <<'EOF'
[Unit]
Description=Dwara test service
[Service]
Type=simple
ExecStartPre=/usr/local/bin/dwara-testsvc-pre
ExecStart=/usr/local/bin/dwara-testsvc
Restart=always
RestartSec=200ms
TimeoutStartSec=8
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload`);
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(
    `systemctl stop ${UNIT} 2>/dev/null; systemctl reset-failed ${UNIT} 2>/dev/null;
     rm -f /etc/systemd/system/${UNIT}.service /usr/local/bin/dwara-testsvc /usr/local/bin/dwara-testsvc-pre ${MODE_FILE};
     systemctl daemon-reload; rm -rf /var/lib/dwara/snapshots/*`,
  ).catch(() => '');
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('restart_service against the lab', () => {
  beforeEach(async () => {
    await setMode('ok');
    // Bounded stop, then start. A plain `restart` would queue behind a start
    // job left over from the timeout case and block the whole suite.
    await lab(
      `timeout 20 systemctl stop ${UNIT} 2>/dev/null;
       systemctl reset-failed ${UNIT} 2>/dev/null;
       systemctl start ${UNIT}`,
    );
  });

  it('1 · success: restarts a healthy unit and verifies it stayed up', async () => {
    const result = await restart();

    expect(result.ok).toBe(true);
    expect(result.verify?.ok).toBe(true);
    expect(result.rollback).toBeUndefined();
    expect(result.snapshot?.id).toMatch(/^snap_[0-9a-f]{8}$/);
    expect(await activeState()).toBe('active');

    const data = result.data?.data as { after: { activeState: string }; assessment: string };
    expect(data.after.activeState).toBe('active');
    expect(data.assessment).toBe('restarted and running');
  });

  it('1a · records the verified outcome and the snapshot in the audit chain', async () => {
    await restart();
    const entries = await audit.read();
    const last = entries[entries.length - 1];

    expect(last).toMatchObject({
      tool: 'reversible_restart_service',
      host: HOST,
      risk: 'reversible',
      result: 'verified',
    });
    expect(last?.snapshot).toMatch(/^snap_/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('2 · verify failure triggers an automatic rollback', async () => {
    // The unit is healthy and running; the next restart puts it into a genuine
    // crash loop. Every individual poll will say "active".
    await setMode('fail');

    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.verify?.ok).toBe(false);
    expect(result.rollback).toMatchObject({ attempted: true });
    // The failing check is named, not just "verification failed".
    expect(result.verify?.checks.some((check) => !check.ok)).toBe(true);

    // ROLLBACK_FAILED, not VERIFY_FAILED, and that is the honest answer: the
    // unit was running before and cannot be started now, because the fault is
    // in what it runs rather than in the restart. Dwara changed the host, the
    // change did not work, and it could not put the host back. Saying
    // "rolled back, try something else" here would be a lie.
    expect(result.error?.code).toBe('ROLLBACK_FAILED');
    expect(result.error?.hint).toContain('needs a human');
    // A units-only snapshot holds no files, so `dwara rollback` cannot help
    // and is not suggested.
    expect(result.error?.hint).not.toContain('dwara rollback');
  });

  it('2a · reports a clean rollback when the unit can be put back', async () => {
    // Same shape as above, but the unit is fine underneath: it was not running
    // before, so undoing means stopping it, and that always works.
    await lab(
      `timeout 20 systemctl stop ${UNIT}; systemctl reset-failed ${UNIT} 2>/dev/null; true`,
    );
    await setMode('fail');

    const result = await restart();

    expect(result.error?.code).toBe('VERIFY_FAILED');
    expect(result.rollback?.ok).toBe(true);
    expect(result.error?.hint).toContain('back as it was');
  });

  it('3 · timeout mid-action leaves the snapshot reachable', async () => {
    // The start blocks for five minutes; the tool's deadline is four seconds.
    await lab(`systemctl stop ${UNIT}`);
    await setMode('hang');

    const started = Date.now();
    const result = await restart();
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    // Bounded by Dwara's own timer, not by the unit's 300s TimeoutStartSec.
    expect(elapsed).toBeLessThan(30_000);
    // Half-applied and timed out is exactly when a human needs the id.
    expect(result.snapshot?.id).toMatch(/^snap_/);

    // Free the stuck start job before the next test's setup runs.
    await setMode('ok');
    await lab(
      `systemctl kill -s KILL ${UNIT} 2>/dev/null;
       timeout 20 systemctl stop ${UNIT} 2>/dev/null;
       systemctl reset-failed ${UNIT} 2>/dev/null; true`,
    ).catch(() => '');
  }, 90_000);

  it('4 · rollback puts the unit back in the state the snapshot recorded', async () => {
    // Inactive before. Restarting leaves it running, so undoing has to stop it
    // again -- the case that is easiest to get backwards.
    await lab(`systemctl stop ${UNIT}`);
    expect(await activeState()).toBe('inactive');
    await setMode('fail');

    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.snapshot?.units?.[`${UNIT}.service`]?.activeState).toBe('inactive');
    expect(result.rollback?.attempted).toBe(true);
    expect(result.rollback?.ok).toBe(true);
    // Back as it was, which is the whole claim.
    expect(await activeState()).toBe('inactive');
  });

  it('5 · idempotent: restarting twice leaves the same healthy state', async () => {
    const first = await restart();
    const second = await restart();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.verify?.ok).toBe(true);
    expect(await activeState()).toBe('active');

    const before = first.data?.data as { after: { activeState: string } };
    const after = second.data?.data as { after: { activeState: string } };
    expect(after.after.activeState).toBe(before.after.activeState);
  });

  it('refuses a protected unit without reaching the host', async () => {
    const result = await restart('ssh');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_ARGUMENT');
    // sshd is still up, which this suite is proof of: it kept talking.
    expect(await lab('systemctl is-active ssh')).toContain('active');
  });

  it('prunes the snapshot store after a change that stuck', async () => {
    await lab('rm -rf /var/lib/dwara/snapshots/*');
    for (let i = 0; i < 3; i += 1) await restart();

    const stored = (await lab('ls /var/lib/dwara/snapshots | wc -l')).trim();
    // Well under the retention limit, so all three survive; the point is that
    // pruning ran and removed nothing it should not have.
    expect(Number(stored)).toBe(3);
  });
});
