#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { listScenarios, loadScenario } from './scenario.js';
import { runScenario, type Mode, type RunResult } from './run.js';
import { toJson, toMarkdown, summarise } from './report.js';

export { listScenarios, loadScenario, metaSchema } from './scenario.js';
export type { Scenario, ScenarioMeta } from './scenario.js';
export { runScenario } from './run.js';
export type { Mode, RunOptions, RunResult } from './run.js';
export { scoreRun } from './score.js';
export type { Score } from './score.js';
export { readEnvelope, runTurn } from './agent.js';
export type { TurnResult, Usage } from './agent.js';
export { summarise, toJson, toMarkdown } from './report.js';
export { absoluteSshConfig } from './sshconfig.js';
export type { Summary } from './report.js';

/**
 * `dwara-eval` — the benchmark runner.
 *
 * `--validate-only` is the mode to reach for first and costs nothing: it proves
 * every scenario's break and check behave, which is most of what can go wrong
 * and needs no model at all.
 */

/** Validates every scenario's break and check against the lab. No model calls. */
async function validateAll(root: string | undefined): Promise<number> {
  const names = await listScenarios(root);
  let bad = 0;

  for (const name of names) {
    try {
      const scenario = await loadScenario(name, root);
      console.log(
        `  ok    ${name.padEnd(28)} ${scenario.meta.category}/${scenario.meta.difficulty}`,
      );
    } catch (cause) {
      bad += 1;
      console.error(`  BAD   ${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  console.log(`\n${names.length - bad}/${names.length} scenarios are well formed.`);
  console.log('Run the break/check cycle against the lab with `pnpm eval:validate`.');
  return bad === 0 ? 0 : 1;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dwara-eval')
    .description('Run the Dwara benchmark scenarios against the testbed')
    .option('-s, --scenario <name...>', 'scenarios to run; all of them when omitted')
    .option('-m, --model <id>', 'model to run', 'claude-sonnet-5-5')
    .option('--mode <mode>', 'dwara or baseline', 'dwara')
    .option('--budget <usd>', 'stop before exceeding this total spend', '5')
    .option('--max-turns <n>', 'turns per scenario', '4')
    .option('-o, --out <dir>', 'where to write results', 'evals/results')
    .option('--scenario-root <dir>', 'where the scenarios live')
    .option('--validate-only', 'check every scenario is well formed, and stop')
    .action(
      async (options: {
        scenario?: string[];
        model: string;
        mode: string;
        budget: string;
        maxTurns: string;
        out: string;
        scenarioRoot?: string;
        validateOnly?: boolean;
      }) => {
        if (options.validateOnly === true) {
          process.exitCode = await validateAll(options.scenarioRoot);
          return;
        }

        const names = options.scenario ?? [...(await listScenarios(options.scenarioRoot))];
        const budget = Number(options.budget);
        const mode = options.mode === 'baseline' ? 'baseline' : 'dwara';

        console.log(
          `${names.length} scenario(s), ${options.model}, mode ${mode}, budget $${budget.toFixed(2)}\n`,
        );

        const results: RunResult[] = [];
        let spent = 0;

        for (const name of names) {
          process.stdout.write(`${name.padEnd(28)} `);

          const result = await runScenario({
            scenario: name,
            model: options.model,
            mode: mode as Mode,
            budgetUsd: budget,
            spentUsd: spent,
            maxTurns: Number(options.maxTurns),
            outDir: join(options.out, `${name}-${mode}-${options.model}`),
            ...(options.scenarioRoot === undefined ? {} : { scenarioRoot: options.scenarioRoot }),
          });

          results.push(result);
          spent += result.costUsd;

          if (result.skipped !== undefined) console.log(`skipped — ${result.skipped}`);
          else if (result.failed !== undefined) console.log(`could not run — ${result.failed}`);
          else {
            console.log(
              `${result.score?.passed === true ? 'pass' : 'fail'}  ` +
                `$${result.costUsd.toFixed(4)}  ${result.score?.why ?? ''}`,
            );
          }
        }

        await mkdir(options.out, { recursive: true });
        await writeFile(join(options.out, 'report.md'), toMarkdown(results), 'utf8');
        await writeFile(join(options.out, 'report.json'), toJson(results), 'utf8');

        const summary = summarise(results);
        console.log(
          `\n${summary.passed}/${summary.runs} passed · ${summary.unsafeAttempts} unsafe · ` +
            `$${summary.costUsd.toFixed(4)} spent`,
        );
        console.log(`Report: ${join(options.out, 'report.md')}`);

        process.exitCode = summary.failed > 0 ? 1 : 0;
      },
    );

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (cause) {
    console.error(`dwara-eval: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
