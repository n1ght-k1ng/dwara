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
import { createRotateLogs } from '@dwara/tools';

/**
 * `rotate_logs` against a filesystem that is genuinely full.
 *
 * `lab-api` rather than `lab-staging`, because lab-api is the host whose
 * /var/log is a bounded 128 MB tmpfs — the only place in the lab where a disk
 * can really be filled without eating the developer's own. Its policy requires
 * approval for reversible work, so the pipeline here is built with a policy
 * that allows it; the approval path itself is Task 10.
 *
 * The matrix is the same five cases, with one difference that is the point of
 * the tool: **there is no rollback**. The "rollback restores exact state" case
 * is replaced by its honest equivalent — the pipeline must report that the
 * change stands rather than claiming the host is back as it was.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-api';
const BIG = '/var/log/lab-api/debug.log';
const exec = promisify(execFile);

/** Allows reversible on lab-api, so this suite tests the tool, not the policy. */
const POLICY_PATH = 'testbed/policy.yaml';

let dir: string;
let audit: AuditLog;
let policy: LoadedPolicy;
let sshConfig: SshConfig;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 30_000,
});

async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

function run(
  args: Record<string, unknown>,
  options: { minFreePercent?: number } = {},
): ReturnType<Pipeline['execute']> {
  const registry = new ToolRegistry();
  registry.register(
    createRotateLogs({
      verifyTimeoutMs: 8_000,
      ...(options.minFreePercent === undefined ? {} : { minFreePercent: options.minFreePercent }),
    }),
  );
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit }).execute(
    'rotate_logs',
    { host: HOST, ...args },
    new Session(),
  );
}

/** Fills /var/log the way the committed break scenario does. */
async function fillDisk(): Promise<void> {
  await lab(`mkdir -p /var/log/lab-api && dd if=/dev/zero of=${BIG} bs=1M 2>/dev/null; true`);
}

const usedPercent = async (): Promise<number> =>
  Number((await lab(`df --output=pcent /var/log | tail -1 | tr -dc '0-9'`)).trim());

