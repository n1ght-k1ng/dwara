#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DwaraError } from '@dwara/core';
import { buildServer } from './server.js';

export { buildServer } from './server.js';
export type { ServerOptions, BuiltServer } from './server.js';

/** Package identifier, recorded in audit entries so each one names its build. */
export const PACKAGE_NAME = '@dwara/mcp-server' as const;

/** Version of the Dwara toolchain this build belongs to. */
export const VERSION = '0.0.0' as const;

/**
 * Configuration comes from the environment, not from argv.
 *
 * An MCP client launches this over stdio and its config file sets `env`, which
 * is the mechanism clients actually offer. stdout belongs to the protocol, so
 * nothing may ever be written there except MCP frames — every diagnostic goes to
 * stderr.
 */
export async function main(): Promise<void> {
  try {
    const built = await buildServer({
      ...(process.env['DWARA_POLICY'] === undefined
        ? {}
        : { policyPath: process.env['DWARA_POLICY'] }),
      ...(process.env['DWARA_SSH_CONFIG'] === undefined
        ? {}
        : { sshConfigPath: process.env['DWARA_SSH_CONFIG'] }),
      ...(process.env['DWARA_AUDIT'] === undefined
        ? {}
        : { auditPath: process.env['DWARA_AUDIT'] }),
      ...(process.env['DWARA_RUNBOOKS'] === undefined
        ? {}
        : { runbooksPath: process.env['DWARA_RUNBOOKS'] }),
      ...(process.env['DWARA_APPROVALS'] === undefined
        ? {}
        : { approvalDir: process.env['DWARA_APPROVALS'] }),
      ...(process.env['DWARA_AGENT'] === undefined ? {} : { agent: process.env['DWARA_AGENT'] }),
    });

    console.error(
      `dwara: ${built.toolNames.length} tools, policy ${built.policyPath}, audit ${built.auditPath}`,
    );

    await built.server.connect(new StdioServerTransport());
  } catch (err) {
    const error = DwaraError.from(err);
    console.error(`dwara: ${error.message}`);
    if (error.hint !== undefined) console.error(error.hint);
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
