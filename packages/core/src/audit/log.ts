import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DwaraError } from '../errors.js';
import { defaultRedactor } from '../redact/redact.js';
import type { Redactor } from '../redact/redact.js';
import {
  GENESIS_HASH,
  auditEntrySchema,
  canonicalise,
  hashEntry,
  type AuditEntry,
  type AuditInput,
} from './entry.js';

/** Where `dwara init` puts the log, relative to the project root. */
export const DEFAULT_AUDIT_PATH = '.dwara/audit.jsonl';

export interface AuditLogOptions {
  readonly path?: string;
  /** Used on inputs and details before they are written. */
  readonly redactor?: Redactor;
}

/**
 * Append-only, hash-chained record of everything Dwara did.
 *
 * Every tool call is recorded, **including refusals** — a policy that denied
 * something is exactly what an incident review needs to see, and a log holding
 * only successful actions would describe an agent that never hit a limit.
 *
 * The chain makes tampering detectable, not impossible. Anyone who can write
 * the file can rewrite it from any point and recompute the hashes after it; what
 * they cannot do is change one line and leave the rest intact. Making it
 * genuinely append-only is an operating-system question (`chattr +a`, shipping
 * lines off-host) and is documented rather than pretended at.
 */
export class AuditLog {
  private readonly path: string;
  private readonly redactor: Redactor;
  /** Cached tail hash, so a long log is not re-read on every append. */
  private tail: string | undefined;

  constructor(options: AuditLogOptions = {}) {
    this.path = resolve(options.path ?? DEFAULT_AUDIT_PATH);
    this.redactor = options.redactor ?? defaultRedactor;
  }

  /** Absolute path of the log file. */
  get file(): string {
    return this.path;
  }

  /**
   * Appends an entry, chaining it to the last one.
   *
   * Inputs and detail pass through the redactor first: an agent can put a
   * password in a tool argument, and the log must not be where it lands.
   */
  async append(input: AuditInput): Promise<AuditEntry> {
    const prev = this.tail ?? (await this.lastHash());

    const unhashed: Omit<AuditEntry, 'hash'> = {
      ...input,
      ts: input.ts ?? new Date().toISOString(),
      input: this.redactor.redactDeep(input.input ?? {}),
      detail: this.redactor.redact(input.detail ?? '').text,
      prev_hash: prev,
    };

    const entry: AuditEntry = { ...unhashed, hash: hashEntry(unhashed) };

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${canonicalise(entry)}\n`, { mode: 0o600 });
    this.tail = entry.hash;

    return entry;
  }

  /** Every entry, oldest first. An absent log reads as empty. */
  async read(): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }

    const entries: AuditEntry[] = [];
    text.split('\n').forEach((line, index) => {
      if (line.trim() === '') return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new DwaraError('INTERNAL', `audit log line ${index + 1} is not valid JSON`, {
          details: { path: this.path, line: index + 1 },
          cause,
        });
      }

      const result = auditEntrySchema.safeParse(parsed);
      if (!result.success) {
        throw new DwaraError('INTERNAL', `audit log line ${index + 1} is not a valid entry`, {
          details: { path: this.path, line: index + 1 },
        });
      }
      entries.push(result.data);
    });

    return entries;
  }

  /** Hash of the last entry, or the genesis value for an empty log. */
  private async lastHash(): Promise<string> {
    const entries = await this.read();
    return entries[entries.length - 1]?.hash ?? GENESIS_HASH;
  }
}
