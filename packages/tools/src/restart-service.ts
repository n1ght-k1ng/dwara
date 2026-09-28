import { z } from 'zod';
import {
  DwaraError,
  Risk,
  policyHttpChecks,
  runChecks,
  serviceActiveAndStable,
  type RemoteCommand,
  type StagedToolDef,
  type UnitState,
} from '@dwara/core';
import { at, hostField, keyValues, toNumber } from './common.js';

/**
 * Units `restart_service` will not touch, whatever a policy says.
 *
 * The same standing as the path deny-list: a floor in code, not a default a
 * file can lift.
 *
 * - **ssh / sshd** is the only way Dwara reaches the host. Restarting it is a
 *   legitimate thing for a person at a console to do and a uniquely bad thing
 *   for an agent to do, because the one failure mode it cannot recover from is
 *   losing the connection it would need to recover.
 * - **dbus** and **systemd-logind** wedge systemd itself when they go down
 *   under a container init, and nothing else works afterwards.
 * - **systemd-journald** holds the logs. Restarting it during a diagnosis
 *   destroys the evidence the diagnosis is made of.
 */
export const PROTECTED_UNITS: readonly string[] = [
  'ssh',
  'sshd',
  'dbus',
  'dbus-broker',
  'systemd-journald',
  'systemd-logind',
] as const;

const input = z
  .object({
    host: hostField,
    unit: z
      .string()
      .min(1)
      .describe('Unit name, with or without the .service suffix, e.g. "nginx" or "nginx.service".'),
  })
  .strict();

type Input = z.output<typeof input>;

/** One reading of a unit, before or after. */
export interface UnitReading {
  readonly activeState: string;
  readonly subState: string;
  readonly restarts: number | undefined;
  readonly mainPid: number | undefined;
}

export interface RestartResult {
  readonly unit: string;
  readonly before: UnitReading;
  readonly after: UnitReading;
  /** False when systemd refused the restart outright. */
  readonly restarted: boolean;
  /** Present when it refused, carrying systemd's own words. */
  readonly error?: string;
  readonly assessment: string;
}

const SHOW_PROPERTIES = 'Id,ActiveState,SubState,NRestarts,MainPID,Result';

/** Read commands are quick; a restart may legitimately take most of a minute. */
const READ_MS = 20_000;
export const RESTART_TIMEOUT_MS = 45_000;

export interface RestartServiceOptions {
  /** Overridden only by the timeout test, which cannot afford to wait 45s. */
  readonly restartTimeoutMs?: number;
  /** How long the unit must stay up before the restart counts as having worked. */
  readonly stableForMs?: number;
  /**
   * Budget for the whole verification.
   *
   * Matters most when verification *fails*: the runner keeps retrying to the
   * deadline, so a crash loop takes the full budget to prove. The default is
   * right for a real host, where a service may take half a minute to settle,
   * and far too slow for a test that means to induce a failure.
   */
  readonly verifyTimeoutMs?: number;
}

/**
 * Restarts one systemd unit, then proves it came back.
 *
 * Built as a factory so the integration suite can shorten the timeouts. The
 * registry gets the default instance.
 */
