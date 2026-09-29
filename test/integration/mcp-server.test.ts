import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, verifyChain } from '@dwara/core';
import { buildServer } from '@dwara/mcp-server';

/**
 * The MCP server driven by a real MCP client, against the lab.
 *
 * In-memory transport rather than a subprocess: it exercises the same protocol
 * handlers while letting the test inspect the audit log the server wrote.
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

let dir: string;
let client: Client;
let auditPath: string;
let toolNames: readonly string[];

/** Reads a tool result's JSON payload. */
function payload(result: unknown): {
  ok: boolean;
  tool: string;
  host: string;
  decision: { kind: string; rule: string };
  data?: { source: string; data: unknown; suspicions: { kind: string }[]; truncated: boolean };
  error?: { code: string; message: string; hint?: string };
} {
  const content = (result as { content: { type: string; text: string }[] }).content;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text);
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof payload>> {
  return payload(await client.callTool({ name, arguments: args }));
}

describeTestbed('dwara MCP server', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-mcp-'));
    auditPath = join(dir, 'audit.jsonl');

    await mkdir(join(dir, 'runbooks'), { recursive: true });
    await writeFile(
      join(dir, 'runbooks', 'crash-loop.md'),
      '# Crash loop\n\nCheck restart counts, then the unit journal.\n',
      'utf8',
    );

    const built = await buildServer({
      policyPath: 'testbed/policy.yaml',
      sshConfigPath: 'testbed/ssh_config',
      auditPath,
      runbooksPath: join(dir, 'runbooks'),
      agent: 'vitest',
    });
    toolNames = built.toolNames;

    client = new Client({ name: 'test-client', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
  }, 120_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('advertises every tool under a name prefixed by its risk class', async () => {
    const { tools } = await client.listTools();

    // Client permission rules match on the prefix, so every name must carry
    // it, and the mutating tools must be separable from the reads by name
    // alone -- that is what lets a client auto-allow read_* and prompt for the
    // rest without knowing which tools exist.
    for (const tool of tools) expect(tool.name).toMatch(/^(read|reversible|config)_/);

    expect(tools.filter((tool) => tool.name.startsWith('read_'))).toHaveLength(11);
    expect(tools.filter((tool) => tool.name.startsWith('reversible_')).map((t) => t.name)).toEqual([
      'reversible_restart_service',
      'reversible_restart_container',
    ]);
    expect(tools.map((t) => t.name).sort()).toEqual([...toolNames].sort());
  });

  it('advertises an input schema that requires a host', async () => {
    const { tools } = await client.listTools();
    const overview = tools.find((tool) => tool.name === 'read_host_overview');

    expect(overview?.inputSchema.required).toContain('host');
    expect(overview?.description).toContain('host_overview' in {} ? '' : 'Orientation');
  });

  it('offers no tool that could grant an approval', async () => {
    // CLAUDE.md rule 5. The check is deliberately blunt.
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/approve|approval|grant|allow|policy/i);
    }
  });

  it('runs a read tool against a real host', async () => {
    const result = await call('read_host_overview', { host: 'lab-api' });

    expect(result.ok).toBe(true);
    expect(result.decision.kind).toBe('allow');
    expect(result.data?.source).toBe('untrusted-server-output');

    const data = result.data?.data as { kernel: string; systemd: { state: string } };
    expect(data.kernel).toContain('Linux');
    expect(['running', 'degraded']).toContain(data.systemd.state);
  }, 60_000);

  it('reads a service status', async () => {
    const result = await call('read_service_status', { host: 'lab-api', unit: 'nginx' });
    const data = result.data?.data as { activeState: string; assessment: string };

    expect(data.activeState).toBe('active');
    expect(data.assessment).toBe('running normally');
  }, 60_000);

  it('refuses a host outside the policy, naming the rule', async () => {
    const result = await call('read_host_overview', { host: 'lab-ghost' });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_HOST');
    expect(result.decision.rule).toBeTruthy();
  }, 60_000);

  it('refuses a denied path without reaching the host', async () => {
    const result = await call('read_read_config', { host: 'lab-api', path: '/etc/shadow' });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('deny-list');
  }, 60_000);

  it('rejects arguments that fail the schema', async () => {
    // The advertised schema is the tool's own, so the SDK validates against it
    // before the handler runs and answers with a protocol error rather than a
    // tool result. That is the desired outcome: the call never reaches a host.
    const result = await client
      .callTool({ name: 'read_service_status', arguments: { host: 'lab-api' } })
      .catch((err: unknown) => err);

    const text =
      result instanceof Error
        ? result.message
        : ((result as { content?: { text?: string }[] }).content?.[0]?.text ?? '');

    expect(text).toMatch(/unit/i);
  }, 60_000);

  it('does not record a schema rejection as a host action', async () => {
    // It never reached a host, so it must not appear as one in the audit log.
    const entries = await new AuditLog({ path: auditPath }).read();
    expect(
      entries.every((entry) => entry.tool !== 'read_service_status' || entry.result !== 'error'),
    ).toBe(true);
  }, 60_000);

  it('exposes runbooks as resources', async () => {
    const { resources } = await client.listResources();
    const runbook = resources.find((resource) => resource.uri === 'dwara://runbook/crash-loop');

    expect(runbook?.mimeType).toBe('text/markdown');

    const read = await client.readResource({ uri: 'dwara://runbook/crash-loop' });
    expect((read.contents[0] as { text: string }).text).toContain('Check restart counts');
  });

  it('records every call in a verifiable audit chain', async () => {
    const entries = await new AuditLog({ path: auditPath }).read();

    expect(entries.length).toBeGreaterThan(3);
    expect(entries.every((entry) => entry.agent === 'vitest')).toBe(true);
    // Refusals are in there too, not only the calls that worked.
    expect(entries.some((entry) => entry.result === 'refused')).toBe(true);
    expect(verifyChain(entries)).toMatchObject({ ok: true });
  }, 60_000);

  it('records no tool output in the audit log', async () => {
    const entries = await new AuditLog({ path: auditPath }).read();
    for (const entry of entries) {
      expect(entry.detail).not.toContain('Linux');
      expect(Object.keys(entry)).not.toContain('output');
    }
  });
});
