import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '@dwara/core';
import { formatAudit, readAudit, verifyAudit } from './audit.js';

let dir: string;
let file: string;

/** Writes a small, genuinely chained log. */
async function seed(): Promise<void> {
  const log = new AuditLog({ path: file });
  await log.append({
    session: 's_1',
    agent: 'claude-code',
    tool: 'read_host_overview',
    host: 'lab-api',
    risk: 'read' as never,
    decision: 'allow',
    rule: 'defaults.allow',
    input: {},
    result: 'ok',
    detail: '1 command',
    duration_ms: 12,
    policy_hash: 'p',
  });
  await log.append({
    session: 's_1',
    agent: 'claude-code',
    tool: 'config_edit_config',
    host: 'lab-api',
    risk: 'config' as never,
    decision: 'approval',
    rule: 'hosts[lab-api].require_approval',
    code: 'APPROVAL_REQUIRED',
    approval: 'apr_0a1b2c3d',
    input: {},
    result: 'refused',
    detail: 'needs a human',
    duration_ms: 3,
    policy_hash: 'p',
  });
  await log.append({
    session: 's_1',
    agent: 'claude-code',
    tool: 'config_edit_config',
    host: 'lab-api',
    risk: 'config' as never,
    decision: 'approval',
    rule: 'hosts[lab-api].require_approval',
    approval: 'apr_0a1b2c3d',
    snapshot: 'snap_0a1b2c3d',
    input: {},
    result: 'verified',
    detail: '2 checks passed',
    duration_ms: 4120,
    policy_hash: 'p',
  });
  await log.append({
    session: 's_1',
    agent: 'claude-code',
    tool: 'reversible_restart_service',
    host: 'lab-db',
    risk: 'reversible' as never,
    decision: 'allow',
    rule: 'hosts[lab-db].allow',
    input: {},
    result: 'rolled_back',
    detail: 'did not verify',
    duration_ms: 900,
    policy_hash: 'p',
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-audit-cli-'));
  file = join(dir, 'audit.jsonl');
  await seed();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readAudit', () => {
  it('reads everything by default', async () => {
    expect(await readAudit({ file })).toHaveLength(4);
  });

  it('filters by host', async () => {
    const entries = await readAudit({ file, host: 'lab-db' });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe('reversible_restart_service');
  });

  it('matches a tool by its bare name as well as its prefixed one', async () => {
    // Policy files, audit filters and humans all use the bare name; only the
    // MCP layer speaks the prefixed one.
    expect(await readAudit({ file, tool: 'edit_config' })).toHaveLength(2);
    expect(await readAudit({ file, tool: 'config_edit_config' })).toHaveLength(2);
  });

  it('shows only what changed a host, or tried to', async () => {
    const entries = await readAudit({ file, mutationsOnly: true });

    expect(entries.map((entry) => entry.result)).toEqual(['refused', 'verified', 'rolled_back']);
  });

  it('limits to the most recent entries', async () => {
    const entries = await readAudit({ file, limit: 2 });

    expect(entries).toHaveLength(2);
    expect(entries[1]?.result).toBe('rolled_back');
  });
});

describe('formatAudit', () => {
  it('puts the approval and the snapshot on the line that used them', async () => {
    const text = await formatAudit({ file });

    expect(text).toContain('apr_0a1b2c3d');
    expect(text).toContain('snap_0a1b2c3d');
    expect(text).toContain('config_edit_config');
  });

  it('counts how many entries actually changed something', async () => {
    // "16 tool calls" is not the interesting number; "2 of them changed a
    // host" is what someone reading this after an incident wants.
    expect(await formatAudit({ file })).toContain('4 entries, 2 of which changed a host.');
  });

  it('says so plainly when nothing matches', async () => {
    expect(await formatAudit({ file, host: 'nowhere' })).toBe('No audit entries match.');
  });
});

describe('verifyAudit', () => {
  it('confirms an untouched chain', async () => {
    const report = await verifyAudit(file);

    expect(report.ok).toBe(true);
    expect(report.text).toContain('4 entries, chain intact');
  });

  it('catches an edited entry', async () => {
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('"host":"lab-db"', '"host":"lab-api"'), 'utf8');

    const report = await verifyAudit(file);

    expect(report.ok).toBe(false);
    expect(report.text).toContain('BROKEN');
    expect(report.text).toContain('line 4');
    expect(report.text).toContain('bad-hash');
    expect(report.text).toContain('Every entry after the first problem is suspect');
  });

  it('catches a deleted line', async () => {
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    await writeFile(file, `${[lines[0], lines[2], lines[3]].join('\n')}\n`, 'utf8');

    expect((await verifyAudit(file)).ok).toBe(false);
  });

  it('is fine with a log that does not exist yet', async () => {
    expect((await verifyAudit(join(dir, 'nothing.jsonl'))).ok).toBe(true);
  });
});
