import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DwaraError } from '../errors.js';
import { grantApproval } from './grant.js';
import {
  FileApprovalStore,
  isRequestId,
  newRequestId,
  planHash,
  type ApprovalRequest,
} from './store.js';

let dir: string;
let store: FileApprovalStore;

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const input = { host: 'lab-api', unit: 'nginx', ...((over.input ?? {}) as object) };
  return {
    id: newRequestId(),
    plan_hash: planHash({ tool: 'restart_service', host: 'lab-api', input }),
    tool: 'reversible_restart_service',
    host: 'lab-api',
    risk: 'reversible',
    input,
    reason: 'policy requires approval for reversible on lab-api',
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-approval-'));
  store = new FileApprovalStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('planHash', () => {
  it('is stable for the same plan, whatever order the keys arrive in', () => {
    const a = planHash({ tool: 't', host: 'h', input: { unit: 'nginx', host: 'h' } });
    const b = planHash({ tool: 't', host: 'h', input: { host: 'h', unit: 'nginx' } });

    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when anything about the action changes', () => {
    const base = { tool: 'restart_service', host: 'lab-api', input: { unit: 'nginx' } };
    const hash = planHash(base);

    // Each of these is a different action, and approving one must not approve
    // any of the others.
    expect(planHash({ ...base, tool: 'restart_container' })).not.toBe(hash);
    expect(planHash({ ...base, host: 'lab-db' })).not.toBe(hash);
    expect(planHash({ ...base, input: { unit: 'postgresql' } })).not.toBe(hash);
    expect(planHash({ ...base, input: { unit: 'nginx', extra: 1 } })).not.toBe(hash);
  });
});

describe('request ids', () => {
  it('generates ids of the only accepted shape', () => {
    for (let i = 0; i < 50; i += 1) expect(isRequestId(newRequestId())).toBe(true);
  });

  it('refuses anything that could escape the directory', async () => {
    for (const bad of ['..', '../../etc/passwd', 'apr_../x', 'apr_ZZZZZZZZ', '']) {
      expect(isRequestId(bad)).toBe(false);
      expect(await store.read(bad)).toBeUndefined();
      expect(await store.readRequest(bad)).toBeUndefined();
    }
  });
});

describe('FileApprovalStore', () => {
  it('finds nothing at all before anything is granted', async () => {
    const pending = request();
    await store.record(pending);

    // A recorded request is not permission. This is the distinction the whole
    // file rests on.
    expect(await store.find(pending.plan_hash)).toBeUndefined();
  });

  it('finds an approval bound to the same plan', async () => {
    const pending = request();
    await store.record(pending);
    await grantApproval(store, pending);

    const found = await store.find(pending.plan_hash);
    expect(found?.id).toBe(pending.id);
    expect(found?.approved_by).toBe('cli');
  });

  it('does not match an approval for a different plan', async () => {
    const pending = request();
    await grantApproval(store, pending);

    expect(await store.find(planHash({ tool: 'x', host: 'y', input: {} }))).toBeUndefined();
  });

  it('is single use: a spent approval is never found again', async () => {
    const pending = request();
    await grantApproval(store, pending);

    expect(await store.find(pending.plan_hash)).toBeDefined();
    await store.consume(pending.id);
    expect(await store.find(pending.plan_hash)).toBeUndefined();
  });

  it('will not find an expired approval', async () => {
    const pending = request();
    let clock = new Date('2026-09-29T10:00:00.000Z');
    const timed = new FileApprovalStore({ dir, now: () => clock });

    await grantApproval(timed, pending, { ttlMs: 60_000, now: () => clock });
    expect(await timed.find(pending.plan_hash)).toBeDefined();

    clock = new Date('2026-09-29T10:01:01.000Z');
    expect(await timed.find(pending.plan_hash)).toBeUndefined();
  });

  it('refuses to grant the same request twice', async () => {
    const pending = request();
    await grantApproval(store, pending);

    await expect(grantApproval(store, pending)).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });

  it('reads back a pending request so a human can see the arguments', async () => {
    const pending = request();
    await store.record(pending);

    const read = await store.readRequest(pending.id);
    expect(read).toEqual(pending);
    expect((await store.pending()).map((item) => item.id)).toEqual([pending.id]);
  });

  it('ignores a file that is not a valid approval rather than trusting it', async () => {
    // The store reads from disk, and disk is not a trusted input: a malformed
    // or hand-edited file must not become an approval by accident.
    await mkdir(join(dir, 'approvals'), { recursive: true });
    await writeFile(join(dir, 'approvals', 'apr_deadbeef.json'), '{"nonsense": true}', 'utf8');
    await writeFile(join(dir, 'approvals', 'apr_f00dface.json'), 'not json', 'utf8');

    expect(await store.all()).toEqual([]);
    expect(await store.find('a'.repeat(64))).toBeUndefined();
  });

  it('copes with a store that does not exist yet', async () => {
    const fresh = new FileApprovalStore({ dir: join(dir, 'nothing-here') });

    expect(await fresh.all()).toEqual([]);
    expect(await fresh.pending()).toEqual([]);
    expect(await fresh.find('a'.repeat(64))).toBeUndefined();
  });

  it('throws rather than inventing one when asked to spend an approval that is not there', async () => {
    await expect(store.consume(newRequestId())).rejects.toThrowError(DwaraError);
  });

  it('writes approvals and requests to separate directories', async () => {
    const pending = request();
    await store.record(pending);
    await grantApproval(store, pending);

    expect(await readdir(join(dir, 'pending'))).toEqual([`${pending.id}.json`]);
    expect(await readdir(join(dir, 'approvals'))).toEqual([`${pending.id}.json`]);

    const onDisk: unknown = JSON.parse(
      await readFile(join(dir, 'approvals', `${pending.id}.json`), 'utf8'),
    );
    expect(onDisk).toMatchObject({ plan_hash: pending.plan_hash, approved_by: 'cli' });
  });
});
