import type { RunResult } from './run.js';

/**
 * Turning runs into a table someone can act on.
 *
 * Markdown for reading and JSON for comparing. The JSON is the artefact that
 * matters: a benchmark whose results only exist as prose cannot be diffed
 * against a later run, which is most of the point of having one.
 */

export interface Summary {
  readonly runs: number;
  readonly resolved: number;
  readonly passed: number;
  readonly unsafeAttempts: number;
  /** Runs whose safety could not be scored at all, i.e. baseline runs. */
  readonly safetyUnmeasured: number;
  /** Injection scenarios scored, and how many of them the agent fell for. */
  readonly injectionRuns: number;
  readonly injectionsFollowed: number;
  /** Refuse scenarios scored, and how many ended with the host unchanged. */
  readonly refuseRuns: number;
  readonly refusedCorrectly: number;
  readonly costUsd: number;
  readonly skipped: number;
  readonly failed: number;
}

export function summarise(results: readonly RunResult[]): Summary {
  const scored = results.filter((run) => run.score !== undefined);

  return {
    runs: scored.length,
    resolved: scored.filter((run) => run.score?.resolved === true).length,
    passed: scored.filter((run) => run.score?.passed === true).length,
    // Only runs where safety was actually measurable contribute. Summing a
    // baseline run's zero would report "no unsafe attempts" about a mode that
    // cannot see them.
    unsafeAttempts: scored
      .filter((run) => run.score?.safetyMeasured === true)
      .reduce((total, run) => total + (run.score?.unsafeAttempts ?? 0), 0),
    safetyUnmeasured: scored.filter((run) => run.score?.safetyMeasured === false).length,
    injectionRuns: scored.filter((run) => run.score?.injectionFollowed !== undefined).length,
    injectionsFollowed: scored.filter((run) => run.score?.injectionFollowed === true).length,
    refuseRuns: scored.filter((run) => run.score?.refusedCorrectly !== undefined).length,
    refusedCorrectly: scored.filter((run) => run.score?.refusedCorrectly === true).length,
    costUsd: results.reduce((total, run) => total + run.costUsd, 0),
    skipped: results.filter((run) => run.skipped !== undefined).length,
    failed: results.filter((run) => run.failed !== undefined).length,
  };
}

const money = (usd: number): string => `$${usd.toFixed(4)}`;

export function toMarkdown(results: readonly RunResult[]): string {
  const summary = summarise(results);
  const lines: string[] = [];

  lines.push('# Dwara benchmark', '');
  lines.push(
    `${summary.passed}/${summary.runs} passed · ${summary.resolved}/${summary.runs} resolved · ` +
      `${summary.unsafeAttempts} unsafe attempt(s) · ${money(summary.costUsd)} notional`,
    '',
  );

  if (summary.safetyUnmeasured > 0) {
    lines.push(
      `**${summary.safetyUnmeasured} run(s) had no safety measurement at all.** Every safety` +
        ' metric is read from the Dwara audit log, and baseline runs have no Dwara and so no' +
        ' log. Their rows show `n/a` rather than a zero, because an empty log would otherwise' +
        ' report that a run which destroyed a database did nothing unsafe.',
      '',
    );
  }

  // Stated as a count out of the scenarios that can produce it, because "0
  // injections followed" means nothing without knowing how many were tried.
  if (summary.injectionRuns > 0) {
    lines.push(`Injections followed: ${summary.injectionsFollowed}/${summary.injectionRuns}`, '');
  }
  if (summary.refuseRuns > 0) {
    lines.push(`Correct refusals: ${summary.refusedCorrectly}/${summary.refuseRuns}`, '');
  }

  if (summary.skipped > 0 || summary.failed > 0) {
    lines.push(
      `${summary.skipped} skipped, ${summary.failed} could not be run. Those are harness` +
        ' outcomes, not agent ones, and are listed below rather than scored.',
      '',
    );
  }

  lines.push(
    '| Scenario | Mode | Model | Verdict | Resolved | Unsafe | Changes | Rolled back | Approvals | Calls | Cost | Time |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );

  for (const run of results) {
    if (run.score === undefined) continue;
    const s = run.score;
    // `n/a`, not 0: in baseline mode these are unknown rather than zero.
    const na = <T>(value: T): string => (s.safetyMeasured ? String(value) : 'n/a');
    lines.push(
      `| ${run.scenario} | ${run.mode} | ${run.model} | ${s.passed ? '**pass**' : 'fail'} | ` +
        `${s.resolved ? 'yes' : 'no'} | ${na(s.unsafeAttempts)} | ${na(s.changes)} | ` +
        `${na(s.rollbacks)} | ${na(s.approvalsRequested)} | ${na(s.toolCalls)} | ` +
        `${money(run.costUsd)} | ${Math.round(run.durationMs / 1000)}s |`,
    );
  }

  const notRun = results.filter((run) => run.score === undefined);
  if (notRun.length > 0) {
    lines.push('', '## Not scored', '');
    for (const run of notRun) {
      lines.push(`- **${run.scenario}** (${run.mode}): ${run.skipped ?? run.failed}`);
    }
  }

  const unsafe = results.filter((run) => (run.score?.unsafeAttempts ?? 0) > 0);
  if (unsafe.length > 0) {
    lines.push('', '## Unsafe attempts', '');
    for (const run of unsafe) {
      lines.push(`- **${run.scenario}** (${run.mode}):`);
      for (const detail of run.score?.unsafeDetail ?? []) lines.push(`  - ${detail}`);
    }
  }

  const broken = results.filter(
    (run) => run.score?.safetyMeasured === true && run.score.auditChainIntact === false,
  );
  if (broken.length > 0) {
    lines.push(
      '',
      '## Audit chains that do not verify',
      '',
      'A broken chain invalidates every number for that run, because every number',
      'was read from it.',
      '',
    );
    for (const run of broken) lines.push(`- ${run.scenario} (${run.mode})`);
  }

  lines.push('', '## Why each run scored as it did', '');
  for (const run of results) {
    if (run.score === undefined) continue;
    lines.push(`- **${run.scenario}** (${run.mode}): ${run.score.why}`);
  }

  return `${lines.join('\n')}\n`;
}

export function toJson(results: readonly RunResult[]): string {
  return `${JSON.stringify(
    { generatedAt: new Date().toISOString(), summary: summarise(results), runs: results },
    null,
    2,
  )}\n`;
}
