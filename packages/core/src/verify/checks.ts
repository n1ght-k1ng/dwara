import type { Ctx, HttpCheck, RemoteCommand } from '../types.js';

/**
 * Postconditions, as small composable pieces.
 *
 * A check answers one question about the host and says why in a sentence a
 * human can act on. It never decides what to do about the answer — the runner
 * retries, and the pipeline rolls back.
 *
 * Nothing here trusts an exit code alone. A `systemctl restart` that returns 0
 * proves systemd accepted the request, not that anything is running a second
 * later; that gap is the whole reason a verifier exists.
 */

/** What one check found. */
export interface CheckOutcome {
  readonly ok: boolean;
  /** Written for whoever reads the result at 3am, not for a parser. */
  readonly detail: string;
}

export interface Check {
  readonly name: string;
  /**
   * How long the check must stay continuously true before it counts.
   *
   * Zero means a single pass is enough. Anything above it makes the runner keep
   * polling, which is how a crash loop is caught: a unit that dies and is
   * restarted mid-window fails even though every individual poll said "active".
   */
  readonly stableForMs?: number;
  run(ctx: Ctx): Promise<CheckOutcome>;
}

const CHECK_TIMEOUT_MS = 15_000;

/** Ten seconds, per DESIGN section 11. Long enough for a crash loop to show. */
export const DEFAULT_STABLE_MS = 10_000;

const UNIT_PROPERTIES = 'Id,ActiveState,SubState,NRestarts,Result';

/**
 * A systemd unit that is active, running, and has not restarted under us.
 *
 * `NRestarts` counts restarts systemd performed itself under a `Restart=`
 * policy; an explicit `systemctl restart` does not move it. So a climbing count
 * during the stability window means the unit is dying and being resurrected,
 * which is precisely the state that reports `active` at any instant you ask.
 */
export function serviceActiveAndStable(unit: string, stableForMs = DEFAULT_STABLE_MS): Check {
  const name = `service ${unitName(unit)} active and stable`;
  let baselineRestarts: number | undefined;

  return {
    name,
    stableForMs,
    async run(ctx) {
      const result = await ctx.run({
        argv: ['systemctl', 'show', unitName(unit), '--no-pager', `--property=${UNIT_PROPERTIES}`],
        sudo: true,
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      const fields = keyValues(result.stdout);
      const active = fields['ActiveState'] ?? 'unknown';
      const sub = fields['SubState'] ?? 'unknown';
      const restarts = Number(fields['NRestarts']);
      const failure = fields['Result'] ?? '';

      if (active !== 'active') {
        const because = failure !== '' && failure !== 'success' ? ` (result: ${failure})` : '';
        return { ok: false, detail: `${unitName(unit)} is ${active} (${sub})${because}` };
      }

      if (Number.isFinite(restarts)) {
        baselineRestarts ??= restarts;
        if (restarts > baselineRestarts) {
          return {
            ok: false,
            detail: `${unitName(unit)} restarted ${restarts - baselineRestarts} time(s) while being watched; it is in a restart loop, not running`,
          };
        }
      }

      return { ok: true, detail: `${unitName(unit)} is active (${sub})` };
    },
  };
}

/** A container that is running, and passing its own health check if it has one. */
export function containerRunningAndHealthy(
  container: string,
  stableForMs = DEFAULT_STABLE_MS,
): Check {
  return {
    name: `container ${container} running and healthy`,
    stableForMs,
    async run(ctx) {
      // No sudo: the lab's dwara user is in the docker group, and none of the
      // read tools use sudo for docker either.
      const result = await ctx.run({
        argv: ['docker', 'inspect', '--format', '{{json .State}}', '--', container],
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      if (result.exitCode !== 0) {
        return { ok: false, detail: `cannot inspect ${container}: ${firstLine(result.stderr)}` };
      }

      const state = parseState(result.stdout);
      if (state === undefined) {
        return { ok: false, detail: `could not read the state of ${container}` };
      }

      if (state.Running !== true) {
        const code = typeof state.ExitCode === 'number' ? `, last exit ${state.ExitCode}` : '';
        return {
          ok: false,
          detail: `${container} is ${String(state.Status ?? 'not running')}${code}`,
        };
      }

      // A container with no HEALTHCHECK reports no Health block at all. That is
      // absence of a signal, not a failing one, so running is the whole answer.
      const health = state.Health?.Status;
      if (health !== undefined && health !== 'healthy') {
        return {
          ok: false,
          detail: `${container} is running but its health check says "${health}"`,
        };
      }

      return {
        ok: true,
        detail: `${container} is running${health === undefined ? '' : ' and healthy'}`,
      };
    },
  };
}

/**
 * An HTTP endpoint on the host answering with the expected status.
 *
 * Run from the host, so it tests what the service actually serves and needs no
 * route back to the developer machine. TLS verification is off: these are
 * loopback health endpoints and a self-signed certificate is the norm for them.
 * This check proves the service responds, never that its certificate is sound —
 * `cert_expiry` is the tool for that, and it is a read.
 */
export function httpResponds(check: HttpCheck): Check {
  return {
    name: `GET ${check.url} responds ${check.expectStatus}`,
    async run(ctx) {
      const result = await ctx.run({
        argv: [
          'curl',
          '--silent',
          '--show-error',
          '--insecure',
          '--max-time',
          '10',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--',
          check.url,
        ],
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      const status = Number(result.stdout.trim());
      if (!Number.isFinite(status) || status === 0) {
        return { ok: false, detail: `${check.url} did not answer: ${firstLine(result.stderr)}` };
      }

      return status === check.expectStatus
        ? { ok: true, detail: `${check.url} answered ${status}` }
        : { ok: false, detail: `${check.url} answered ${status}, expected ${check.expectStatus}` };
    },
  };
}

/**
 * A service's own configuration validator, such as `nginx -t`.
 *
 * Runs once and is not retried on failure: a config file that is invalid now
 * will be invalid in three seconds, and retrying only delays the rollback.
 */
export function validatorCommand(name: string, command: RemoteCommand): Check {
  return {
    name,
    async run(ctx) {
      const result = await ctx.run(command);
      return result.exitCode === 0
        ? { ok: true, detail: `${name} passed` }
        : {
            ok: false,
            detail: `${name} failed: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
          };
    },
  };
}

/** Every HTTP check the host's policy declares. */
export function policyHttpChecks(ctx: Ctx): readonly Check[] {
  return ctx.httpChecks.map(httpResponds);
}

function unitName(unit: string): string {
  return /\.(service|socket|timer|target|mount|path|slice)$/.test(unit) ? unit : `${unit}.service`;
}

function keyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').slice(0, 200);
}

/** The subset of Docker's `.State` this cares about. */
interface ContainerState {
  readonly Running?: boolean;
  readonly Status?: string;
  readonly ExitCode?: number;
  readonly Health?: { readonly Status?: string };
}

function parseState(stdout: string): ContainerState | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed !== null && typeof parsed === 'object' ? (parsed as ContainerState) : undefined;
  } catch {
    return undefined;
  }
}
