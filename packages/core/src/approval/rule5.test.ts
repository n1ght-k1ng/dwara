import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileApprovalStore, type ApprovalStore } from './store.js';

/**
 * CLAUDE.md rule 5: **the agent can never approve its own action.**
 *
 * Checked structurally rather than argued for, because it is the guarantee the
 * whole approval flow exists to provide and the kind that decays quietly. A
 * future tool that imported `grantApproval` would compile, pass every other
 * test, and silently end the property.
 *
 * Two independent barriers, tested separately so that losing one is visible:
 *
 * 1. A tool's only capability is `Ctx.run`, which reaches a remote host. No
 *    tool can write a local file at all, so none can write an approval.
 * 2. Granting lives in a module the agent-facing packages do not import.
 */

/** Source with comments removed, so prose about the rule cannot trip the rule. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every .ts file under a package's src, recursively. */
async function sources(pkg: string): Promise<string[]> {
  const root = join(process.cwd(), 'packages', pkg, 'src');
  const found: string[] = [];

  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(next);
    }
  }

  await walk(root);
  return found;
}

const AGENT_FACING = ['tools', 'mcp-server'];

describe('rule 5 · no agent-facing code can grant an approval', () => {
  it.each(AGENT_FACING)('%s does not reference the granting module', async (pkg) => {
    const files = await sources(pkg);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = code(await readFile(file, 'utf8'));
      expect(text, file).not.toContain('grantApproval');
      expect(text, file).not.toContain('approval/grant');
    }
  });

  it('a tool never touches the approval machinery at all', async () => {
    // The MCP server legitimately constructs a store, because the pipeline has
    // to be able to spend an approval a human granted. A tool has no business
    // knowing approvals exist, and that line is worth holding separately.
    for (const file of await sources('tools')) {
      const text = code(await readFile(file, 'utf8'));
      expect(text, file).not.toContain('ApprovalStore');
      expect(text, file).not.toContain('approval');
    }
  });

  it.each(AGENT_FACING)('%s writes no local files at all', async (pkg) => {
    // The barrier that holds even if the import checks above are someday
    // defeated: agent-facing code has no local filesystem write path.
    for (const file of await sources(pkg)) {
      const text = code(await readFile(file, 'utf8'));
      for (const write of ['writeFile', 'appendFile', 'createWriteStream', 'mkdirSync', 'rmSync']) {
        expect(text, `${file} uses ${write}`).not.toContain(write);
      }
    }
  });

  it('the store interface the pipeline is given cannot create an approval', () => {
    // find, consume and record: read one, spend one, note that one was asked
    // for. Nothing that brings an approval into being.
    const store: ApprovalStore = new FileApprovalStore({ dir: '/nonexistent' });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
      (name) => name !== 'constructor',
    );

    expect(Object.keys(store satisfies ApprovalStore).concat(surface)).toEqual(
      expect.arrayContaining(['find', 'consume', 'record']),
    );
    expect(surface).not.toContain('grant');
    expect(surface).not.toContain('approve');
  });

  it('a tool is handed one capability, and it points at a remote host', async () => {
    // If Ctx ever gains a local-filesystem handle, this is where it shows up.
    const types = await readFile(join(process.cwd(), 'packages/core/src/types.ts'), 'utf8');
    const ctx = /export interface Ctx \{[\s\S]*?\n\}/.exec(types)?.[0] ?? '';

    expect(ctx).toContain('run(command: RemoteCommand): Promise<RawResult>');
    for (const name of ['writeFile', 'readFile', 'exec', 'spawn']) {
      expect(ctx, `Ctx exposes ${name}`).not.toContain(name);
    }
  });
});
