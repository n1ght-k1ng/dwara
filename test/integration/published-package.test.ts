import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The single published artifact: three binaries bundled from the workspace.
 *
 * These run the **built** files rather than the sources, because every bug this
 * suite exists for only appears after bundling. The first version of the entry
 * points imported each package and also called its `main()`, so each binary ran
 * twice -- `dwara-hook` emitted two JSON decisions for one stdin, which a client
 * would read as a protocol violation. Nothing in the unit tests could see it.
 *
 * Requires `pnpm build`. Skipped otherwise rather than failing, so a fresh clone
 * running `pnpm test` is not told something is broken when it merely is not built.
 */
const DIST = 'packages/dwara/dist';
const built = await readFile(`${DIST}/hook.js`, 'utf8').then(
  () => true,
  () => false,
);
const describeBuilt = built ? describe : describe.skip;

describeBuilt('the published package', () => {
  it('runs the hook exactly once per input', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ssh lab-api uptime' },
      cwd: '/tmp',
    });

    // execFileSync, because the hook reads its request from stdin and `execFile`
    // has no `input` -- passing one made the first version of this test sit for a
    // minute waiting on a pipe that was never written.
    const stdout = execFileSync('node', [`${DIST}/hook.js`], {
      input,
      encoding: 'utf8',
      timeout: 20_000,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse' },
    });
  });

  it('runs the CLI exactly once', () => {
    // `doctor` on no hosts is the cheapest command that prints a summary line.
    const stdout = execFileSync('node', [`${DIST}/cli.js`, '--version'], {
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('exposes the three binaries the published manifest promises', async () => {
    const pkg = JSON.parse(await readFile('packages/dwara/package.json', 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(Object.keys(pkg.bin).sort()).toEqual(['dwara', 'dwara-hook', 'dwara-mcp']);

    for (const target of Object.values(pkg.bin)) {
      const body = await readFile(`packages/dwara/${target.replace('./', '')}`, 'utf8');
      // npm sets the executable bit from `bin`, but the shebang has to be there.
      expect(body.startsWith('#!/usr/bin/env node')).toBe(true);
    }
  });

  it('keeps third-party dependencies external and inlines only our own', async () => {
    // The point of the bundle: our packages are inlined so they can stay private,
    // and the six real dependencies stay visible to `npm audit`.
    const body = await readFile(`${DIST}/mcp.js`, 'utf8');

    expect(body).toMatch(/from ['"]@modelcontextprotocol\/sdk/u);
    expect(body).not.toMatch(/from ['"]@dwara\//u);
  });

  it('ships nothing from the lab, the eval harness or local state', async () => {
    const pkg = JSON.parse(await readFile('packages/dwara/package.json', 'utf8')) as {
      files: string[];
    };

    expect(pkg.files.sort()).toEqual(['LICENSE', 'README.md', 'dist', 'plugin']);
    for (const entry of pkg.files) {
      expect(entry).not.toMatch(/testbed|evals|\.dwara|\.keys/u);
    }
  });

  it('is still private, so it cannot be published by accident', async () => {
    // Flipping this is the deliberate act that makes a release possible, and it
    // should be its own commit with the name and the token decided.
    const pkg = JSON.parse(await readFile('packages/dwara/package.json', 'utf8')) as {
      private?: boolean;
    };

    expect(pkg.private).toBe(true);
  });
});
