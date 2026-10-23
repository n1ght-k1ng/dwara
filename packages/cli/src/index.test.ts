import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '@dwara/core';
import { PACKAGE_NAME, VERSION, buildProgram } from './index.js';

describe('@dwara/cli', () => {
  it('reports its package identity', () => {
    expect(PACKAGE_NAME).toBe('@dwara/cli');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * `audit verify` is wired through Commander, and the bug this covers was one the
 * function-level tests could not see: the subcommand declared its own `-f` while
 * the parent `audit` command also declared one, and Commander binds a `-f` typed
 * after the subcommand to the *parent*. So `dwara audit verify -f other.jsonl`
 * silently verified the default `.dwara/audit.jsonl` and reported it intact — an
 * integrity check that ignored the file it was handed. Found on a live host.
 *
 * These tests drive the whole program so the wiring is what is under test, not
 * `verifyAudit` in isolation.
 */
describe('dwara audit verify (CLI wiring)', () => {
  let dir: string;
  let log: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-cli-verify-'));
    log = join(dir, 'chain.jsonl');

    // A real two-entry chain, appended through AuditLog so the hashes are valid.
    const audit = new AuditLog({ path: log });
    const base = {
      session: 's1',
      agent: 'test',
      host: 'lab-api',
      rule: 'defaults.allow',
      input: {},
      detail: '',
      duration_ms: 1,
      policy_hash: 'p',
      decision: 'allow',
      result: 'ok',
    } as const;
    await audit.append({ ...base, tool: 'read_host_overview', risk: 'read' as never });
    await audit.append({ ...base, tool: 'read_disk_usage', risk: 'read' as never });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function run(argv: readonly string[]): Promise<string> {
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    try {
      await buildProgram().parseAsync(['node', 'dwara', ...argv]);
    } finally {
      spy.mockRestore();
    }
    return out.join('\n');
  }

  it('verifies the file given with -f, not the default', async () => {
    const text = await run(['audit', 'verify', '-f', log]);
    expect(text).toContain(log);
    expect(text).toContain('2 entries, chain intact');
  });

  it('honours --file as well', async () => {
    const text = await run(['audit', 'verify', '--file', log]);
    expect(text).toContain('2 entries, chain intact');
  });

  it('does not fall back to a different file when the given one is empty', async () => {
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '', 'utf8');
    const text = await run(['audit', 'verify', '-f', empty]);
    // Zero entries, reported against the file asked about — never a silent read
    // of some other log that happens to exist.
    expect(text).toContain(empty);
    expect(text).not.toContain('2 entries');
  });
});