export function createRestartService(
  options: RestartServiceOptions = {},
): StagedToolDef<Input, RestartResult> {
  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS;

  return {
    name: 'restart_service',
    risk: Risk.Reversible,
    description: [
      'Restarts a systemd unit and then checks that it actually came back: active,',
      'running, and still running ten seconds later. Any HTTP health check the policy',
      'declares for the host is checked too.',
      '',
      'If verification fails the restart is undone automatically — the unit is returned',
      'to the state it was in before — and the result tells you which check failed and',
      'what the host said. A restart that reports ok has been verified; you do not need',
      'to call service_status afterwards to confirm it.',
      '',
      'Use this when a service is in a bad state that a restart plausibly clears: a',
      'stuck worker, a process holding a stale connection pool, a unit left inactive.',
      'It is not a fix for a broken configuration file — restarting will fail the same',
      'way, and you will get the error back. Read the logs first with tail_logs, and',
      'fix configuration with edit_config.',
      '',
      'A unit in a crash loop cannot be rescued by restarting it. Undoing a restart',
      'restores what the unit was asked to do, not its health: if it was running before',
      'and is broken now, rollback tries to start it and the underlying fault remains.',
      '',
      'ssh, dbus and journald cannot be restarted through this tool at all.',
    ].join('\n'),
    input,

    // Units only: a restart changes no files, so there is nothing to copy. The
    // recorded ActiveState is what the rollback puts back.
    snapshot: (params) => ({ paths: [], units: [unitName(params.unit)] }),

    async apply(params, ctx) {
      const unit = guardUnit(params.unit);

      // Staged rather than built up front, because the "before" reading has to
      // be taken while it is still true. This is the case Phase 2 could not
      // express at all.
      const before = await ctx.run(show(unit));
      const restart = await ctx.run({
        argv: ['systemctl', 'restart', unit],
        sudo: true,
        timeoutMs: restartTimeoutMs,
      });
      const after = await ctx.run(show(unit));

      return [before, restart, after];
    },

    parse: (raws) => {
      const before = reading(at(raws, 0).stdout);
      const restart = at(raws, 1);
      const after = reading(at(raws, 2).stdout);
      const unit = keyValues(at(raws, 2).stdout)['Id'] ?? keyValues(at(raws, 0).stdout)['Id'] ?? '';
      const failed = restart.exitCode !== 0;

      return {
        unit,
        before,
        after,
        restarted: !failed,
        ...(failed
          ? {
              error: restart.stderr.trim().split('\n')[0] || `systemctl exited ${restart.exitCode}`,
            }
          : {}),
        assessment: assess(before, after, failed),
      };
    },

    verify: (params, ctx) =>
      runChecks(
        [
          serviceActiveAndStable(unitName(params.unit), options.stableForMs),
          // A restarted service that answers its own health endpoint is a much
          // stronger claim than one that merely has a running process.
          ...policyHttpChecks(ctx),
        ],
        ctx,
        options.verifyTimeoutMs === undefined ? {} : { timeoutMs: options.verifyTimeoutMs },
      ),

    // Restores what the unit was asked to do, which is all a restart can undo.
    // If it was active before and is broken now, starting it will not fix the
    // underlying fault -- and the verify result already said so.
    //
    // `reset-failed` comes first and matters more than it looks. `systemctl
    // stop` on a unit that crashed leaves ActiveState=failed, not inactive, so
    // a rollback to "it was not running" would otherwise leave the host in a
    // state the snapshot never recorded -- and leave the unit sitting in
    // host_overview's failed list indefinitely.
    rollback: (snapshot) =>
      Object.entries(snapshot.units ?? {}).flatMap(([unit, state]) => [
        { argv: ['systemctl', 'reset-failed', unit], sudo: true, timeoutMs: READ_MS },
        {
          argv: ['systemctl', wasRunning(state) ? 'start' : 'stop', unit],
          sudo: true,
          timeoutMs: restartTimeoutMs,
        },
      ]),
  };
}

/** The registered instance, with production timeouts. */
export const restartService = createRestartService();

function show(unit: string): RemoteCommand {
  return {
    argv: ['systemctl', 'show', unit, '--no-pager', `--property=${SHOW_PROPERTIES}`],
    sudo: true,
    timeoutMs: READ_MS,
  };
}

function unitName(unit: string): string {
  return /\.(service|socket|timer|target|mount|path|slice)$/.test(unit) ? unit : `${unit}.service`;
}

/**
 * @throws DwaraError `UNSAFE_ARGUMENT` for a unit on the protected list.
 */
function guardUnit(requested: string): string {
  const unit = unitName(requested);
  const bare = unit.replace(/\.[a-z]+$/, '');

  if (PROTECTED_UNITS.includes(bare)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `Dwara will not restart ${unit}`, {
      details: { unit, protected: [...PROTECTED_UNITS] },
      hint:
        bare === 'ssh' || bare === 'sshd'
          ? 'this is the connection Dwara reaches the host through; restart it from a console'
          : 'restarting this unit takes systemd or the logs with it; do it from a console',
    });
  }

  return unit;
}

function wasRunning(state: UnitState): boolean {
  return state.activeState === 'active' || state.activeState === 'activating';
}

function reading(stdout: string): UnitReading {
  const fields = keyValues(stdout);
  const pid = toNumber(fields['MainPID']);

  return {
    activeState: fields['ActiveState'] ?? 'unknown',
    subState: fields['SubState'] ?? 'unknown',
    restarts: toNumber(fields['NRestarts']),
    // MainPID is 0 for a unit that is not running; that is absence, not a pid.
    mainPid: pid === 0 ? undefined : pid,
  };
}

function assess(before: UnitReading, after: UnitReading, failed: boolean): string {
  if (failed) return 'systemd refused the restart; the unit is as it was';
  if (after.activeState === 'active' && after.subState === 'running') {
    return before.activeState === 'active'
      ? 'restarted and running'
      : `was ${before.activeState}, now running`;
  }
  if (after.activeState === 'failed') return 'came back failed; read its logs for the reason';
  if (after.activeState === 'activating') return 'still starting up when last checked';
  return `${after.activeState} (${after.subState}) after the restart`;
}
