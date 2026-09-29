import { DwaraError } from '@dwara/core';

/**
 * Applying a unified diff, exactly and locally.
 *
 * Two decisions, and both are about safety rather than convenience.
 *
 * **Exactly.** There is no fuzz, no offset search, no whitespace tolerance. A
 * hunk applies at the line it names with the context it states, or it does not
 * apply at all. `patch(1)` will happily place a hunk a few lines away from
 * where it was aimed, which is helpful for a person merging by hand and
 * unacceptable here: the bytes a human approved are the bytes that must land,
 * and a diff that lands somewhere else is a different change wearing the same
 * plan hash.
 *
 * **Locally.** The diff is applied in this process and the whole resulting file
 * is written out, rather than piping the diff to `patch` on the host. That
 * removes a binary from the remote requirement list — `patch` is not installed
 * on the lab images — but the reason is the one above: the result is computed
 * where it can be hashed, shown and compared before anything is written.
 */

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Each line with its leading ' ', '-' or '+' intact. */
  readonly lines: readonly string[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified diff into hunks.
 *
 * File headers (`---`, `+++`, `diff`, `index`) are skipped: the tool is told
 * which path it is editing, and a header claiming a different one must not be
 * able to redirect the write.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` when the diff is malformed.
 */
export function parseDiff(diff: string): readonly Hunk[] {
  const hunks: Hunk[] = [];
  let current: { header: RegExpExecArray; lines: string[] } | undefined;

  const all = diff.split('\n');
  // A diff that ends with a newline splits to a final empty element. That is
  // the terminator, not an empty context line, and treating it as content
  // appends a phantom blank line to every hunk.
  const lines = all[all.length - 1] === '' ? all.slice(0, -1) : all;

  for (const line of lines) {
    const header = HEADER.exec(line);

    if (header) {
      if (current) hunks.push(toHunk(current));
      current = { header, lines: [] };
      continue;
    }

    if (current === undefined) {
      // Everything before the first hunk is a file header or preamble.
      continue;
    }

    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      current.lines.push(line);
    } else if (line === '') {
      // A bare empty line is an unchanged empty line that lost its leading
      // space, which most editors and many tools produce.
      current.lines.push(' ');
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file". Handled by the caller's trailing-newline
      // bookkeeping rather than as content.
      continue;
    } else {
      throw new DwaraError('UNSAFE_ARGUMENT', `diff has an unreadable line: ${trim(line)}`, {
        details: { line: trim(line) },
        hint: 'every line inside a hunk must start with a space, a minus or a plus',
      });
    }
  }

  if (current) hunks.push(toHunk(current));

  if (hunks.length === 0) {
    throw new DwaraError('UNSAFE_ARGUMENT', 'diff contains no hunks', {
      hint: 'a unified diff needs at least one "@@ -old,count +new,count @@" header',
    });
  }

  return hunks;
}

/**
 * Applies a unified diff to `content` and returns the result.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` when the diff is malformed.
 * @throws DwaraError `PLAN_MISMATCH` when a hunk does not match the file
 *   exactly where it says it should. That is the file having changed, or the
 *   diff having been written against something else, and either way the result
 *   would not be what was reviewed.
 */
export function applyDiff(content: string, diff: string): string {
  const hunks = parseDiff(diff);
  const endsWithNewline = content.endsWith('\n');
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');

  const out: string[] = [];
  // Zero-based index into `lines` of the next line not yet copied.
  let cursor = 0;

  for (const hunk of hunks) {
    // A hunk with oldLines 0 is an insertion after oldStart, so it begins at
    // oldStart rather than oldStart - 1.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;

    if (start < cursor) {
      throw new DwaraError('UNSAFE_ARGUMENT', 'diff hunks overlap or are out of order', {
        details: { hunk: `@@ -${hunk.oldStart},${hunk.oldLines} @@` },
      });
    }
    if (start > lines.length) {
      throw new DwaraError(
        'PLAN_MISMATCH',
        `diff expects at least ${start} line(s) but the file has ${lines.length}`,
        { details: { expected: start, actual: lines.length } },
      );
    }

    out.push(...lines.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);

      if (marker === '+') {
        out.push(text);
        continue;
      }

      const actual = lines[cursor];
      if (actual !== text) {
        throw new DwaraError(
          'PLAN_MISMATCH',
          `diff does not match the file at line ${cursor + 1}: expected ${JSON.stringify(trim(text))}, found ${JSON.stringify(trim(actual ?? '<end of file>'))}`,
          { details: { line: cursor + 1, expected: trim(text), actual: trim(actual ?? '') } },
        );
      }

      cursor += 1;
      if (marker === ' ') out.push(text);
    }
  }

  out.push(...lines.slice(cursor));

  const result = out.join('\n');
  // An empty result should not become a lone newline.
  return result === '' ? '' : endsWithNewline || out.length > 0 ? `${result}\n` : result;
}

/** A compact summary of what a diff does, for a human reading a plan. */
export function summariseDiff(diff: string): { added: number; removed: number; hunks: number } {
  const hunks = parseDiff(diff);
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }

  return { added, removed, hunks: hunks.length };
}

function toHunk(current: { header: RegExpExecArray; lines: string[] }): Hunk {
  const [, oldStart, oldLines, newStart, newLines] = current.header;

  return {
    oldStart: Number(oldStart),
    oldLines: oldLines === undefined ? 1 : Number(oldLines),
    newStart: Number(newStart),
    newLines: newLines === undefined ? 1 : Number(newLines),
    lines: current.lines,
  };
}

function trim(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
