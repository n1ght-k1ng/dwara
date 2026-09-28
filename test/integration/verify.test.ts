import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SshTransport,
  containerRunningAndHealthy,
  httpResponds,
  loadPolicy,
  runChecks,
  serviceActiveAndStable,
  validatorCommand,
  type Ctx,
} from '@dwara/core';

/**
 * The verifier against a real host.
 *
 * These tests break things on purpose — stop nginx, point it at a dead
 * upstream, put a unit into a genuine restart loop — because a verifier that
 * has only ever seen healthy hosts has not been tested. Everything is put back
 * in `afterAll`.
 *
 *     pnpm testbed:up && DWARA_TESTBED=1 pnpm test:integration
 */
const describeTestbed = process.env['DWARA_TESTBED'] === '1' ? describe : describe.skip;

const HOST = 'lab-staging';
const exec = promisify(execFile);

const transport = new SshTransport({
  sshConfigPath: 'testbed/ssh_config',
  defaultTimeoutMs: 20_000,
});

const ctx: Ctx = {
  host: HOST,
  sessionId: 's_integration',
  httpChecks: [],
  run: (command) => transport.run(HOST, command),
};

/** Fixture setup as root, out of band. Dwara is not permitted to do this. */
async function lab(script: string): Promise<string> {
  const { stdout } = await exec('docker', ['exec', HOST, 'bash', '-c', script]);
  return stdout;
}

/** Fast settings: these tests should not spend a minute proving a failure. */
const QUICK = { timeoutMs: 6_000, initialIntervalMs: 200, maxIntervalMs: 500 };

afterAll(async () => {
  if (process.env['DWARA_TESTBED'] !== '1') return;
  await lab(
    'rm -f /etc/systemd/system/dwara-loop.service; systemctl daemon-reload; systemctl reset-failed dwara-loop.service 2>/dev/null; systemctl start nginx',
  ).catch(() => '');
});

describeTestbed('verifier against the lab', () => {
  it('confirms a genuinely healthy unit', async () => {
    const result = await runChecks([serviceActiveAndStable('nginx', 1_000)], ctx, QUICK);

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.detail).toBe('nginx.service is active (running)');
  });

  it('fails a unit that is stopped, and says so', async () => {
    await lab('systemctl stop nginx');
    try {
      const result = await runChecks([serviceActiveAndStable('nginx', 0)], ctx, QUICK);

      expect(result.ok).toBe(false);
      expect(result.checks[0]?.detail).toContain('is inactive');
    } finally {
      await lab('systemctl start nginx');
    }
  });

  it('catches a real crash loop that reports active at every poll', async () => {
    // A unit that exits immediately with Restart=always. systemd keeps putting
    // it back, so ActiveState is "active" or "activating" much of the time and
    // only NRestarts tells the truth. This is the failure the verifier exists
    // for, and it is worth reproducing rather than simulating.
    await lab(`cat > /etc/systemd/system/dwara-loop.service <<'EOF'
[Service]
ExecStart=/bin/sh -c 'exit 1'
Restart=always
RestartSec=200ms
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl start dwara-loop.service`);

    const result = await runChecks([serviceActiveAndStable('dwara-loop', 4_000)], ctx, {
      ...QUICK,
      timeoutMs: 8_000,
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toMatch(
      /restart loop|is (failed|activating|inactive|deactivating)/,
    );
  });

  it('checks an HTTP endpoint from the host, on the port the host actually uses', async () => {
    // 443, not the 8443 compose publishes to the developer machine. The lab
    // policy said 8443 until this phase, which the host could never have reached.
    const result = await runChecks(
      [httpResponds({ url: 'https://127.0.0.1/health', expectStatus: 200 })],
      ctx,
      QUICK,
    );

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.detail).toContain('answered 200');
  });

  it('uses the checks the committed lab policy declares for lab-api', async () => {
    // Guards the fix: if the policy regains a published port, this fails.
    const policy = await loadPolicy('testbed/policy.yaml');
    const rule = policy.policy.hosts.find((host) => host.match === 'lab-api');
    const check = rule?.health_checks?.[0];

    expect(check?.http).toBe('https://127.0.0.1/health');
    const result = await runChecks(
      [httpResponds({ url: check?.http ?? '', expectStatus: check?.expect_status ?? 200 })],
      { ...ctx, host: 'lab-api', run: (command) => transport.run('lab-api', command) },
      QUICK,
    );
    expect(result.ok).toBe(true);
  });

  it('fails an HTTP check against a port nothing is listening on', async () => {
    const result = await runChecks(
      [httpResponds({ url: 'http://127.0.0.1:3999/health', expectStatus: 200 })],
      ctx,
      QUICK,
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/did not answer/);
  });

  it('confirms a real running container', async () => {
    const result = await runChecks([containerRunningAndHealthy('lab-app', 500)], ctx, QUICK);

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.detail).toContain('lab-app is running');
  });

  it('fails for a container that does not exist', async () => {
    const result = await runChecks(
      [containerRunningAndHealthy('no-such-container', 0)],
      ctx,
      QUICK,
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toContain('cannot inspect');
  });

  it('runs nginx -t as a validator and passes on a good config', async () => {
    const check = validatorCommand('nginx -t', {
      argv: ['nginx', '-t'],
      sudo: true,
      timeoutMs: 15_000,
    });

    expect((await runChecks([check], ctx, QUICK)).ok).toBe(true);
  });

  it('fails the validator on a broken config, carrying nginx its own message', async () => {
    await lab("printf 'prox_pass http://x;\\n' > /etc/nginx/conf.d/dwara-bad.conf");
    try {
      const check = validatorCommand('nginx -t', {
        argv: ['nginx', '-t'],
        sudo: true,
        timeoutMs: 15_000,
      });
      const result = await runChecks([check], ctx, QUICK);

      expect(result.ok).toBe(false);
      expect(result.checks[0]?.detail).toContain('prox_pass');
    } finally {
      await lab('rm -f /etc/nginx/conf.d/dwara-bad.conf');
    }
  });

  it('reports every failing check together, not just the first', async () => {
    const result = await runChecks(
      [
        serviceActiveAndStable('nginx', 0),
        httpResponds({ url: 'http://127.0.0.1:3999/health', expectStatus: 200 }),
        containerRunningAndHealthy('no-such-container', 0),
      ],
      ctx,
      QUICK,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.ok)).toEqual([true, false, false]);
  });
});
