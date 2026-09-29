import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DwaraError,
  Risk,
  canonicalise,
  policyHttpChecks,
  runChecks,
  serviceActiveAndStable,
  validatorCommand,
  type RawResult,
  type RemoteCommand,
  type StagedToolDef,
} from '@dwara/core';
import { applyDiff, summariseDiff } from './diff.js';
import { DEFAULT_CONFIG_PATHS, guardPath } from './paths.js';
import { at, hostField } from './common.js';

/**
 * Editing a configuration file, transactionally.
 *
 * The order is the one an experienced hand uses and the one people skip:
 * snapshot, write, **validate**, reload, verify. A broken config is caught by
 * the service's own checker while the running process is still holding the old
 * one, so the reload never happens and the outage never starts.
 *
 * **Two steps, bound by a plan hash.** `plan` reads the file, applies the diff
 * in this process and returns the resulting content, the validator that will
 * run and the rollback, without touching the host. `apply` requires the hash
 * that plan returned, and that hash covers the file's contents *before* the
 * edit. So a file that changed between planning and applying — by another
 * admin, by a config-management run, by the service itself — fails rather than
 * being overwritten with a result computed from something that is no longer
 * there.
 *
 * That is a different guarantee from the approval hash, which binds the
 * arguments a human said yes to. This one binds the state of the world.
 */

const input = z
  .object({
    host: hostField,
    path: z
      .string()
      .min(1)
      .describe('Absolute path of the configuration file. Must be on the allowed list.'),
    diff: z
      .string()
      .min(1)
      .describe('A unified diff against the current file. Applied exactly; no fuzz.'),
    mode: z
      .enum(['plan', 'apply'])
      .default('plan')
      .describe('plan reads and shows the result; apply writes it. Always plan first.'),
    planHash: z
      .string()
      .length(64)
      .optional()
      .describe('Required for apply. The planHash the plan step returned.'),
  })
  .strict()
  .refine((value) => value.mode === 'plan' || value.planHash !== undefined, {
    message: 'apply needs the planHash that the plan step returned',
  });

type Input = z.output<typeof input>;

export interface EditConfigResult {
  readonly path: string;
  readonly mode: 'plan' | 'apply';
  /** SHA-256 of the file as it was before the edit. */
  readonly beforeHash: string;
  /** SHA-256 of what the edit produces. */
  readonly afterHash: string;
  /** Pass this back to `apply`. Covers the path, the diff and `beforeHash`. */
  readonly planHash: string;
  readonly changes: { readonly added: number; readonly removed: number; readonly hunks: number };
  /** The command that will check the result, if this file type has one. */
  readonly validator?: string;
  /** How the change is made to take effect, if at all. */
  readonly reload?: string;
  /** Present on plan: what the file will contain. Redacted like any output. */
  readonly preview?: string;
  /** Present on apply. */
  readonly written?: boolean;
  readonly validated?: boolean;
  readonly reloaded?: boolean;
  readonly error?: string;
  readonly assessment: string;
}

const READ_MS = 20_000;
const WRITE_MS = 30_000;

/**
 * Paths `edit_config` refuses even though they are otherwise readable.
 *
 * `sshd_config` is the one that matters. `sshd -t` proves the file parses; it
 * does not prove you can still log in, and a syntactically perfect
 * `AllowUsers` line is exactly how a person locks themselves out of a machine.
 * Dwara reaches every host over SSH, so that failure takes the recovery path
 * with it — the same reasoning that keeps `ssh` out of `restart_service`.
 */
export const UNEDITABLE_PATHS: readonly string[] = ['/etc/ssh/**'] as const;

interface FileKind {
  readonly match: RegExp;
  readonly unit?: string;
  readonly validator?: RemoteCommand;
  readonly reload?: RemoteCommand;
}

/**
 * What to do per file type.
 *
 * A file with no validator is not refused — it is written and then judged by
 * whether its service stays healthy, which is what DESIGN calls
 * restart-then-verify. A file with neither validator nor unit is written and
 * nothing is reloaded, and the result says so rather than implying the change
 * took effect.
 */
const KINDS: readonly FileKind[] = [
  {
    match: /^\/etc\/nginx\//,
    unit: 'nginx',
    validator: { argv: ['nginx', '-t'], sudo: true, timeoutMs: READ_MS },
    reload: { argv: ['nginx', '-s', 'reload'], sudo: true, timeoutMs: WRITE_MS },
  },
  {
    match: /^\/etc\/redis\//,
    unit: 'redis-server',
    // Redis ships no config checker, so the postcondition is the service
    // itself: restart, then require it to stay up.
    reload: { argv: ['systemctl', 'restart', 'redis-server'], sudo: true, timeoutMs: WRITE_MS },
  },
];

export interface EditConfigOptions {
  readonly verifyTimeoutMs?: number;
  readonly stableForMs?: number;
}

