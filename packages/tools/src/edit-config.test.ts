import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand } from '@dwara/core';
import { DwaraError } from '@dwara/core';
import { UNEDITABLE_PATHS, editConfig } from './edit-config.js';
import { DEFAULT_CONFIG_PATHS } from './paths.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

const PATH = '/etc/nginx/sites-enabled/lab';

const CURRENT = [
  'server {',
  '    listen 80;',
  '    location / {',
  '        proxy_pass http://127.0.0.1:3999;',
  '    }',
  '}',
  '',
].join('\n');

const FIX = [
  '@@ -2,3 +2,3 @@',
  '     listen 80;',
  '     location / {',
  '-        proxy_pass http://127.0.0.1:3999;',
  '+        proxy_pass http://127.0.0.1:3000;',
  '',
].join('\n');

function ctxWith(
  respond: (command: RemoteCommand) => Partial<RawResult>,
  content = CURRENT,
): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-api',
    sessionId: 's_test',
    httpChecks: [],
    async run(command) {
      calls.push(command);
      const base = {
        argv: command.argv,
        exitCode: 0,
        stdout: command.argv[0] === 'cat' ? content : '',
        stderr: '',
        truncated: false,
        durationMs: 1,
      };
      return { ...base, ...respond(command) };
    },
  };
}

/** Runs plan, then apply with the hash plan produced. */
async function planThenApply(
  ctx: FakeCtx,
  over: { diff?: string; path?: string } = {},
): Promise<ReturnType<typeof editConfig.parse>> {
  const args = { host: 'lab-api', path: over.path ?? PATH, diff: over.diff ?? FIX };
  const planned = editConfig.parse(await editConfig.apply({ ...args, mode: 'plan' }, ctx));

  return editConfig.parse(
    await editConfig.apply({ ...args, mode: 'apply', planHash: planned.planHash }, ctx),
  );
}

describe('edit_config shape', () => {
  it('is config risk and carries the machinery the registry demands', () => {
    expect(editConfig.risk).toBe('config');
    expect(editConfig.snapshot).toBeTypeOf('function');
    expect(editConfig.verify).toBeTypeOf('function');
    expect(editConfig.rollback).toBeTypeOf('function');
    // Restorable, unlike the disk-freeing tools: the file really can go back.
    expect(editConfig.restorable).not.toBe(false);
  });

  it('snapshots the file and the service that reads it', () => {
    expect(editConfig.snapshot?.({ host: 'h', path: PATH, diff: FIX, mode: 'plan' })).toEqual({
      paths: [PATH],
      units: ['nginx'],
    });
  });

  it('insists on a planHash before it will apply anything', () => {
    const apply = editConfig.input.safeParse({ host: 'h', path: PATH, diff: FIX, mode: 'apply' });

    expect(apply.success).toBe(false);
    expect(editConfig.input.safeParse({ host: 'h', path: PATH, diff: FIX }).success).toBe(true);
  });
});

describe('edit_config path guarding', () => {
  it('refuses sshd_config, which is how people lock themselves out', async () => {
    const ctx = ctxWith(() => ({}));

    await expect(
      editConfig.apply({ host: 'h', path: '/etc/ssh/sshd_config', diff: FIX, mode: 'plan' }, ctx),
    ).rejects.toThrowError(/will not edit/);
    expect(UNEDITABLE_PATHS).toContain('/etc/ssh/**');
    expect(ctx.calls).toHaveLength(0);
  });

  it('refuses anything off the allow-list or outside it', async () => {
    const ctx = ctxWith(() => ({}));

    for (const path of ['/etc/shadow', '/tmp/x.conf', '/etc/nginx/../shadow', 'relative.conf']) {
      await expect(
        editConfig.apply({ host: 'h', path, diff: FIX, mode: 'plan' }, ctx),
      ).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    }
  });
});

describe('edit_config plan', () => {
  it('writes nothing and shows what the result would be', async () => {
    const ctx = ctxWith(() => ({}));
    const result = editConfig.parse(
      await editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, ctx),
    );

    expect(result.mode).toBe('plan');
    expect(result.preview).toContain('3000');
    expect(result.preview).not.toContain('3999');
    expect(result.planHash).toHaveLength(64);
    expect(result.changes).toEqual({ added: 1, removed: 1, hunks: 1 });
    // One command, and it only reads.
    expect(ctx.calls.map((call) => call.argv[0])).toEqual(['cat']);
  });

  it('names the validator and the reload that apply would run', async () => {
    const ctx = ctxWith(() => ({}));
    const result = editConfig.parse(
      await editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, ctx),
    );

    expect(result.validator).toBe('nginx -t');
    expect(result.reload).toBe('nginx -s reload');
    expect(result.assessment).toContain('nothing was written');
  });

  it('says restart-then-verify for a file type with no config checker', async () => {
    const ctx = ctxWith(() => ({}), 'maxmemory 100mb\n');
    const diff = ['@@ -1 +1 @@', '-maxmemory 100mb', '+maxmemory 200mb', ''].join('\n');
    const result = editConfig.parse(
      await editConfig.apply(
        { host: 'lab-cache', path: '/etc/redis/redis.conf', diff, mode: 'plan' },
        ctx,
      ),
    );

    expect(result.validator).toBeUndefined();
    expect(result.assessment).toContain('no config checker');
    expect(result.reload).toBe('systemctl restart redis-server');
  });

  it('refuses a diff that does not match the file', async () => {
    const ctx = ctxWith(() => ({}), CURRENT.replace('3999', '4000'));

    await expect(
      editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, ctx),
    ).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });
});

