#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { DwaraError, packageVersion } from '@dwara/core';
import { approve, listPending } from './approve.js';
import { formatAudit, verifyAudit } from './audit.js';
import { init } from './init.js';
import { listHostSnapshots, rollback } from './rollback.js';
import { formatReport, runDoctor } from './doctor.js';

/** Package identifier, recorded in audit entries so each one names its build. */
export const PACKAGE_NAME = '@dwara/cli' as const;

/**
 * Version of the Dwara toolchain this build belongs to.
 *
 * Read from the nearest `package.json` rather than written here, so the
 * published binaries cannot report a version the package does not have.
 */
export const VERSION: string = packageVersion(import.meta.url);

export { runDoctor, formatReport } from './doctor.js';
export {
  BLOCK_END,
  BLOCK_START,
  preflightSsm,
  spliceSsmBlock,
  ssmSshConfig,
  ssmTarget,
  usesSsm,
} from './ssm.js';
export type { SsmConfigOptions, SsmHost } from './ssm.js';
export type { DoctorReport, DoctorOptions, HostReport, Check } from './doctor.js';
export { approve, formatRequest, listPending } from './approve.js';
export { hostForSnapshot, listHostSnapshots, rollback } from './rollback.js';
export { formatAudit, readAudit, verifyAudit } from './audit.js';
export { init } from './init.js';
export type { InitOptions, InitResult } from './init.js';
export type { AuditOptions, VerifyReport } from './audit.js';
export type { RollbackOptions, RollbackReport } from './rollback.js';
export type { ApproveOptions, ApproveResult } from './approve.js';

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

  program
    .command('approve')
    .argument('[id]', 'request id, as the agent reported it')
    .description('approve one pending action, after reading what it would do')
    .option('-d, --dir <path>', 'where approvals live', '.dwara')
    .option('--list', 'show what is waiting instead of approving')
    .option('--ttl <minutes>', 'how long the approval stays valid', '15')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(
      async (
        id: string | undefined,
        options: { dir: string; list?: boolean; ttl: string; yes?: boolean },
      ) => {
        if (options.list === true || id === undefined) {
          console.log(await listPending(options.dir));
          return;
        }

        const result = await approve(id, {
          dir: options.dir,
          ttlMs: Number(options.ttl) * 60_000,
          ...(options.yes === true ? { yes: true } : {}),
        });

        console.log(result.text);
        // Declining is a decision, not a failure, but the exit code has to
        // distinguish them for anything scripting this.
        process.exitCode = result.ok ? 0 : 1;
      },
    );

  program
    .command('rollback')
    .argument('[id]', 'snapshot id, e.g. snap_0a1b2c3d')
    .description('restore a host to a snapshot, without the agent')
    .option('-F, --ssh-config <path>', 'SSH config to use', '~/.ssh/config')
    .option('--host <alias>', 'which host; inferred from the audit log when omitted')
    .option('--audit <path>', 'audit log to look the host up in')
    .option('--list', 'list the snapshots on --host instead of restoring')
    .action(
      async (
        id: string | undefined,
        options: { sshConfig: string; host?: string; audit?: string; list?: boolean },
      ) => {
        if (options.list === true) {
          if (options.host === undefined) {
            throw new DwaraError('INTERNAL', '--list needs --host');
          }
          console.log(await listHostSnapshots(options.host, { sshConfigPath: options.sshConfig }));
          return;
        }

        if (id === undefined) {
          throw new DwaraError('INTERNAL', 'give a snapshot id, or --list --host <host>');
        }

        const report = await rollback(id, {
          sshConfigPath: options.sshConfig,
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.audit === undefined ? {} : { auditPath: options.audit }),
        });

        console.log(report.text);
        process.exitCode = report.ok ? 0 : 1;
      },
    );

  program
    .command('init')
    .description('set Dwara up in this project: pick hosts, write a policy, register the server')
    .option('-F, --ssh-config <path>', 'SSH config to read hosts from', '~/.ssh/config')
    .option('-d, --dir <path>', 'where to write .dwara and .claude', '.')
    .option('--host <alias...>', 'hosts to manage; asked for interactively when omitted')
    .option('--production <alias...>', 'of those, the ones to treat as production')
    .option('--no-doctor', 'skip the connectivity check')
    .option('--no-register', 'do not run `claude mcp add`')
    .option('-y, --yes', 'take every default; needs --host')
    .action(
      async (options: {
        sshConfig: string;
        dir: string;
        host?: string[];
        production?: string[];
        doctor: boolean;
        register: boolean;
        yes?: boolean;
      }) => {
        const result = await init({
          sshConfigPath: options.sshConfig,
          dir: options.dir,
          ...(options.host === undefined ? {} : { hosts: options.host }),
          ...(options.production === undefined ? {} : { production: options.production }),
          skipDoctor: !options.doctor,
          register: options.register,
          ...(options.yes === true ? { yes: true } : {}),
        });

        console.log(result.text);
        process.exitCode = result.ok ? 0 : 1;
      },
    );

  const audit = program
    .command('audit')
    .description('read the audit log, or check that it has not been tampered with')
    .option('-f, --file <path>', 'audit log to read', '.dwara/audit.jsonl')
    .option('--host <alias>', 'only this host')
    .option('--tool <name>', 'only this tool')
    .option('--changes', 'only actions that changed something, or tried to')
    .option('-n, --limit <count>', 'show only the last N entries')
    .action(
      async (options: {
        file: string;
        host?: string;
        tool?: string;
        changes?: boolean;
        limit?: string;
      }) => {
        console.log(
          await formatAudit({
            file: options.file,
            ...(options.host === undefined ? {} : { host: options.host }),
            ...(options.tool === undefined ? {} : { tool: options.tool }),
            ...(options.changes === true ? { mutationsOnly: true } : {}),
            ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
          }),
        );
      },
    );

  audit
    .command('verify')
    .description('check the hash chain end to end')
    .option('-f, --file <path>', 'audit log to check', '.dwara/audit.jsonl')
    .action(async (options: { file: string }) => {
      const report = await verifyAudit(options.file);
      console.log(report.text);
      // Non-zero so this is usable in CI and in the eval harness.
      process.exitCode = report.ok ? 0 : 1;
    });

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
