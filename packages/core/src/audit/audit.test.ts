import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Risk } from '../types.js';
import { AuditLog } from './log.js';
import { verifyChain } from './verify.js';
import { GENESIS_HASH, canonicalise, hashEntry } from './entry.js';

let dir: string;
let log: AuditLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dwara-audit-'));
  log = new AuditLog({ path: join(dir, 'audit.jsonl') });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A plausible entry, with the fields under test overridable. */
function entry(over: Partial<Parameters<AuditLog['append']>[0]> = {}) {
  return {
    session: 's_test',
    agent: 'claude-code',
    tool: 'read_service_status',
    host: 'lab-api',
    risk: Risk.Read,
    decision: 'allow' as const,
    rule: 'defaults',
    input: { host: 'lab-api', unit: 'nginx' },
    result: 'ok' as const,
    detail: 'active',
    duration_ms: 42,
    policy_hash: 'a'.repeat(64),
    ...over,
  };
}

describe('canonicalise', () => {
  it('sorts keys so the hash does not depend on serialiser order', () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
    expect(canonicalise({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('handles nested structures and primitives', () => {
    expect(canonicalise({ z: [3, { y: 1, x: 2 }], a: null })).toBe(
      '{"a":null,"z":[3,{"x":2,"y":1}]}',
    );
    expect(canonicalise('text')).toBe('"text"');
    expect(canonicalise(null)).toBe('null');
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('AuditLog', () => {
  it('starts a chain from the genesis hash', async () => {
    const written = await log.append(entry());
    expect(written.prev_hash).toBe(GENESIS_HASH);
    expect(written.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each entry to the one before it', async () => {
    const first = await log.append(entry());
    const second = await log.append(entry({ tool: 'read_tail_logs' }));
    const third = await log.append(entry({ tool: 'read_disk_usage' }));

    expect(second.prev_hash).toBe(first.hash);
    expect(third.prev_hash).toBe(second.hash);
    expect(verifyChain([first, second, third]).ok).toBe(true);
  });

  it('records refusals, not just successes', async () => {
    // A log holding only successful actions describes an agent that never hit
    // a limit, which is the opposite of what a review needs.
    await log.append(
      entry({ decision: 'deny', result: 'refused', code: 'DENIED_BY_POLICY', rule: 'tools.never' }),
    );

    const [written] = await log.read();
    expect(written).toMatchObject({
      decision: 'deny',
      result: 'refused',
      code: 'DENIED_BY_POLICY',
    });
  });

  it('redacts secrets out of inputs before writing', async () => {
    await log.append(
      entry({ input: { host: 'lab-api', url: 'postgres://u:S3cretP4ss@db:5432/x' } }),
    );

    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(raw).not.toContain('S3cretP4ss');
    expect(raw).toContain('[REDACTED:');
    // The host stays readable: it is the diagnostic value.
    expect(raw).toContain('db:5432');
  });

  it('redacts the detail field too', async () => {
    await log.append(entry({ detail: 'failed with AKIAIOSFODNN7EXAMPLE' }));
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('stores no tool output', async () => {
    // Deliberate: an audit log full of server output is a second copy of
    // everything the redactor protects, in a file people treat as shareable.
    const written = await log.append(entry());
    expect(Object.keys(written)).not.toContain('output');
    expect(Object.keys(written)).not.toContain('stdout');
  });

  it('reads an absent log as empty', async () => {
    expect(await new AuditLog({ path: join(dir, 'nothing.jsonl') }).read()).toEqual([]);
  });

  it('survives a trailing newline', async () => {
    await log.append(entry());
    await writeFile(
      join(dir, 'audit.jsonl'),
      `${await readFile(join(dir, 'audit.jsonl'), 'utf8')}\n`,
    );
    expect(await log.read()).toHaveLength(1);
  });

  it('reports a corrupt line with its number', async () => {
    await log.append(entry());
    await writeFile(join(dir, 'audit.jsonl'), 'not json\n', { flag: 'a' });

    await expect(log.read()).rejects.toThrowError(/line 2 is not valid JSON/);
  });

  it('reports a line that is JSON but not an entry', async () => {
    await writeFile(join(dir, 'audit.jsonl'), '{"ts":"now"}\n');
    await expect(log.read()).rejects.toThrowError(/line 1 is not a valid entry/);
  });

  it('continues the chain across instances', async () => {
    const first = await log.append(entry());

    // A second process appending to the same file must pick up the tail rather
    // than starting a new chain.
    const reopened = new AuditLog({ path: join(dir, 'audit.jsonl') });
    const second = await reopened.append(entry({ tool: 'read_open_ports' }));

    expect(second.prev_hash).toBe(first.hash);
    expect(verifyChain(await log.read()).ok).toBe(true);
  });
});

describe('verifyChain', () => {
  it('accepts an empty log', () => {
    expect(verifyChain([])).toEqual({ ok: true, entries: 0, problems: [] });
  });

  it('detects an edited field on any line', async () => {
    await log.append(entry());
    await log.append(entry({ tool: 'read_tail_logs' }));
    await log.append(entry({ tool: 'read_disk_usage' }));

    const entries = await log.read();
    // Change the host on the middle entry and leave its hash alone.
    const tampered = entries.map((e, i) => (i === 1 ? { ...e, host: 'lab-db' } : e));

    const report = verifyChain(tampered);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatchObject({ line: 2, kind: 'bad-hash' });
  });

  it('detects a deleted line', async () => {
    await log.append(entry());
    await log.append(entry({ tool: 'read_tail_logs' }));
    await log.append(entry({ tool: 'read_disk_usage' }));

    const entries = await log.read();
    const report = verifyChain([entries[0]!, entries[2]!]);

    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatchObject({ line: 2, kind: 'broken-link' });
  });

  it('detects reordered lines', async () => {
    await log.append(entry());
    await log.append(entry({ tool: 'read_tail_logs' }));

    const entries = await log.read();
    expect(verifyChain([entries[1]!, entries[0]!]).ok).toBe(false);
  });

  it('detects removal of the start of the log', async () => {
    await log.append(entry());
    await log.append(entry({ tool: 'read_tail_logs' }));

    const entries = await log.read();
    const report = verifyChain([entries[1]!]);

    expect(report.problems[0]).toMatchObject({ line: 1, kind: 'bad-genesis' });
  });

  it('accepts a line whose hash was recomputed after editing it', async () => {
    // Stated plainly because it is the honest limit: the chain detects
    // tampering, it does not prevent it. Anyone who can write the file can
    // rewrite it from a point onwards. What they cannot do is change one line
    // and leave the rest intact.
    await log.append(entry());
    const entries = await log.read();

    const { hash, ...rest } = { ...entries[0]!, host: 'lab-db' };
    expect(hash).toBeTruthy();
    const rehashed = { ...rest, hash: hashEntry(rest) };

    expect(verifyChain([rehashed]).ok).toBe(true);
  });

  it('reports every problem, not just the first', async () => {
    await log.append(entry());
    await log.append(entry({ tool: 'read_tail_logs' }));

    const entries = await log.read();
    const tampered = entries.map((e) => ({ ...e, host: 'lab-db' }));

    expect(verifyChain(tampered).problems.length).toBeGreaterThanOrEqual(2);
  });
});
