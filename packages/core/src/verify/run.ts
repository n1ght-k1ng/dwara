import type { Ctx, VerifyResult } from '../types.js';
import type { Check, CheckOutcome } from './checks.js';

/**
 * Running postconditions until they hold, or until time runs out.
 *
 * Two behaviours matter and they pull in opposite directions:
 *
 * - **Retry**, because a service that has just been restarted is allowed a
 *   moment. Failing the instant after `systemctl restart` returns would roll
 *   back every healthy change.
 * - **Persist**, because a service that is up right now may be up only because
 *   systemd restarted it a second ago. A check with `stableForMs` has to hold
 *   continuously for that long; one failure resets the clock.
 *
 * The result is the same shape whether it passed or failed, and it carries
 * every check's own sentence, because "verification failed" without saying
 * which postcondition and why is not worth reporting.
 */

export interface VerifyOptions {
  /** Wall-clock budget for the whole set. */
  readonly timeoutMs?: number;
  /** First gap between polls; doubles up to `maxIntervalMs`. */
  readonly initialIntervalMs?: number;
  readonly maxIntervalMs?: number;
  /** Injected by tests so they do not spend the wall clock. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

const DEFAULT_INITIAL_INTERVAL_MS = 500;
const DEFAULT_MAX_INTERVAL_MS = 4_000;

interface Tracked {
  readonly check: Check;
  outcome: CheckOutcome;
  /** When this check first became ok and stayed ok, or undefined while failing. */
  okSince: number | undefined;
  settled: boolean;
}

/**
 * Runs every check, retrying the ones that fail, until all are satisfied or the
 * deadline passes.
 *
 * Checks are polled in order rather than concurrently: they all speak to the
 * same host over one multiplexed connection, and a stampede of parallel `ssh`
 * invocations against a box that has just restarted a service is a way to make
 * verification itself the thing that fails.
 */
export async function runChecks(
  checks: readonly Check[],
  ctx: Ctx,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  if (checks.length === 0) {
    return { ok: true, checks: [], durationMs: 0 };
  }

  const tracked: Tracked[] = checks.map((check) => ({
    check,
    outcome: { ok: false, detail: 'not run yet' },
    okSince: undefined,
    settled: false,
  }));

  let interval = options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;

  for (;;) {
    for (const item of tracked) {
      if (item.settled) continue;

      item.outcome = await item.check.run(ctx);

      if (!item.outcome.ok) {
        // One failure resets the stability clock. A unit that flickered was
        // never stable, however good the polls on either side looked.
        item.okSince = undefined;
        continue;
      }

      item.okSince ??= now();
      const stableFor = item.check.stableForMs ?? 0;
      if (now() - item.okSince >= stableFor) item.settled = true;
    }

    if (tracked.every((item) => item.settled)) break;

    // Out of time. Report what the last poll saw, including any check that was
    // passing but had not been passing for long enough to be believed.
    if (now() >= deadline) {
      for (const item of tracked) {
        if (item.settled || !item.outcome.ok) continue;
        item.outcome = {
          ok: false,
          detail: `${item.outcome.detail}, but not for the ${Math.round((item.check.stableForMs ?? 0) / 1000)}s needed to call it stable`,
        };
      }
      break;
    }

    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    interval = Math.min(interval * 2, maxIntervalMs);
  }

  return {
    ok: tracked.every((item) => item.settled),
    checks: tracked.map((item) => ({
      name: item.check.name,
      ok: item.settled,
      detail: item.outcome.detail,
    })),
    durationMs: now() - startedAt,
  };
}

/** A one-line summary of a verify result, for an audit entry. */
export function summariseVerify(result: VerifyResult): string {
  const failed = result.checks.filter((check) => !check.ok);
  if (failed.length === 0) return `${result.checks.length} check(s) passed`;

  return `${failed.length} of ${result.checks.length} check(s) failed: ${failed
    .map((check) => check.detail)
    .join('; ')}`;
}