export function createEditConfig(
  options: EditConfigOptions = {},
): StagedToolDef<Input, EditConfigResult> {
  return {
    name: 'edit_config',
    risk: Risk.Config,
    description: [
      'Edits a configuration file by applying a unified diff, with the file backed up',
      'first and the change undone automatically if it does not work.',
      '',
      'Always call it twice. First with mode "plan": nothing is written, and you get',
      'back the resulting file, the validator that will run, and a planHash. Read the',
      'preview. Then call it with mode "apply" and that same planHash.',
      '',
      'The planHash covers the file as it was when you planned. If anything changed it',
      'in between, apply fails rather than overwriting work you did not see. Re-plan',
      'and look again.',
      '',
      'The diff is applied exactly — same line, same context, no fuzz. If it does not',
      'match you get told which line disagreed. Read the file with read_config first',
      'and build the diff from what is actually there, not from what you expect.',
      '',
      'Order of operations: snapshot, write, validate, reload, verify. A config that',
      'fails its validator is never reloaded, so a broken file cannot take the service',
      'down. If verification fails afterwards the old file is restored and the service',
      'reloaded again.',
      '',
      'nginx is checked with nginx -t. Redis has no config checker, so it is restarted',
      'and required to stay up. Files under /etc/ssh cannot be edited at all: sshd -t',
      'proves a file parses, not that you can still log in, and Dwara reaches every',
      'host over SSH.',
    ].join('\n'),
    input,

    snapshot: (params) => ({
      paths: [guardEditPath(params.path)],
      ...(kindFor(params.path)?.unit === undefined ? {} : { units: [kindFor(params.path)!.unit!] }),
    }),

    async apply(params, ctx) {
      const path = guardEditPath(params.path);
      const kind = kindFor(path);

      const current = await ctx.run(read(path));
      if (current.exitCode !== 0) {
        throw new DwaraError('COMMAND_FAILED', `could not read ${path}: ${firstLine(current)}`, {
          details: { path, host: ctx.host },
        });
      }

      const before = current.stdout;
      const beforeHash = sha256(before);
      const after = applyDiff(before, params.diff);
      const hash = planHashOf(path, params.diff, beforeHash);

      if (params.mode === 'plan') {
        // Nothing is written. The second result is a placeholder so `parse`
        // can index positionally either way.
        return [current, noop(hash), noop(after), noop(params.diff)];
      }

      if (params.planHash !== hash) {
        throw new DwaraError(
          'PLAN_MISMATCH',
          `${path} has changed since you planned this edit; plan it again and read the result`,
          {
            details: { path, expected: params.planHash ?? '', actual: hash },
            hint: 'another process may have edited the file, or the diff was planned against a different host',
          },
        );
      }

      // Written whole rather than patched in place: the bytes were computed
      // and hashed here, so what lands is exactly what was reviewed.
      const written = await ctx.run({
        argv: ['tee', '--', path],
        sudo: true,
        stdin: after,
        timeoutMs: WRITE_MS,
      });

      const validated = kind?.validator === undefined ? noop('') : await ctx.run(kind.validator);

      // The step that makes this safe. A config that fails its own checker is
      // never reloaded, so the running service keeps the file it already has.
      const reloadable =
        written.exitCode === 0 && (kind?.validator === undefined || validated.exitCode === 0);
      const reloaded =
        reloadable && kind?.reload !== undefined ? await ctx.run(kind.reload) : noop('');

      return [current, noop(hash), noop(after), noop(params.diff), written, validated, reloaded];
    },

    parse: (raws) => {
      const before = at(raws, 0).stdout;
      const planHash = at(raws, 1).stdout;
      const after = at(raws, 2).stdout;
      const path = at(raws, 0).argv[2] ?? '';
      const kind = kindFor(path);
      const diff = at(raws, 3).stdout;
      const planning = raws.length === 4;

      const base = {
        path,
        beforeHash: sha256(before),
        afterHash: sha256(after),
        planHash,
        changes: { added: 0, removed: 0, hunks: 0 },
        ...(kind?.validator === undefined ? {} : { validator: kind.validator.argv.join(' ') }),
        ...(kind?.reload === undefined ? {} : { reload: kind.reload.argv.join(' ') }),
      };

      if (planning) {
        return {
          ...base,
          mode: 'plan' as const,
          preview: after,
          changes: countFrom(diff),
          assessment: planAssessment(kind, path),
        };
      }

      const written = at(raws, 4);
      const validated = at(raws, 5);
      const reloaded = at(raws, 6);
      const validatorRan = kind?.validator !== undefined;
      const validatorOk = !validatorRan || validated.exitCode === 0;
      const didReload = kind?.reload !== undefined && reloaded.argv.length > 0;

      return {
        ...base,
        mode: 'apply' as const,
        changes: countFrom(diff),
        written: written.exitCode === 0,
        validated: validatorOk,
        reloaded: didReload && reloaded.exitCode === 0,
        ...(written.exitCode !== 0
          ? { error: `could not write the file: ${firstLine(written)}` }
          : !validatorOk
            ? {
                error: `${kind?.validator?.argv.join(' ') ?? 'validator'}: ${firstLine(validated)}`,
              }
            : didReload && reloaded.exitCode !== 0
              ? { error: `reload failed: ${firstLine(reloaded)}` }
              : {}),
        assessment: applyAssessment(written, validatorRan, validatorOk, didReload, reloaded, kind),
      };
    },

    verify: (params, ctx) => {
      const path = guardEditPath(params.path);
      const kind = kindFor(path);

      if (params.mode === 'plan') {
        // Planning changes nothing, so there is nothing to verify. Saying so
        // beats inventing a check that would always pass.
        return Promise.resolve({ ok: true, checks: [], durationMs: 0 });
      }

      return runChecks(
        [
          ...(kind?.validator === undefined
            ? []
            : [validatorCommand(kind.validator.argv.join(' '), kind.validator)]),
          ...(kind?.unit === undefined
            ? []
            : [serviceActiveAndStable(kind.unit, options.stableForMs)]),
          ...policyHttpChecks(ctx),
        ],
        ctx,
        options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs },
      );
    },

    // The pipeline restores the file from the snapshot and checks its hash;
    // this makes the restored file take effect. Bytes on disk are not the
    // state that matters to anyone until the service has re-read them.
    rollback: (snapshot) => {
      const path = snapshot.paths[0];
      const kind = path === undefined ? undefined : kindFor(path);
      return kind?.reload === undefined ? [] : [kind.reload];
    },
  };
}

