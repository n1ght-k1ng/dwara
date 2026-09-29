import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { approve } from '@dwara/cli';
import { createEditConfig, type EditConfigResult } from '@dwara/tools';

/**
 * `edit_config` against the real nginx on `lab-api`.
 *
 * Run through the whole pipeline **and** the whole approval flow, because a
 * config change is the thing the approval flow exists for: the committed
 * policy requires a human for `config` on every lab host, and nothing here
 * relaxes it.
 *
 * The case that matters most is the one PLAN.md calls out by name: a diff that
 * breaks nginx is rejected at the validator stage and **never reloaded**.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-api';
const SITE = '/etc/nginx/sites-enabled/lab-api';
const exec = promisify(execFile);

let dir: string;
let audit: AuditLog;
let policy: LoadedPolicy;
let sshConfig: SshConfig;
let store: FileApprovalStore;
let original: string;

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 30_000,
});

const tool = createEditConfig({ verifyTimeoutMs: 15_000, stableForMs: 2_000 });

async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

function pipeline(): Pipeline {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new Pipeline({ policy, sshConfig, runner: transport, registry, audit, approvals: store });
}

/** One call, granting the approval it asks for. Returns the second attempt. */
async function call(args: Record<string, unknown>): ReturnType<Pipeline['execute']> {
  const first = await pipeline().execute('edit_config', { host: HOST, ...args }, new Session());
  if (first.error?.code !== 'APPROVAL_REQUIRED') return first;

  const pending = (await store.pending()).find(
    (item) => item.input['mode'] === args['mode'] && item.input['path'] === args['path'],
  );
  await approve(pending!.id, { dir, yes: true });

  return pipeline().execute('edit_config', { host: HOST, ...args }, new Session());
}

const data = (result: Awaited<ReturnType<Pipeline['execute']>>): EditConfigResult =>
  result.data?.data as EditConfigResult;

const siteContents = (): Promise<string> => lab(`cat ${SITE}`);
const upstreamLine = async (): Promise<string> =>
  (await lab(`grep -n proxy_pass ${SITE} | head -1`)).trim();

beforeAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  policy = await loadPolicy('testbed/policy.yaml');
  sshConfig = await parseSshConfig('testbed/ssh_config');
  original = await siteContents();
});

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(`cat > ${SITE} <<'DWARA_EOF'\n${original}DWARA_EOF\nnginx -t && nginx -s reload`).catch(
    () => '',
  );
  await rm(dir, { recursive: true, force: true });
});