describe('edit_config apply', () => {
  it('writes, validates, then reloads — in that order', async () => {
    const ctx = ctxWith(() => ({}));
    const result = await planThenApply(ctx);

    expect(result.written).toBe(true);
    expect(result.validated).toBe(true);
    expect(result.reloaded).toBe(true);
    expect(result.assessment).toBe('written, validated and nginx reloaded');

    const programs = ctx.calls.map((call) => call.argv.join(' '));
    expect(programs).toContain(`tee -- ${PATH}`);
    expect(programs.indexOf('nginx -t')).toBeGreaterThan(programs.indexOf(`tee -- ${PATH}`));
    expect(programs.indexOf('nginx -s reload')).toBeGreaterThan(programs.indexOf('nginx -t'));
  });

  it('writes the whole file over stdin, never a patch command', async () => {
    const ctx = ctxWith(() => ({}));
    await planThenApply(ctx);
    const write = ctx.calls.find((call) => call.argv[0] === 'tee');

    // Computed and hashed locally, so what lands is what was reviewed.
    expect(write?.stdin).toContain('3000');
    expect(write?.stdin).not.toContain('3999');
    expect(ctx.calls.some((call) => call.argv[0] === 'patch')).toBe(false);
  });

  it('does NOT reload when the validator fails', async () => {
    // The step that keeps a broken config from becoming an outage: the running
    // process is still holding the old file when nginx -t says no.
    const ctx = ctxWith((command) =>
      command.argv.join(' ') === 'nginx -t'
        ? { exitCode: 1, stderr: 'nginx: [emerg] unknown directive "prox_pass" in /etc/nginx:4' }
        : {},
    );

    const result = await planThenApply(ctx);

    expect(result.validated).toBe(false);
    expect(result.reloaded).toBe(false);
    expect(ctx.calls.some((call) => call.argv.join(' ') === 'nginx -s reload')).toBe(false);
    expect(result.error).toContain('unknown directive');
    expect(result.assessment).toContain('NOT reloaded');
  });

  it('refuses when the file changed between planning and applying', async () => {
    // The guarantee the plan hash exists for, and the one the approval hash
    // does not give: this binds the state of the world, not the arguments.
    const planning = ctxWith(() => ({}));
    const planned = editConfig.parse(
      await editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, planning),
    );

    // Changed somewhere the hunk does not look, so the diff still applies
    // cleanly and only the hash of the whole file gives the edit away.
    const moved = ctxWith(() => ({}), `${CURRENT}# added by someone else\n`);

    await expect(
      editConfig.apply(
        { host: 'lab-api', path: PATH, diff: FIX, mode: 'apply', planHash: planned.planHash },
        moved,
      ),
    ).rejects.toThrowError(/has changed since you planned/);
    expect(moved.calls.some((call) => call.argv[0] === 'tee')).toBe(false);
  });

  it('refuses a planHash from a different file', async () => {
    const ctx = ctxWith(() => ({}));

    await expect(
      editConfig.apply(
        { host: 'lab-api', path: PATH, diff: FIX, mode: 'apply', planHash: 'a'.repeat(64) },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });

  it('reports a write that failed without pretending to have validated', async () => {
    const ctx = ctxWith((command) =>
      command.argv[0] === 'tee' ? { exitCode: 1, stderr: 'tee: Permission denied' } : {},
    );
    const result = await planThenApply(ctx);

    expect(result.written).toBe(false);
    expect(result.reloaded).toBe(false);
    expect(result.assessment).toBe('the file could not be written; nothing changed');
  });

  it('fails cleanly when the file cannot be read at all', async () => {
    const ctx = ctxWith((command) =>
      command.argv[0] === 'cat' ? { exitCode: 1, stderr: 'cat: No such file' } : {},
    );

    await expect(
      editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, ctx),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });
});

describe('edit_config rollback', () => {
  it('reloads the service, because restoring bytes is not enough', () => {
    // The pipeline puts the file back and checks its hash. Until the service
    // re-reads it, the process is still running the broken config.
    expect(
      editConfig.rollback?.({
        id: 'snap_0a1b2c3d',
        host: 'lab-api',
        createdAt: '',
        paths: [PATH],
        hashes: {},
      }),
    ).toEqual([{ argv: ['nginx', '-s', 'reload'], sudo: true, timeoutMs: 30_000 }]);
  });

  it('has nothing to do for a file with no known service', () => {
    expect(
      editConfig.rollback?.({
        id: 'snap_0a1b2c3d',
        host: 'h',
        createdAt: '',
        paths: ['/etc/hosts'],
        hashes: {},
      }),
    ).toEqual([]);
  });
});

describe('systemd unit files cannot be edited', () => {
  const UNIT = '/etc/systemd/system/dwara-app.service';
  const DIFF = [
    '@@ -1,3 +1,3 @@',
    ' [Service]',
    '-ExecStart=/usr/bin/true',
    '+ExecStart=/usr/bin/false',
    ' Restart=always',
    '',
  ].join('\n');

  const paths = [
    UNIT,
    '/etc/systemd/system/dwara-app.service.d/override.conf',
    '/etc/systemd/journald.conf',
    '/etc/systemd/system.conf',
    '/etc/systemd/user/thing.service',
  ];

  for (const path of paths) {
    it(`refuses ${path}`, async () => {
      // A unit file IS an arbitrary command run as root, and starting a unit is an
      // ordinary permitted action -- so allowing an edit here would be equivalent
      // to granting root, with "a person read the diff carefully" as the only
      // control. CLAUDE.md is explicit that guarantees live in code.
      const ctx = ctxWith(() => ({}));

      await expect(
        editConfig.apply({ host: 'lab-api', path, diff: DIFF, mode: 'plan' }, ctx),
      ).rejects.toThrow(/will not edit/u);

      // Nothing reached the host, not even the read.
      expect(ctx.calls).toHaveLength(0);
    });
  }

  it('explains why, rather than just refusing', async () => {
    const ctx = ctxWith(() => ({}));
    const error = await editConfig
      .apply({ host: 'lab-api', path: UNIT, diff: DIFF, mode: 'plan' }, ctx)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DwaraError);
    const hint = (error as DwaraError).hint ?? '';
    expect(hint).toContain('arbitrary command run as root');
    // The /etc/ssh reason must not be given for a systemd path.
    expect(hint).not.toContain('sshd -t');
  });

  it('still refuses /etc/ssh, with its own reason', async () => {
    const ctx = ctxWith(() => ({}));
    const error = await editConfig
      .apply({ host: 'lab-api', path: '/etc/ssh/sshd_config', diff: DIFF, mode: 'plan' }, ctx)
      .catch((cause: unknown) => cause);

    expect((error as DwaraError).hint ?? '').toContain('sshd -t');
  });

  it('snapshots nothing for a path it will not edit', () => {
    expect(() =>
      editConfig.snapshot?.({ host: 'h', path: UNIT, diff: DIFF, mode: 'apply' }),
    ).toThrow(/will not edit/u);
  });

  it('leaves reading a unit file alone — a diagnosis needs it', () => {
    // The refusal is about writing. read_config passes through a different guard,
    // and /etc/systemd/** is still on its allow-list, so an agent can look at a
    // unit and tell a human exactly which line to change.
    expect(DEFAULT_CONFIG_PATHS).toContain('/etc/systemd/**');
  });
});

describe('planning is judged as a read', () => {
  it('reports plan mode as read risk and apply as config', () => {
    // A plan writes nothing, so requiring an approval for it meant approving a
    // dry run before you could see what you were approving.
    expect(editConfig.effectiveRisk?.({ host: 'h', path: PATH, diff: FIX, mode: 'plan' })).toBe(
      'read',
    );
    expect(editConfig.effectiveRisk?.({ host: 'h', path: PATH, diff: FIX, mode: 'apply' })).toBe(
      'config',
    );
  });

  it('still declares config as its class, so the registry keeps demanding the machinery', () => {
    expect(editConfig.risk).toBe('config');
  });

  it('cannot be used to get a write: plan mode never reaches the tee', async () => {
    const ctx = ctxWith(() => ({}));
    editConfig.parse(
      await editConfig.apply({ host: 'lab-api', path: PATH, diff: FIX, mode: 'plan' }, ctx),
    );

    const verbs = ctx.calls.map((c) => c.argv[0]);
    expect(verbs).toContain('cat');
    expect(verbs).not.toContain('tee');
    expect(verbs).not.toContain('nginx');
    expect(verbs).not.toContain('systemctl');
  });
});
