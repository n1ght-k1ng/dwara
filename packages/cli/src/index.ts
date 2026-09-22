#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { DwaraError } from '@dwara/core';
import { formatReport, runDoctor } from './doctor.js';

/** Package identifier, recorded in audit entries so each one names its build. */
export const PACKAGE_NAME = '@dwara/cli' as const;

/** Version of the Dwara toolchain this build belongs to. */
export const VERSION = '0.0.0' as const;

export { runDoctor, formatReport } from './doctor.js';
export type { DoctorReport, DoctorOptions, HostReport, Check } from './doctor.js';

/** Builds the CLI. Exported so tests can drive it without spawning a process. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dwara')
    .description('Policy-controlled SSH access for AI coding agents')
    .version(VERSION);

  program
    .command('doctor')
    .description('check that every managed host is reachable and correctly set up')
    .option('-F, --ssh-config <path>', 'SSH config to use', '~/.ssh/config')
    .option(
      '-p, --policy <path>',
      'policy file; without one, every host in the SSH config is checked',
    )
    .option('--host <alias...>', 'check only these hosts')
    .option('--timeout <ms>', 'per-command timeout', '15000')
    .action(
      async (options: { sshConfig: string; policy?: string; host?: string[]; timeout: string }) => {
        const report = await runDoctor({
          sshConfigPath: options.sshConfig,
          ...(options.policy === undefined ? {} : { policyPath: options.policy }),
          ...(options.host === undefined ? {} : { hosts: options.host }),
          timeoutMs: Number(options.timeout),
        });

        console.log(formatReport(report, process.stdout.isTTY === true));
        // A non-zero exit is what makes this usable in CI and in `init`.
        process.exitCode = report.ok ? 0 : 1;
      },
    );

  return program;
}

/** Entry point. Typed errors are reported as messages, never as stack traces. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (err) {
    const error = DwaraError.from(err);
    console.error(`dwara: ${error.message}`);
    if (error.hint !== undefined) console.error(`\n${error.hint}`);
    process.exitCode = 1;
  }
}

/** True only when this module is the process entry point, so importing the CLI
 * from a test does not run it. Paths are resolved through symlinks because the
 * `dwara` bin is one. */
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
