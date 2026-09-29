import {
  DEFAULT_AUDIT_PATH,
  DwaraError,
  SshTransport,
  confirmRestored,
  isSnapshotId,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  type Ctx,
} from '@dwara/core';
import { readFile } from 'node:fs/promises';

/**
 * `dwara rollback <id>` — restoring a host without the agent.
 *
 * This is the command that makes the whole snapshot design worth something.
 * Everything else assumes a working session: a pipeline, an MCP server, a
 * model deciding what to do next. This assumes none of it. The snapshot
 * describes itself on the host it belongs to, so a person with SSH access and
 * this binary can put a machine back from a different laptop, days later,
 * after the session that broke it is gone.
 *
 * It is also what the chaos case rests on. If the connection dies mid-apply,
 * the snapshot is already on the host and this is how it gets used.
 */

export interface RollbackOptions {
  readonly sshConfigPath?: string;
  /** Skipped when the audit log already knows which host the snapshot is on. */
  readonly host?: string;
  readonly auditPath?: string;
  readonly timeoutMs?: number;
}

export interface RollbackReport {
  readonly ok: boolean;
  readonly text: string;
}

function context(host: string, transport: SshTransport): Ctx {
  return {
    host,
    sessionId: 'cli',
    httpChecks: [],
    run: (command) => transport.run(host, command),
  };
}

/**
 * Finds which host a snapshot belongs to by reading the audit log.
 *
 * Saves the person having to remember, which at the moment they need this
 * command they will not. Returns undefined if the log does not know.
 */
export async function hostForSnapshot(
  id: string,
  auditPath = DEFAULT_AUDIT_PATH,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(auditPath, 'utf8');
  } catch {
    return undefined;
  }

  // Newest first: a snapshot id is unique, but reading backwards costs nothing
  // and is right if one were ever reused.
  for (const line of text.split('\n').reverse()) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { snapshot?: string; host?: string };
      if (entry.snapshot === id && typeof entry.host === 'string') return entry.host;
    } catch {
      continue;
    }
  }

  return undefined;
}

/** Every snapshot on a host, newest first, as a person would want it listed. */
export async function listHostSnapshots(
  host: string,
  options: RollbackOptions = {},
): Promise<string> {
  const transport = new SshTransport({
    ...(options.sshConfigPath === undefined ? {} : { sshConfigPath: options.sshConfigPath }),
  });
  const found = await listSnapshots(context(host, transport));

  if (found.length === 0) return `No snapshots on ${host}.`;

  const lines = [`Snapshots on ${host}, newest first:`, ''];
  for (const item of found) {
    lines.push(`  ${item.id}  ${new Date(item.modifiedAt * 1000).toISOString()}`);
  }
  lines.push('', `Run \`dwara rollback <id> --host ${host}\` to restore one.`);
  return lines.join('\n');
}

/**
 * Restores a snapshot and reports whether it really went back.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` for a malformed id, `INTERNAL` when the
 *   host cannot be determined.
 */
export async function rollback(id: string, options: RollbackOptions = {}): Promise<RollbackReport> {
  if (!isSnapshotId(id)) {
    throw new DwaraError('UNSAFE_ARGUMENT', `"${id}" is not a snapshot id`, {
      details: { snapshot: id },
      hint: 'ids look like snap_0a1b2c3d; `dwara rollback --list --host <host>` shows what exists',
    });
  }

  const host = options.host ?? (await hostForSnapshot(id, options.auditPath ?? DEFAULT_AUDIT_PATH));

  if (host === undefined) {
    throw new DwaraError('INTERNAL', `cannot tell which host ${id} belongs to`, {
      details: { snapshot: id },
      hint: 'pass --host, or run this where the audit log that recorded it lives',
    });
  }

  const transport = new SshTransport({
    ...(options.sshConfigPath === undefined ? {} : { sshConfigPath: options.sshConfigPath }),
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
  });
  const ctx = context(host, transport);

  const snapshot = await readSnapshot(id, ctx);
  const restore = await restoreSnapshot(snapshot, ctx);
  const state = await confirmRestored(snapshot, ctx);
  const ok = restore.ok && state.ok;

  const lines = [
    `Snapshot ${id} on ${host}, taken ${snapshot.createdAt}.`,
    '',
    ...(snapshot.paths.length === 0
      ? ['  No files were in this snapshot.']
      : snapshot.paths.map(
          (path) => `  ${restore.mismatched.includes(path) ? 'FAILED ' : 'restored'}  ${path}`,
        )),
    '',
    `  Files:    ${restore.detail}`,
    `  Services: ${state.detail}`,
    '',
  ];

  lines.push(
    ok
      ? 'Restored. Every file matches the hash recorded when the snapshot was taken.'
      : restore.mismatched.length > 0
        ? 'NOT fully restored. Some files did not come back as recorded; this host needs a person.'
        : 'Files restored, but the services are not as they were. Reload or restart them, then check again.',
  );

  return { ok, text: lines.join('\n') };
}
