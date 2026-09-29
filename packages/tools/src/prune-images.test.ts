import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand } from '@dwara/core';
import { createPruneImages, pruneImages } from './prune-images.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

function ctxWith(respond: (command: RemoteCommand) => Partial<RawResult>): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-staging',
    sessionId: 's_test',
    httpChecks: [],
    async run(command) {
      calls.push(command);
      return {
        argv: command.argv,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        ...respond(command),
      };
    },
  };
}

const PRUNE_OUTPUT = `Deleted Images:
untagged: sha256:0c26c1502d47bb0092f651b78cf04c95ce04f6e6d4b422052b7d649bc5ca2b8a
deleted: sha256:0c26c1502d47bb0092f651b78cf04c95ce04f6e6d4b422052b7d649bc5ca2b8a
untagged: sha256:5245c4ce7d953b9fdbc097be3afbe834fde3580a1cff4c5de5427d00bd3f8987
deleted: sha256:5245c4ce7d953b9fdbc097be3afbe834fde3580a1cff4c5de5427d00bd3f8987

Total reclaimed space: 1.2GB`;

function host(options: { dangling?: number; prune?: Partial<RawResult> } = {}): FakeCtx {
  const dangling = options.dangling ?? 2;
  let pruned = false;

  return ctxWith((command) => {
    const [program] = command.argv;

    if (program === 'df') return { stdout: `Use%\n ${pruned ? '15' : '92'}%\n` };
    if (program === 'docker' && command.argv[1] === 'images') {
      return {
        stdout: Array.from({ length: dangling }, (_, i) =>
          JSON.stringify({
            ID: `abc${i}`,
            Size: '324MB',
            CreatedSince: '24 hours ago',
            Repository: '<none>',
          }),
        ).join('\n'),
      };
    }
    if (program === 'docker' && command.argv[1] === 'image') {
      pruned = true;
      return { stdout: PRUNE_OUTPUT, ...options.prune };
    }
    return {};
  });
}

describe('prune_images shape', () => {
  it('is reversible, unrestorable, and carries the required machinery', () => {
    expect(pruneImages.risk).toBe('reversible');
    expect(pruneImages.restorable).toBe(false);
    expect(pruneImages.snapshot).toBeTypeOf('function');
    expect(pruneImages.verify).toBeTypeOf('function');
    expect(
      pruneImages.rollback?.({
        id: 'snap_0a1b2c3d',
        host: 'h',
        createdAt: '',
        paths: [],
        hashes: {},
      }),
    ).toEqual([]);
  });
});

describe('prune_images never removes more than dangling layers', () => {
  it('builds no -a flag, whatever it is asked', async () => {
    const ctx = host();
    await pruneImages.apply({ host: 'h' }, ctx);
    const prune = ctx.calls.find((call) => call.argv[1] === 'image');

    // The whole safety property. `-a` would remove the previous release you
    // would roll back to, and every image a stopped container needs to start.
    expect(prune?.argv).toEqual(['docker', 'image', 'prune', '-f']);
    for (const call of ctx.calls) {
      expect(call.argv).not.toContain('-a');
      expect(call.argv).not.toContain('--all');
    }
  });

  it('rejects an input that tries to smuggle a flag through olderThan', () => {
    for (const bad of ['-a', '24h -a', '--all', 'all', '', '24 h']) {
      expect(pruneImages.input.safeParse({ host: 'h', olderThan: bad }).success, bad).toBe(false);
    }
    expect(pruneImages.input.safeParse({ host: 'h', olderThan: '168h' }).success).toBe(true);
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(pruneImages.input.safeParse({ host: 'h', all: true }).success).toBe(false);
  });

  it('passes a valid age through as a filter', async () => {
    const ctx = host();
    await pruneImages.apply({ host: 'h', olderThan: '168h' }, ctx);

    expect(ctx.calls.find((call) => call.argv[1] === 'image')?.argv).toEqual([
      'docker',
      'image',
      'prune',
      '-f',
      '--filter',
      'until=168h',
    ]);
  });

  it('uses no sudo, because docker group membership already carries it', async () => {
    const ctx = host();
    await pruneImages.apply({ host: 'h' }, ctx);

    // A sudoers rule constraining docker would be decoration: the same command
    // succeeds without it. The limit lives in the argv above.
    for (const call of ctx.calls.filter((item) => item.argv[0] === 'docker')) {
      expect(call.sudo).toBeUndefined();
    }
  });
});

describe('prune_images parsing', () => {
  it('reports what was found, what went, and what came back', async () => {
    const ctx = host();
    const result = pruneImages.parse(await pruneImages.apply({ host: 'h' }, ctx));

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toEqual({
      id: 'abc0',
      size: '324MB',
      createdSince: '24 hours ago',
    });
    expect(result.deleted).toEqual(['0c26c1502d47', '5245c4ce7d95']);
    expect(result.reclaimed).toBe('1.2GB');
    expect(result.freePercentBefore).toBe(8);
    expect(result.freePercentAfter).toBe(85);
    expect(result.assessment).toBe('removed 2 dangling image(s), reclaiming 1.2GB');
  });

  it('warns that shared layers mean little space comes back', async () => {
    // A real prune on the lab reclaimed 3.424kB from four images of 324MB
    // each, because their layers were shared with images that remained. The
    // arithmetic surprises people, so it is said rather than left implied.
    const ctx = host({ prune: { stdout: PRUNE_OUTPUT.replace('1.2GB', '3.424kB') } });
    const result = pruneImages.parse(await pruneImages.apply({ host: 'h' }, ctx));

    expect(result.assessment).toContain('layers are shared');
  });

  it('says plainly when there was nothing to do', async () => {
    const ctx = host({ dangling: 0, prune: { stdout: 'Total reclaimed space: 0B' } });
    const result = pruneImages.parse(await pruneImages.apply({ host: 'h' }, ctx));

    expect(result.deleted).toEqual([]);
    expect(result.assessment).toBe('there were no dangling images to remove');
  });

  it('carries docker its own words when it refuses', async () => {
    const ctx = host({ prune: { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' } });
    const result = pruneImages.parse(await pruneImages.apply({ host: 'h' }, ctx));

    expect(result.error).toContain('Cannot connect to the Docker daemon');
    expect(result.assessment).toBe('docker refused the prune; nothing was removed');
  });

  it('notes when candidates were found but nothing was removed', async () => {
    const ctx = host({ prune: { stdout: 'Total reclaimed space: 0B' } });
    const result = pruneImages.parse(await pruneImages.apply({ host: 'h' }, ctx));

    expect(result.assessment).toContain('none were removed; they are still referenced');
  });
});

describe('createPruneImages', () => {
  it('lets the integration suite shorten the prune deadline', async () => {
    const ctx = host();
    await createPruneImages({ pruneTimeoutMs: 5 }).apply({ host: 'h' }, ctx);

    expect(ctx.calls.find((call) => call.argv[1] === 'image')?.timeoutMs).toBe(5);
  });
});