/** The registered instance. */
export const editConfig = createEditConfig();

function read(path: string): RemoteCommand {
  return { argv: ['cat', '--', path], sudo: true, timeoutMs: READ_MS };
}

/** A carrier for a value the parser needs, without a round trip to the host. */
function noop(stdout: string): RawResult {
  return { argv: [], exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 0 };
}

function kindFor(path: string): FileKind | undefined {
  return KINDS.find((kind) => kind.match.test(path));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Covers the path, the diff and the file's state before the edit. */
function planHashOf(path: string, diff: string, beforeHash: string): string {
  return createHash('sha256')
    .update(canonicalise({ path, diff, before: beforeHash }), 'utf8')
    .digest('hex');
}

/**
 * @throws DwaraError `UNSAFE_ARGUMENT` for a path that is not editable.
 */
function guardEditPath(requested: string): string {
  const guard = guardPath(requested, DEFAULT_CONFIG_PATHS);
  if (!guard.ok) {
    throw new DwaraError('UNSAFE_ARGUMENT', `cannot edit that path: ${guard.reason}`, {
      details: { path: requested },
    });
  }

  if (
    UNEDITABLE_PATHS.some((pattern) =>
      new RegExp(`^${pattern.replace('**', '.*')}$`).test(guard.path),
    )
  ) {
    throw new DwaraError('UNSAFE_ARGUMENT', `Dwara will not edit ${guard.path}`, {
      details: { path: guard.path, uneditable: [...UNEDITABLE_PATHS] },
      hint: 'sshd -t proves the file parses, not that you can still log in, and Dwara reaches this host over SSH',
    });
  }

  return guard.path;
}

/** What the diff says it does, which is more honest than diffing the results. */
function countFrom(diff: string): EditConfigResult['changes'] {
  try {
    return summariseDiff(diff);
  } catch {
    return { added: 0, removed: 0, hunks: 0 };
  }
}

function firstLine(result: RawResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return (text.split('\n')[0] ?? `exited ${result.exitCode}`).slice(0, 200);
}

function planAssessment(kind: FileKind | undefined, path: string): string {
  if (kind?.validator !== undefined) {
    return `nothing was written. Apply with this planHash to write it, check it with ${kind.validator.argv.join(' ')}, then reload`;
  }
  if (kind?.reload !== undefined) {
    return `nothing was written. ${path} has no config checker, so applying will write it, restart the service and require it to stay up`;
  }
  return 'nothing was written. This file has no validator and no known service, so applying will write it and reload nothing';
}

function applyAssessment(
  written: RawResult,
  validatorRan: boolean,
  validatorOk: boolean,
  didReload: boolean,
  reloaded: RawResult,
  kind: FileKind | undefined,
): string {
  if (written.exitCode !== 0) return 'the file could not be written; nothing changed';
  if (validatorRan && !validatorOk) {
    return 'the new config failed its validator, so the service was NOT reloaded and is still running the old one';
  }
  if (didReload && reloaded.exitCode !== 0) return 'written and valid, but the reload failed';
  if (didReload) return `written, validated and ${kind?.unit ?? 'the service'} reloaded`;
  return 'written; no service was reloaded, so the change is on disk but not yet in effect';
}