describeTestbed('edit_config against the lab', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-edit-'));
    audit = new AuditLog({ path: join(dir, 'audit.jsonl') });
    store = new FileApprovalStore({ dir });
    await lab(`cat > ${SITE} <<'DWARA_EOF'\n${original}DWARA_EOF\nnginx -t && nginx -s reload`);
  });

  /** A diff that renames the upstream comment: valid, harmless, real. */
  async function harmlessDiff(): Promise<string> {
    const line = (await lab(`sed -n '1p' ${SITE}`)).replace(/\n$/, '');
    return ['@@ -1 +1 @@', `-${line}`, `+${line} # touched by dwara`, ''].join('\n');
  }

  it('plan writes nothing and shows the result', async () => {
    const result = await call({ path: SITE, diff: await harmlessDiff(), mode: 'plan' });

    expect(result.ok).toBe(true);
    expect(data(result).preview).toContain('# touched by dwara');
    expect(data(result).validator).toBe('nginx -t');
    // The file on disk is untouched.
    expect(await siteContents()).toBe(original);
  }, 120_000);

  it('1 · success: apply writes, validates, reloads, and verifies', async () => {
    const diff = await harmlessDiff();
    const planned = await call({ path: SITE, diff, mode: 'plan' });

    const applied = await call({
      path: SITE,
      diff,
      mode: 'apply',
      planHash: data(planned).planHash,
    });

    expect(applied.ok).toBe(true);
    expect(applied.verify?.ok).toBe(true);
    expect(data(applied).reloaded).toBe(true);
    expect(await siteContents()).toContain('# touched by dwara');
    // nginx is still serving, which is the point of validating first.
    expect(
      (await lab('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/health')).trim(),
    ).toBe('200');
  }, 180_000);

  it('2 · a diff that breaks nginx is rejected at the validator and never reloaded', async () => {
    // The case PLAN.md names. nginx keeps serving throughout.
    const line = (await lab(`grep -m1 proxy_pass ${SITE}`)).replace(/\n$/, '');
    const broken = [
      '@@ -24 +24 @@',
      `-${line}`,
      `+${line.replace('proxy_pass', 'prox_pass')}`,
      '',
    ].join('\n');

    const planned = await call({ path: SITE, diff: broken, mode: 'plan' });
    const applied = await call({
      path: SITE,
      diff: broken,
      mode: 'apply',
      planHash: data(planned).planHash,
    });

    expect(applied.ok).toBe(false);
    expect(data(applied)?.reloaded ?? false).toBe(false);

    // The file was restored and the running config was never the broken one.
    expect(await siteContents()).toBe(original);
    expect((await lab('nginx -t 2>&1 && echo VALID')).trim()).toContain('VALID');
    expect(
      (await lab('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/health')).trim(),
    ).toBe('200');
  }, 180_000);

  it('3 · rollback restores the exact bytes, proven by hash', async () => {
    const before = await lab(`sha256sum ${SITE} | cut -d' ' -f1`);
    const line = (await lab(`grep -m1 proxy_pass ${SITE}`)).replace(/\n$/, '');
    const broken = [
      '@@ -24 +24 @@',
      `-${line}`,
      `+${line.replace('proxy_pass', 'prox_pass')}`,
      '',
    ].join('\n');

    const planned = await call({ path: SITE, diff: broken, mode: 'plan' });
    const applied = await call({
      path: SITE,
      diff: broken,
      mode: 'apply',
      planHash: data(planned).planHash,
    });

    expect(applied.rollback?.ok).toBe(true);
    expect(applied.rollback?.detail).toContain('every hash matches');
    expect(await lab(`sha256sum ${SITE} | cut -d' ' -f1`)).toBe(before);
  }, 180_000);

  it('4 · refuses to apply when the file changed after planning', async () => {
    const diff = await harmlessDiff();
    const planned = await call({ path: SITE, diff, mode: 'plan' });

    // Someone else edits it, somewhere the hunk does not look.
    await lab(`printf '# another admin was here\\n' >> ${SITE}`);

    const applied = await call({
      path: SITE,
      diff,
      mode: 'apply',
      planHash: data(planned).planHash,
    });

    expect(applied.ok).toBe(false);
    expect(applied.error?.code).toBe('PLAN_MISMATCH');
    // Their line survives: nothing was overwritten.
    expect(await siteContents()).toContain('# another admin was here');
  }, 180_000);

  it('5 · idempotent: applying the same diff twice fails the second time, cleanly', async () => {
    const diff = await harmlessDiff();
    const planned = await call({ path: SITE, diff, mode: 'plan' });
    const hash = data(planned).planHash;

    const first = await call({ path: SITE, diff, mode: 'apply', planHash: hash });
    const second = await call({ path: SITE, diff, mode: 'apply', planHash: hash });

    expect(first.ok).toBe(true);
    // The file no longer matches the diff, so the second attempt cannot apply
    // it -- which is the correct answer, not a silent no-op.
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('PLAN_MISMATCH');
    expect(await upstreamLine()).toBeTruthy();
  }, 180_000);

  it('needs a human for every config change, and records which one', async () => {
    const diff = await harmlessDiff();
    const refused = await pipeline().execute(
      'edit_config',
      { host: HOST, path: SITE, diff, mode: 'plan' },
      new Session(),
    );

    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('APPROVAL_REQUIRED');

    const pending = (await store.pending())[0]!;
    await approve(pending.id, { dir, yes: true });
    await pipeline().execute(
      'edit_config',
      { host: HOST, path: SITE, diff, mode: 'plan' },
      new Session(),
    );

    const entries = await audit.read();
    expect(entries[0]).toMatchObject({
      tool: 'config_edit_config',
      risk: 'config',
      result: 'refused',
    });
    expect(entries[1]).toMatchObject({ approval: pending.id, decision: 'approval' });
    expect((await verifyChain(entries)).ok).toBe(true);
  }, 120_000);

  it('refuses to edit sshd_config at all', async () => {
    const result = await call({
      path: '/etc/ssh/sshd_config',
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      mode: 'plan',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_ARGUMENT');
  }, 60_000);
});
