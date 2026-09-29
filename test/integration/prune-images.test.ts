import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { createPruneImages } from '@dwara/tools';

/**
 * `prune_images` against real dangling layers on a real Docker daemon.
 *
 * The matrix again, with the same substitution `rotate_logs` made: there is no
 * rollback, so the "restores exact state" case becomes its honest equivalent —
 * the pipeline reports that the change stands rather than claiming otherwise.
 *
 * The case worth having most is the one that is not in PLAN.md at all: that a
 * tagged image, and the image a running container depends on, both survive.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
const TAG = 'dwara-dangle:test';
const exec = promisify(execFile);

let dir: string;
let audit: AuditLog;
let policy: LoadedPolicy;
let sshConfig: SshConfig;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 60_000,
});

async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function run(
  args: Record<string, unknown> = {},
  options: { minFreePercent?: number; pruneTimeoutMs?: number } = {},
): ReturnType<Pipeline['execute']> {
  const registry = new ToolRegistry();
  registry.register(createPruneImages({ verifyTimeoutMs: 8_000, ...options }));
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit }).execute(
    'prune_images',
    { host: HOST, ...args },
    new Session(),
  );
}

/**
 * Leaves untagged images behind, which is exactly what "dangling" means.
 *
 * `docker commit` with no repository name is the reliable way to make one.
 * Building a tagged image twice is the textbook method and does not work here:
 * the lab app image cannot write to `/` during a build, and a `LABEL`-only
 * rebuild left nothing dangling at all under this daemon.
 */
async function makeDangling(count = 2): Promise<void> {
  await lab(
    `id=$(docker create dwara-lab-app:dev true)
     for i in $(seq ${count}); do docker commit "$id" >/dev/null; done
     docker rm "$id" >/dev/null
     docker tag dwara-lab-app:dev ${TAG}`,
  );
}

const danglingCount = async (): Promise<number> =>
  Number((await lab(`docker images --filter dangling=true --format '{{.ID}}' | wc -l`)).trim());

const imageExists = async (tag: string): Promise<boolean> =>
  (await lab(`docker image inspect ${tag} >/dev/null 2>&1 && echo yes || echo no`)).trim() ===
  'yes';

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  dir = await mkdtemp(join(tmpdir(), 'dwara-prune-'));
  audit = new AuditLog({ path: join(dir, 'audit.jsonl') });
  policy = await loadPolicy('testbed/policy.yaml');
  sshConfig = await parseSshConfig('testbed/ssh_config');
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(
    `docker rmi -f ${TAG} >/dev/null 2>&1; docker image prune -f >/dev/null 2>&1;
     rm -rf /var/lib/dwara/snapshots/*; true`,
  ).catch(() => '');
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('prune_images against the lab', () => {
  it('1 · success: removes real dangling layers and verifies the daemon survived', async () => {
    await makeDangling();
    expect(await danglingCount()).toBeGreaterThan(0);

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.verify?.ok).toBe(true);
    expect(await danglingCount()).toBe(0);

    const data = result.data?.data as { deleted: string[]; assessment: string };
    expect(data.deleted.length).toBeGreaterThan(0);
    expect(data.assessment).toContain('removed');
  }, 120_000);

  it('1a · leaves the tagged image, and the one a running container uses, alone', async () => {
    // The property that matters far more than the space. `-a` would take both.
    await makeDangling();
    await run();

    expect(await imageExists(TAG)).toBe(true);
    expect(await imageExists('dwara-lab-app:dev')).toBe(true);
    expect((await lab(`docker ps --format '{{.Names}}'`)).trim()).toContain('lab-app');
  }, 120_000);

  it('1b · records a verified outcome in the audit chain', async () => {
    await run();
    const entries = await audit.read();
    const last = entries[entries.length - 1];

    expect(last).toMatchObject({
      tool: 'reversible_prune_images',
      host: HOST,
      risk: 'reversible',
      result: 'verified',
    });
    expect((await verifyChain(entries)).ok).toBe(true);
  }, 60_000);

  it('2 · verify failure is reported as a change that stands, not as a rollback', async () => {
    await makeDangling();

    const result = await run({}, { minFreePercent: 99.9 });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFY_FAILED');
    expect(result.rollback).toMatchObject({ attempted: false, ok: false });
    expect(result.error?.hint).toContain('the change stands');
    expect(result.error?.hint).not.toContain('back as it was');
    // And the images really are gone; nothing was put back.
    expect(await danglingCount()).toBe(0);
  }, 120_000);

  it('3 · timeout mid-action leaves a typed error', async () => {
    await makeDangling();

    const result = await run({}, { pruneTimeoutMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');

    await lab('docker image prune -f >/dev/null 2>&1; true').catch(() => '');
  }, 120_000);

  it('4 · refuses a malformed age without touching the daemon', async () => {
    await makeDangling();
    const before = await danglingCount();

    const result = await run({ olderThan: '24h -a' });

    expect(result.ok).toBe(false);
    expect(await danglingCount()).toBe(before);

    await lab('docker image prune -f >/dev/null 2>&1; true');
  }, 120_000);

  it('4a · an age filter that matches nothing removes nothing', async () => {
    await makeDangling();
    const before = await danglingCount();

    const result = await run({ olderThan: '8760h' });

    expect(result.ok).toBe(true);
    // Freshly built, so a one-year cutoff excludes them all.
    expect(await danglingCount()).toBe(before);

    await lab('docker image prune -f >/dev/null 2>&1; true');
  }, 120_000);

  it('5 · idempotent: a second run finds nothing and is not an error', async () => {
    await makeDangling();

    const first = await run();
    const second = await run();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const data = second.data?.data as { deleted: string[]; assessment: string };
    expect(data.deleted).toEqual([]);
    expect(data.assessment).toBe('there were no dangling images to remove');
  }, 120_000);
});
