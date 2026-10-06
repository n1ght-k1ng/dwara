import { AuditLog, DEFAULT_AUDIT_PATH, verifyChain, type AuditEntry } from '@dwara/core';

/**
 * `dwara audit` and `dwara audit verify`.
 *
 * The log is only worth keeping if someone can read it, and only worth
 * trusting if someone can check it. `verifyChain` has existed since Phase 2;
 * this is the part that lets a person actually run it — without which the
 * tamper-evidence is a property of a library nobody invokes.
 */

export interface AuditOptions {
  readonly file?: string;
  /** Show only entries for this host. */
  readonly host?: string;
  /** Show only entries for this tool, matched on the bare or prefixed name. */
  readonly tool?: string;
  /** Show only entries that changed something, or tried to. */
  readonly mutationsOnly?: boolean;
  readonly limit?: number;
}

/** Reads the log, applying the filters. */
export async function readAudit(options: AuditOptions = {}): Promise<readonly AuditEntry[]> {
  const log = new AuditLog({ path: options.file ?? DEFAULT_AUDIT_PATH });
  let entries = await log.read();

  if (options.host !== undefined) entries = entries.filter((e) => e.host === options.host);
  if (options.tool !== undefined) {
    const want = options.tool;
    entries = entries.filter((e) => e.tool === want || e.tool.endsWith(`_${want}`));
  }
  if (options.mutationsOnly === true) {
    entries = entries.filter((e) => e.risk !== 'read');
  }

  return options.limit === undefined ? entries : entries.slice(-options.limit);
}

/** The timeline, one line per action. */
export async function formatAudit(options: AuditOptions = {}): Promise<string> {
  const entries = await readAudit(options);
  if (entries.length === 0) return 'No audit entries match.';

  const lines = entries.map((entry) => {
    // No glyph column. There was one -- a tick, a cross, an arrow -- and it said
    // nothing the `result` column two fields along does not say in words, while
    // rendering badly in a terminal or a pasted ticket, which is where an audit
    // log is usually read.
    const time = entry.ts.slice(11, 19);
    const extra = [
      entry.approval === undefined ? '' : `approval=${entry.approval}`,
      entry.snapshot === undefined ? '' : `snapshot=${entry.snapshot}`,
      entry.code === undefined ? '' : entry.code,
    ]
      .filter((part) => part !== '')
      .join(' ');

    return `${time} ${entry.host.padEnd(12)} ${entry.tool.padEnd(30)} ${entry.result.padEnd(11)} ${extra}`.trimEnd();
  });

  const changed = entries.filter((e) => e.result === 'verified' || e.result === 'rolled_back');
  lines.push(
    '',
    `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${changed.length} of which changed a host.`,
  );

  return lines.join('\n');
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Checks the chain and says plainly whether the log can be believed.
 *
 * Reads the whole file rather than a filtered view: a chain is only intact as
 * a whole, and verifying a subset would be a check that always passed.
 */
export async function verifyAudit(file = DEFAULT_AUDIT_PATH): Promise<VerifyReport> {
  const entries = await new AuditLog({ path: file }).read();
  const report = verifyChain(entries);

  if (report.ok) {
    return {
      ok: true,
      text: `${file}: ${report.entries} entr${report.entries === 1 ? 'y' : 'ies'}, chain intact.`,
    };
  }

  const lines = [`${file}: chain is BROKEN.`, ''];
  for (const problem of report.problems) {
    lines.push(`  line ${problem.line}: ${problem.kind} — ${problem.detail}`);
  }
  lines.push(
    '',
    'Every entry after the first problem is suspect. This log has been edited,',
    'truncated or reordered since it was written.',
  );

  return { ok: false, text: lines.join('\n') };
}
