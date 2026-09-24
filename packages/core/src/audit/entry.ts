import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Risk } from '../types.js';

/**
 * One line of `.dwara/audit.jsonl`.
 *
 * Shape follows DESIGN §14. Note what is absent: **there is no output field.**
 * An audit log that stored what each tool returned would be a second,
 * unredacted-by-default copy of everything the redactor exists to protect, sat
 * in a file people naturally treat as safe to share. Inputs are recorded
 * because they are what the agent chose to do; output is what the host said,
 * and the result line records only whether it worked.
 */
export const auditEntrySchema = z
  .object({
    /** ISO 8601, UTC. */
    ts: z.string(),
    /** Groups entries from one agent session. */
    session: z.string(),
    /** Which client drove it, e.g. `claude-code`. */
    agent: z.string(),
    /** Tool name as the MCP client sees it, risk prefix included. */
    tool: z.string(),
    host: z.string(),
    risk: z.enum(Risk),
    decision: z.enum(['allow', 'approval', 'deny']),
    /** The policy rule that decided, so an entry traces back to a line of config. */
    rule: z.string(),
    /** Present on a refusal. */
    code: z.string().optional(),
    /** Tool arguments, redacted. */
    input: z.record(z.string(), z.unknown()).default({}),
    result: z.enum(['ok', 'failed', 'refused', 'error']),
    /** Short, redacted summary — never the tool's output. */
    detail: z.string().default(''),
    duration_ms: z.number().int().nonnegative().default(0),
    /** SHA-256 of the policy file in force. */
    policy_hash: z.string(),
    /** Hash of the previous entry; the genesis value for the first. */
    prev_hash: z.string(),
    /** Hash of this entry, covering every field above. */
    hash: z.string(),
  })
  .strict();

export type AuditEntry = z.output<typeof auditEntrySchema>;

/** Everything except the chain fields, which the log computes. */
export type AuditInput = Omit<AuditEntry, 'hash' | 'prev_hash' | 'ts'> & { ts?: string };

/** `prev_hash` of the first entry. Marks the start of a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical JSON: keys sorted, no incidental whitespace.
 *
 * The hash has to be reproducible by anything re-reading the file later, so it
 * cannot depend on the key order a particular JSON serialiser happened to use.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The hash of an entry, over every field except `hash` itself.
 *
 * `prev_hash` is one of the covered fields, which is what chains the entries:
 * changing any line changes its hash, which invalidates the `prev_hash` of the
 * next line, and so on to the end of the file.
 */
export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalise(entry), 'utf8').digest('hex');
}
