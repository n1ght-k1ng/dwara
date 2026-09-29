import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileApprovalStore, newRequestId, planHash, type ApprovalRequest } from '@dwara/core';
import { approve, formatRequest, listPending } from './approve.js';

let dir: string;
let store: FileApprovalStore;

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const input = { host: 'lab-api', unit: 'nginx' };
  return {
    id: newRequestId(),
    plan_hash: planHash({ tool: 'restart_service', host: 'lab-api', input }),
    tool: 'reversible_restart_service',
    host: 'lab-api',
    risk: 'reversible',
    input,
    reason: 'policy requires approval for reversible on lab-api',
    created_at: '2026-09-29T10:00:00.000Z',
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-approve-cli-'));
  store = new FileApprovalStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('formatRequest', () => {
  it('shows a person everything the approval would authorise', () => {
    const text = formatRequest(request());

    expect(text).toContain('reversible_restart_service');
    expect(text).toContain('lab-api');
    expect(text).toContain('unit: "nginx"');
    expect(text).toContain('policy requires approval');
    // An approval bound to a hash is worthless if the human could not see the
    // plan, and worse if they did not know it was single use.
    expect(text).toContain('exactly this, once');
  });

  it('says so plainly when there is nothing but the host', () => {
    expect(formatRequest(request({ input: { host: 'lab-api' } }))).toContain('Arguments: none');
  });
});

describe('approve', () => {
  it('grants only after the human says yes', async () => {
    const pending = request();
    await store.record(pending);

    const result = await approve(pending.id, { dir, confirm: () => Promise.resolve(true) });

    expect(result.ok).toBe(true);
    expect(result.approval?.plan_hash).toBe(pending.plan_hash);
    expect(await store.find(pending.plan_hash)).toBeDefined();
    expect(result.text).toContain('for this one action');
  });

  it('grants nothing when the human says no', async () => {
    const pending = request();
    await store.record(pending);

    const result = await approve(pending.id, { dir, confirm: () => Promise.resolve(false) });

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Not approved');
    expect(await store.all()).toEqual([]);
  });

  it('shows the plan before it asks, not after', async () => {
    const pending = request();
    await store.record(pending);
    const confirm = vi.fn<(question: string) => Promise<boolean>>(() => Promise.resolve(false));

    await approve(pending.id, { dir, confirm });

    const question = confirm.mock.calls[0]?.[0] ?? '';
    expect(question).toContain('unit: "nginx"');
    expect(question).toContain('Approve this?');
  });

  it('honours --yes for non-interactive use', async () => {
    const pending = request();
    await store.record(pending);
    const confirm = vi.fn<(question: string) => Promise<boolean>>(() => Promise.resolve(false));

    const result = await approve(pending.id, { dir, yes: true, confirm });

    expect(result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('applies the requested lifetime', async () => {
    const pending = request();
    await store.record(pending);

    const result = await approve(pending.id, { dir, yes: true, ttlMs: 60_000 });
    const lifetime =
      Date.parse(result.approval?.expires_at ?? '') -
      Date.parse(result.approval?.approved_at ?? '');

    expect(lifetime).toBe(60_000);
    expect(result.text).toContain('1 minute(s)');
  });

  it('refuses an id that is not waiting', async () => {
    await expect(approve(newRequestId(), { dir, yes: true })).rejects.toMatchObject({
      hint: expect.stringContaining('--list') as unknown,
    });
  });

  it('refuses an id shaped to escape the directory', async () => {
    for (const bad of ['../../etc/passwd', 'apr_../x', '..']) {
      await expect(approve(bad, { dir, yes: true })).rejects.toThrowError(/no request/);
    }
  });

  it('will not grant the same request twice', async () => {
    const pending = request();
    await store.record(pending);
    await approve(pending.id, { dir, yes: true });

    await expect(approve(pending.id, { dir, yes: true })).rejects.toMatchObject({
      code: 'PLAN_MISMATCH',
    });
  });
});

describe('listPending', () => {
  it('says so when there is nothing waiting', async () => {
    expect(await listPending(dir)).toContain('Nothing is waiting');
  });

  it('lists what needs a human, and what has already been decided', async () => {
    const waiting = request();
    const decided = request();
    await store.record(waiting);
    await store.record(decided);
    await approve(decided.id, { dir, yes: true });

    const text = await listPending(dir);

    expect(text).toContain(`${waiting.id}  reversible_restart_service on lab-api  (needs you)`);
    expect(text).toContain(
      `${decided.id}  reversible_restart_service on lab-api  (approved, not yet used)`,
    );
  });

  it('marks an approval that has been spent', async () => {
    const pending = request();
    await store.record(pending);
    await approve(pending.id, { dir, yes: true });
    await store.consume(pending.id);

    expect(await listPending(dir)).toContain('already used');
  });
});
