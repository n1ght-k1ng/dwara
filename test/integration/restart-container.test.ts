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
import { createRestartContainer } from '@dwara/tools';

/**
 * `restart_container` end to end: the same five-case matrix PLAN.md requires of
 * every mutating tool, driven through the whole `Pipeline`.
 *
 * A purpose-built container rather than `lab-app`, so a boot failure can be
 * induced honestly without breaking what the other suites rely on.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
const NAME = 'dwara-testctr';
const exec = promisify(execFile);

const tool = createRestartContainer({
  restartTimeoutMs: 8_000,
  stableForMs: 2_000,
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

/** Fixture setup on the lab host's own docker engine, out of band. */
async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

function restart(container = NAME): ReturnType<Pipeline['execute']> {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit }).execute(
    'restart_container',
    { host: HOST, container },
    new Session(),
  );
}

/**
 * Recreates the test container.
 *
 * Three shapes, and the distinction matters for timing. `loop` is the only one
 * with a restart policy, because only one test needs a container actually
 * cycling; the others would otherwise still be mid-restart when the snapshot
 * is taken, and the recorded restart count would be stale before it was
 * written. That raced under full-suite load and passed in isolation.
 *
 * `--stop-timeout 1` matters too. The command runs as PID 1, where the kernel
 * installs no default signal handlers, so `sleep infinity` ignores SIGTERM and
 * docker waits out the full stop timeout before SIGKILL. At the default ten
 * seconds every restart here would outlive the tool's deadline.
 */
async function makeContainer(mode: 'ok' | 'loop' | 'dead'): Promise<void> {
  const command = mode === 'ok' ? 'sleep infinity' : 'sh -c "exit 1"';
  const policy = mode === 'loop' ? 'always' : 'no';

  await lab(
    `docker rm -f ${NAME} >/dev/null 2>&1;
     docker run -d --name ${NAME} --stop-timeout 1 --restart=${policy} \
       dwara-lab-app:dev ${command} >/dev/null`,
  );

  if (mode !== 'dead') return;

  // Exits on its own with no policy to revive it, so wait for it to be gone
  // rather than stopping a container that is still cycling.
  for (let i = 0; i < 40; i += 1) {
    const running = (await lab(`docker inspect --format '{{.State.Running}}' ${NAME}`)).trim();
    if (running === 'false') return;
    await new Promise((done) => setTimeout(done, 250));
  }
}

const state = (): Promise<string> =>
  lab(
    `docker inspect --format '{{.State.Running}}|{{.State.Status}}' ${NAME} 2>/dev/null || echo gone`,
  ).then((out) => out.trim());

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  dir = await mkdtemp(join(tmpdir(), 'dwara-ctr-'));
  audit = new AuditLog({ path: join(dir, 'audit.jsonl') });
  policy = await loadPolicy('testbed/policy.yaml');
  sshConfig = await parseSshConfig('testbed/ssh_config');
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(`docker rm -f ${NAME} >/dev/null 2>&1; rm -rf /var/lib/dwara/snapshots/*; true`).catch(
    () => '',
  );
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('restart_container against the lab', () => {
  beforeEach(async () => {
    await makeContainer('ok');
  });

  it('1 · success: restarts a healthy container and verifies it stayed up', async () => {
    const result = await restart();

    expect(result.ok).toBe(true);
    expect(result.verify?.ok).toBe(true);
    expect(result.rollback).toBeUndefined();
    expect(result.snapshot?.id).toMatch(/^snap_[0-9a-f]{8}$/);
    expect(await state()).toBe('true|running');

    const data = result.data?.data as { after: { running: boolean }; assessment: string };
    expect(data.after.running).toBe(true);
    expect(data.assessment).toBe('restarted and running');
  });

  it('1a · records the verified outcome and the snapshot in the audit chain', async () => {
    await restart();
    const entries = await audit.read();
    const last = entries[entries.length - 1];

    expect(last).toMatchObject({
      tool: 'reversible_restart_container',
      host: HOST,
      risk: 'reversible',
      result: 'verified',
    });
    expect(last?.snapshot).toMatch(/^snap_/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('2 · verify failure triggers an automatic rollback', async () => {
    // A container that exits on boot with --restart=always: Docker keeps
    // putting it back, so it reads as "running" at most instants you look.
    await makeContainer('loop');

    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.verify?.ok).toBe(false);
    expect(result.rollback?.attempted).toBe(true);
    // Rolling back cannot revive a container that dies on boot, and Dwara says
    // so rather than claiming the host is back as it was.
    expect(result.error?.code).toBe('ROLLBACK_FAILED');
    expect(result.error?.hint).toContain('needs a human');
  });

  it('2a · reports a clean rollback when the container can be put back', async () => {
    // Stopped before, so undoing means stopping it again, which always works.
    await makeContainer('dead');

    const result = await restart();

    expect(result.error?.code).toBe('VERIFY_FAILED');
    expect(result.rollback?.ok).toBe(true);
    expect(result.error?.hint).toContain('back as it was');
    expect(await state()).toMatch(/^false\|/);
  });

  it('3 · timeout mid-action leaves the snapshot reachable', async () => {
    // A container that ignores SIGTERM, with a stop timeout past Dwara's
    // deadline, so `docker restart` is still waiting when Dwara gives up.
    await lab(
      `docker rm -f ${NAME} >/dev/null 2>&1;
       docker run -d --name ${NAME} --stop-timeout 120 dwara-lab-app:dev \
         sh -c 'trap "" TERM; sleep infinity' >/dev/null`,
    );

    const started = Date.now();
    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(40_000);
    // Timed out part-way is exactly when a human needs the id.
    expect(result.snapshot?.id).toMatch(/^snap_/);

    await lab(`docker rm -f ${NAME} >/dev/null 2>&1; true`).catch(() => '');
  }, 90_000);

  it('4 · rollback puts the container back in the state the snapshot recorded', async () => {
    await makeContainer('dead');
    expect(await state()).toMatch(/^false\|/);

    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.snapshot?.containers?.[NAME]?.running).toBe(false);
    expect(result.rollback?.ok).toBe(true);
    // Back as it was, which is the whole claim.
    expect(await state()).toMatch(/^false\|/);
  });

  it('5 · idempotent: restarting twice leaves the same healthy state', async () => {
    const first = await restart();
    const second = await restart();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.verify?.ok).toBe(true);
    expect(await state()).toBe('true|running');
  });

  it('refuses a malformed name without reaching the host', async () => {
    const result = await restart('--force');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_ARGUMENT');
  });

  it('reports a container that does not exist as a failure, not a crash', async () => {
    const result = await restart('no-such-container');

    expect(result.ok).toBe(false);
    expect(await state()).toBe('true|running');
  });
});
