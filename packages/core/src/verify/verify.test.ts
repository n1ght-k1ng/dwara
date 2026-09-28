import { describe, expect, it } from 'vitest';
import type { Ctx, RawResult, RemoteCommand } from '../types.js';
import {
  containerRunningAndHealthy,
  httpResponds,
  policyHttpChecks,
  serviceActiveAndStable,
  validatorCommand,
  type Check,
} from './checks.js';
import { runChecks, summariseVerify } from './run.js';

type FakeCtx = Ctx & { readonly calls: RemoteCommand[] };

function ctxWith(
  respond: (command: RemoteCommand, nth: number) => Partial<RawResult>,
  httpChecks: Ctx['httpChecks'] = [],
): FakeCtx {
  const calls: RemoteCommand[] = [];
  return {
    calls,
    host: 'lab-api',
    sessionId: 's_test',
    httpChecks,
    async run(command) {
      const nth = calls.length;
      calls.push(command);
      return {
        argv: command.argv,
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 1,
        ...respond(command, nth),
      };
    },
  };
}

/** systemctl show output, in the order a real host answers: not the asked order. */
function unit(fields: Record<string, string>): string {
  return Object.entries({ NRestarts: '0', Result: 'success', ...fields })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** A clock and a sleep that advance together, so tests cost no wall time. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('serviceActiveAndStable', () => {
  it('passes for a unit that is active and running', async () => {
    const ctx = ctxWith(() => ({
      stdout: unit({ Id: 'nginx.service', ActiveState: 'active', SubState: 'running' }),
    }));

    expect(await serviceActiveAndStable('nginx').run(ctx)).toEqual({
      ok: true,
      detail: 'nginx.service is active (running)',
    });
  });

  it('adds the .service suffix and asks systemd as root', async () => {
    const ctx = ctxWith(() => ({ stdout: unit({ Id: 'nginx.service', ActiveState: 'active' }) }));
    await serviceActiveAndStable('nginx').run(ctx);

    expect(ctx.calls[0]?.argv).toContain('nginx.service');
    expect(ctx.calls[0]?.sudo).toBe(true);
  });

  it('fails for a unit that is not active, and says what went wrong', async () => {
    const ctx = ctxWith(() => ({
      stdout: unit({
        Id: 'dwara-app.service',
        ActiveState: 'failed',
        SubState: 'failed',
        Result: 'exit-code',
      }),
    }));

    const outcome = await serviceActiveAndStable('dwara-app').run(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('dwara-app.service is failed (failed) (result: exit-code)');
  });

  it('catches a crash loop, which reports active at every single poll', async () => {
    // The case the whole verifier exists for. Each individual answer says
    // "active"; only the climbing restart count gives it away.
    const ctx = ctxWith((_command, nth) => ({
      stdout: unit({
        Id: 'dwara-app.service',
        ActiveState: 'active',
        SubState: 'running',
        NRestarts: String(nth),
      }),
    }));
    const check = serviceActiveAndStable('dwara-app');

    expect((await check.run(ctx)).ok).toBe(true);
    const second = await check.run(ctx);

    expect(second.ok).toBe(false);
    expect(second.detail).toMatch(
      /restarted 1 time\(s\) while being watched; it is in a restart loop/,
    );
  });
});

describe('containerRunningAndHealthy', () => {
  it('passes for a running container with a passing health check', async () => {
    const ctx = ctxWith(() => ({
      stdout: JSON.stringify({ Running: true, Status: 'running', Health: { Status: 'healthy' } }),
    }));

    expect(await containerRunningAndHealthy('lab-app').run(ctx)).toEqual({
      ok: true,
      detail: 'lab-app is running and healthy',
    });
  });

  it('treats a container with no HEALTHCHECK as fine when it is running', async () => {
    // Absence of a signal is not a failing signal.
    const ctx = ctxWith(() => ({ stdout: JSON.stringify({ Running: true, Status: 'running' }) }));

    expect(await containerRunningAndHealthy('lab-app').run(ctx)).toEqual({
      ok: true,
      detail: 'lab-app is running',
    });
  });

  it('fails a running but unhealthy container', async () => {
    const ctx = ctxWith(() => ({
      stdout: JSON.stringify({ Running: true, Health: { Status: 'unhealthy' } }),
    }));
    const outcome = await containerRunningAndHealthy('lab-app').run(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('health check says "unhealthy"');
  });

  it('reports the exit code of a container that stopped', async () => {
    const ctx = ctxWith(() => ({
      stdout: JSON.stringify({ Running: false, Status: 'exited', ExitCode: 137 }),
    }));
    const outcome = await containerRunningAndHealthy('lab-app').run(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('lab-app is exited, last exit 137');
  });

  it('does not use sudo, because docker group membership already grants it', async () => {
    const ctx = ctxWith(() => ({ stdout: JSON.stringify({ Running: true }) }));
    await containerRunningAndHealthy('lab-app').run(ctx);

    expect(ctx.calls[0]?.sudo).toBeUndefined();
  });

  it('fails cleanly on unparseable output rather than throwing', async () => {
    const ctx = ctxWith(() => ({ stdout: 'not json at all' }));

    expect((await containerRunningAndHealthy('lab-app').run(ctx)).ok).toBe(false);
  });
});

describe('httpResponds', () => {
  it('passes on the expected status', async () => {
    const ctx = ctxWith(() => ({ stdout: '200' }));

    expect(
      await httpResponds({ url: 'https://127.0.0.1/health', expectStatus: 200 }).run(ctx),
    ).toEqual({
      ok: true,
      detail: 'https://127.0.0.1/health answered 200',
    });
  });

  it('fails on a different status and names both', async () => {
    const ctx = ctxWith(() => ({ stdout: '502' }));
    const outcome = await httpResponds({ url: 'https://127.0.0.1/health', expectStatus: 200 }).run(
      ctx,
    );

    expect(outcome.detail).toBe('https://127.0.0.1/health answered 502, expected 200');
  });

  it('fails when nothing answered at all', async () => {
    const ctx = ctxWith(() => ({
      stdout: '000',
      stderr: 'curl: (7) Failed to connect',
      exitCode: 7,
    }));
    const outcome = await httpResponds({ url: 'https://127.0.0.1/health', expectStatus: 200 }).run(
      ctx,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('Failed to connect');
  });

  it('builds every check the host policy declares', () => {
    const ctx = ctxWith(
      () => ({}),
      [
        { url: 'https://127.0.0.1/health', expectStatus: 200 },
        { url: 'http://127.0.0.1:3000/ready', expectStatus: 204 },
      ],
    );

    expect(policyHttpChecks(ctx).map((check) => check.name)).toEqual([
      'GET https://127.0.0.1/health responds 200',
      'GET http://127.0.0.1:3000/ready responds 204',
    ]);
  });
});

describe('validatorCommand', () => {
  const nginx: RemoteCommand = { argv: ['nginx', '-t'], sudo: true, timeoutMs: 10_000 };

  it('passes on exit zero', async () => {
    expect(await validatorCommand('nginx -t', nginx).run(ctxWith(() => ({})))).toEqual({
      ok: true,
      detail: 'nginx -t passed',
    });
  });

  it('carries the validator its own error text', async () => {
    const ctx = ctxWith(() => ({
      exitCode: 1,
      stderr: 'nginx: [emerg] unknown directive "prox_pass" in /etc/nginx/sites-enabled/lab:12',
    }));
    const outcome = await validatorCommand('nginx -t', nginx).run(ctx);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('unknown directive "prox_pass"');
  });
});

describe('runChecks', () => {
  /** A check that fails for its first `failures` calls, then passes. */
  function flaky(name: string, failures: number, stableForMs = 0): Check {
    let seen = 0;
    return {
      name,
      stableForMs,
      run() {
        seen += 1;
        return Promise.resolve(
          seen > failures ? { ok: true, detail: 'up' } : { ok: false, detail: 'still down' },
        );
      },
    };
  }

  it('passes trivially when there is nothing to check', async () => {
    expect(
      await runChecks(
        [],
        ctxWith(() => ({})),
      ),
    ).toEqual({ ok: true, checks: [], durationMs: 0 });
  });

  it('retries a check that is slow to come good', async () => {
    const clock = fakeClock();
    const result = await runChecks(
      [flaky('app', 3)],
      ctxWith(() => ({})),
      { ...clock },
    );

    expect(result.ok).toBe(true);
    expect(result.checks[0]).toMatchObject({ name: 'app', ok: true });
  });

  it('backs off rather than hammering a host that just restarted', async () => {
    const waits: number[] = [];
    const clock = fakeClock();
    await runChecks(
      [flaky('app', 4)],
      ctxWith(() => ({})),
      {
        ...clock,
        sleep: (ms) => {
          waits.push(ms);
          return clock.sleep(ms);
        },
      },
    );

    expect(waits).toEqual([500, 1000, 2000, 4000]);
  });

  it('gives up at the deadline and reports what it last saw', async () => {
    const clock = fakeClock();
    const result = await runChecks(
      [flaky('app', Infinity)],
      ctxWith(() => ({})),
      {
        ...clock,
        timeoutMs: 3_000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ ok: false, detail: 'still down' });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('requires a stable check to hold for the whole window', async () => {
    const clock = fakeClock();
    // Passes from the first poll, but must stay passing for 10s.
    const result = await runChecks(
      [flaky('app', 0, 10_000)],
      ctxWith(() => ({})),
      { ...clock },
    );

    expect(result.ok).toBe(true);
    // It cannot have settled before the window elapsed.
    expect(result.durationMs).toBeGreaterThanOrEqual(10_000);
  });

  it('resets the stability clock when a check flickers', async () => {
    // Up, down, then up for good: the middle failure means the early passes
    // count for nothing, which is exactly a service being restarted under us.
    const answers = [true, false, true, true, true, true, true, true, true, true, true, true];
    let index = 0;
    const clock = fakeClock();
    const check: Check = {
      name: 'flickering',
      stableForMs: 2_000,
      run() {
        const ok = answers[index++] ?? true;
        return Promise.resolve({ ok, detail: ok ? 'up' : 'down' });
      },
    };

    const result = await runChecks(
      [check],
      ctxWith(() => ({})),
      { ...clock },
    );

    expect(result.ok).toBe(true);
    // Had the flicker not reset the clock, this would have settled much sooner.
    expect(result.durationMs).toBeGreaterThan(2_000);
  });

  it('says a check was passing but not for long enough, rather than just "failed"', async () => {
    const clock = fakeClock();
    const result = await runChecks(
      [flaky('app', 0, 10_000)],
      ctxWith(() => ({})),
      {
        ...clock,
        timeoutMs: 1_000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toBe('up, but not for the 10s needed to call it stable');
  });

  it('reports every check, not only the first failure', async () => {
    const clock = fakeClock();
    const result = await runChecks(
      [flaky('a', Infinity), flaky('b', 0), flaky('c', Infinity)],
      ctxWith(() => ({})),
      { ...clock, timeoutMs: 2_000 },
    );

    expect(result.checks.map((check) => check.ok)).toEqual([false, true, false]);
    expect(summariseVerify(result)).toBe('2 of 3 check(s) failed: still down; still down');
  });

  it('stops polling a check once it has settled', async () => {
    let calls = 0;
    const clock = fakeClock();
    const settled: Check = {
      name: 'settled',
      run() {
        calls += 1;
        return Promise.resolve({ ok: true, detail: 'up' });
      },
    };

    await runChecks(
      [settled, flaky('slow', 3)],
      ctxWith(() => ({})),
      { ...clock },
    );

    expect(calls).toBe(1);
  });

  it('summarises a clean pass', () => {
    expect(
      summariseVerify({
        ok: true,
        checks: [{ name: 'a', ok: true, detail: 'up' }],
        durationMs: 10,
      }),
    ).toBe('1 check(s) passed');
  });
});
