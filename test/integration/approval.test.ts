import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  FileApprovalStore,
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
import { approve } from '@dwara/cli';

/**
 * The whole approval loop against a real host.
 *
 * `lab-api`, because its committed policy genuinely requires a human for
 * reversible work — this is the one suite that runs against the policy as
 * written rather than a relaxed copy of it.
 *
 * The shape being tested is the product's central claim: the agent asks, is
 * refused, a person reads the plan and grants it in their own terminal, and
 * only then does anything reach the host.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-api';
const UNIT = 'nginx';
const exec = promisify(execFile);

let dir: string;
let audit: AuditLog;
let policy: LoadedPolicy;
let sshConfig: SshConfig;
let store: FileApprovalStore;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 30_000,
});

const tool = createRestartService({
  restartTimeoutMs: 20_000,
  stableForMs: 2_000,
  verifyTimeoutMs: 15_000,
});

function pipeline(): Pipeline {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit, approvals: store });
}

function restart(unit = UNIT): ReturnType<Pipeline['execute']> {
  return pipeline().execute('restart_service', { host: HOST, unit }, new Session());
}

const activeState = async (): Promise<string> =>
  (
    await exec('docker', [
      'exec',
      HOST,
      'systemctl',
      'show',
      UNIT,
      '--property=ActiveState',
      '--value',
    ])
  ).stdout.trim();

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  policy = await loadPolicy('testbed/policy.yaml');
  sshConfig = await parseSshConfig('testbed/ssh_config');
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('the approval loop against the lab', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-approval-int-'));
    audit = new AuditLog({ path: join(dir, 'audit.jsonl') });
    store = new FileApprovalStore({ dir });
  });

  it('refuses under the committed policy, with nothing touched', async () => {
    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(result.error?.hint).toMatch(/dwara approve apr_[0-9a-f]{8}/);
    expect(await activeState()).toBe('active');
    // Asked, not granted.
    expect(await store.all()).toEqual([]);
  }, 60_000);

  it('runs once a human approves, and not before', async () => {
    const asked = await restart();
    expect(asked.ok).toBe(false);

    const pending = (await store.pending())[0]!;
    // The person's own terminal, not the agent's. There is no path from a tool
    // call to this function.
    const granted = await approve(pending.id, { dir, yes: true });
    expect(granted.ok).toBe(true);

    const done = await restart();

    expect(done.ok).toBe(true);
    expect(done.verify?.ok).toBe(true);
    expect(await activeState()).toBe('active');
  }, 120_000);

  it('will not let one approval authorise a second restart', async () => {
    await restart();
    await approve((await store.pending())[0]!.id, { dir, yes: true });

    const first = await restart();
    const second = await restart();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('APPROVAL_REQUIRED');
  }, 180_000);

  it('will not let an approval for one unit restart another', async () => {
    await restart();
    await approve((await store.pending())[0]!.id, { dir, yes: true });

    // The plan hash covers the arguments, so this is a different action.
    const result = await restart('dwara-app');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
  }, 120_000);

  it('will not spend an approval that has expired', async () => {
    await restart();
    await approve((await store.pending())[0]!.id, { dir, yes: true, ttlMs: 1 });
    await new Promise((done) => setTimeout(done, 50));

    const result = await restart();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
  }, 60_000);

  it('leaves an audit chain tying the change to the human decision', async () => {
    await restart();
    const pending = (await store.pending())[0]!;
    await approve(pending.id, { dir, yes: true });
    await restart();

    const entries = await audit.read();

    expect(entries[0]).toMatchObject({
      result: 'refused',
      code: 'APPROVAL_REQUIRED',
      approval: pending.id,
      decision: 'approval',
    });
    expect(entries[1]).toMatchObject({
      result: 'verified',
      approval: pending.id,
      decision: 'approval',
      host: HOST,
    });
    expect((await verifyChain(entries)).ok).toBe(true);
  }, 120_000);

  it('records the arguments a person would need to decide', async () => {
    await restart();
    const pending = (await store.pending())[0]!;

    expect(pending.input).toMatchObject({ host: HOST, unit: UNIT });
    expect(pending.tool).toBe('reversible_restart_service');
    expect(pending.reason).toBeTruthy();
  }, 60_000);
});
