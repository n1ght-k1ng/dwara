import { GENESIS_HASH, hashEntry, type AuditEntry } from './entry.js';

/** What went wrong with one line, and where. */
export interface ChainProblem {
  /** 1-based, so it matches what an editor shows. */
  readonly line: number;
  readonly kind: 'bad-hash' | 'broken-link' | 'bad-genesis';
  readonly detail: string;
}

export interface ChainReport {
  readonly ok: boolean;
  readonly entries: number;
  readonly problems: readonly ChainProblem[];
}

/**
 * Walks the chain and reports the first line that does not add up.
 *
 * Two independent checks per entry, because they catch different tampering:
 *
 * - **bad-hash** — the entry's own contents no longer match its `hash`. Someone
 *   edited a field and left the hash alone.
 * - **broken-link** — the entry's `prev_hash` does not match the previous
 *   entry's `hash`. Someone deleted, reordered or inserted a line.
 *
 * Recomputing hashes forward from an edit defeats both, which is why this
 * detects tampering rather than preventing it. Catching the careless case is
 * still worth having, and a chain that verifies is evidence the file has not
 * been casually edited.
 */
export function verifyChain(entries: readonly AuditEntry[]): ChainReport {
  const problems: ChainProblem[] = [];

  entries.forEach((entry, index) => {
    const line = index + 1;

    const { hash, ...rest } = entry;
    const expected = hashEntry(rest);
    if (expected !== hash) {
      problems.push({
        line,
        kind: 'bad-hash',
        detail: `contents do not match the recorded hash (expected ${expected.slice(0, 12)}…, found ${hash.slice(0, 12)}…)`,
      });
    }

    const previous = index === 0 ? GENESIS_HASH : entries[index - 1]!.hash;
    if (entry.prev_hash !== previous) {
      problems.push({
        line,
        kind: index === 0 ? 'bad-genesis' : 'broken-link',
        detail:
          index === 0
            ? 'the first entry does not start from the genesis hash, so earlier lines were removed'
            : `prev_hash does not match line ${index}, so a line was changed, removed or inserted`,
      });
    }
  });

  return { ok: problems.length === 0, entries: entries.length, problems };
}