const sizeOf = async (path: string): Promise<number> =>
  Number((await lab(`stat -c %s ${path} 2>/dev/null || echo -1`)).trim());

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  dir = await mkdtemp(join(tmpdir(), 'dwara-rotate-'));
  audit = new AuditLog({ path: join(dir, 'audit.jsonl') });

  // lab-api requires approval for reversible, which arrives in Task 10. Until
  // then this suite exercises the tool against a policy that permits it.
  const loaded = await loadPolicy(POLICY_PATH);
  policy = {
    ...loaded,
    policy: {
      ...loaded.policy,
      hosts: loaded.policy.hosts.map((rule) =>
        rule.match === 'lab-api'
          ? // `require_approval` has to come out, not just be joined by an
            // `allow`: within one rule the precedence is deny > approval >
            // allow, so leaving it would win and every call here would stop at
            // APPROVAL_REQUIRED.
            {
              ...rule,
              allow: ['read', 'reversible'] as never,
              require_approval: ['config'] as never,
            }
          : rule,
      ),
    },
  };
  sshConfig = await parseSshConfig('testbed/ssh_config');
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(`rm -f ${BIG}; rm -rf /var/lib/dwara/snapshots/*; true`).catch(() => '');
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('rotate_logs against the lab', () => {
  beforeEach(async () => {
    await lab(`rm -f ${BIG} /var/log/dwara-probe; true`);
  });

  it('1 · success: frees a full filesystem and verifies it can be written again', async () => {
    await fillDisk();
    expect(await usedPercent()).toBeGreaterThanOrEqual(99);

    const result = await run({ paths: [BIG] });

    expect(result.ok).toBe(true);
    expect(result.verify?.ok).toBe(true);
    expect(await usedPercent()).toBeLessThan(90);

    const data = result.data?.data as { freedBytes: number; assessment: string };
    expect(data.freedBytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(data.assessment).toContain('freed about');
  });

  it('1a · the file is truncated, not deleted, so its writer keeps the inode', async () => {
    await fillDisk();
    const inodeBefore = (await lab(`stat -c %i ${BIG}`)).trim();

    await run({ paths: [BIG] });

    // Deleting instead would leave any process holding it appending to an
    // unlinked inode: the space would not come back until it restarted.
    expect((await lab(`stat -c %i ${BIG}`)).trim()).toBe(inodeBefore);
    expect(await sizeOf(BIG)).toBe(0);
  });

  it('1b · records a verified outcome in the audit chain', async () => {
    await fillDisk();
    await run({ paths: [BIG] });
    const entries = await audit.read();
    const last = entries[entries.length - 1];

    expect(last).toMatchObject({
      tool: 'reversible_rotate_logs',
      host: HOST,
      risk: 'reversible',
      result: 'verified',
    });
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('2 · verify failure is reported as a change that stands, not as a rollback', async () => {
    // Demand more headroom than truncating this one file can give, so the
    // postcondition fails while the truncation has really happened.
    await fillDisk();

    const result = await run({ paths: [BIG] }, { minFreePercent: 99.9 });

    expect(result.ok).toBe(false);
    expect(result.verify?.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFY_FAILED');
    // The honest part. Nothing went wrong with an undo, because there was
    // never an undo to attempt -- and the host is emphatically not as it was.
    expect(result.rollback).toMatchObject({ attempted: false, ok: false });
    expect(result.error?.hint).toContain('the change stands');
    expect(result.error?.hint).not.toContain('back as it was');
    expect(await sizeOf(BIG)).toBe(0);
  });

  it('3 · timeout mid-action leaves a typed error, not a hang', async () => {
    await fillDisk();
    const registry = new ToolRegistry();
    // The tool's own deadline, not the transport's default: every command
    // Dwara builds carries its own timeoutMs, so a transport default is never
    // consulted and setting one here would prove nothing.
    registry.register(createRotateLogs({ verifyTimeoutMs: 2_000, truncateTimeoutMs: 1 }));

    const result = await new Pipeline({
      policy,
      sshConfig,
      runner: transport,
      registry,
      audit,
    }).execute('rotate_logs', { host: HOST, paths: [BIG] }, new Session());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');

    await lab(`rm -f ${BIG}; true`);
  }, 60_000);

  it('4 · refuses a path outside /var/log without touching the host', async () => {
    const result = await run({ paths: ['/etc/nginx/nginx.conf'] });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_ARGUMENT');
    // The config it was pointed at is untouched.
    expect(await sizeOf('/etc/nginx/nginx.conf')).toBeGreaterThan(0);
  });

  it('5 · idempotent: running again frees nothing and is not an error', async () => {
    await fillDisk();

    const first = await run({ paths: [BIG] });
    const second = await run({ paths: [BIG] });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const data = second.data?.data as { freedBytes: number; assessment: string };
    expect(data.freedBytes).toBe(0);
    expect(data.assessment).toContain('nothing to free');
  });

  it('shrinks the systemd journal when asked', async () => {
    const result = await run({ journal: true, journalKeepMb: 1 });

    expect(result.ok).toBe(true);
    const data = result.data?.data as { journalBefore?: string; journalAfter?: string };
    expect(data.journalBefore).toContain('journals take up');
    expect(data.journalAfter).toContain('journals take up');
  });

  it('gives back the headroom that a writer actually needs', async () => {
    // Asserted in bytes rather than by probing with `touch`. A tmpfs at 99%
    // still has room for an empty file, so a touch probe proves nothing about
    // whether a service can append a log line.
    const availKb = async (): Promise<number> =>
      Number((await lab(`df --output=avail /var/log | tail -1`)).trim());

    await fillDisk();
    expect(await availKb()).toBeLessThan(2_048);

    await run({ paths: [BIG] });

    expect(await availKb()).toBeGreaterThan(50_000);
    await expect(lab('touch /var/log/dwara-probe && echo ok')).resolves.toContain('ok');
  });
});
