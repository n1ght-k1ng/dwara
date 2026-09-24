import { findEntropySecrets } from './entropy.js';
import { RULES, type RedactionRule } from './patterns.js';

/** What a redaction pass found and removed. */
export interface RedactionReport {
  readonly text: string;
  /** How many spans were replaced, by rule name. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface RedactorOptions {
  /** Extra patterns from `policy.redaction.extra_patterns`. */
  readonly extraPatterns?: readonly string[];
}

/** A span to replace, resolved from a rule match. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/**
 * Removes credential material from text before it reaches the model.
 *
 * Every tool's output passes through here (CLAUDE.md rule 6), along with
 * stderr and error messages — a connection failure that echoes a URL is as
 * much of a leak as a config file.
 *
 * Replacement is `[REDACTED:<type>]`, keeping the type so a diagnosis can
 * still tell "the config has a password here" from "the config is empty",
 * which is often the fact that matters.
 */
export class Redactor {
  private readonly rules: readonly RedactionRule[];

  constructor(options: RedactorOptions = {}) {
    const extra = (options.extraPatterns ?? []).map((source): RedactionRule => ({
      name: 'policy-pattern',
      pattern: compile(source),
    }));
    // Policy patterns run first: an operator who added one knows something
    // about their environment that these built-ins do not.
    this.rules = [...extra, ...RULES];
  }

  /** Redacts text, returning the result and what was removed. */
  redact(text: string): RedactionReport {
    if (text === '') return { text, counts: {}, total: 0 };

    const spans: Span[] = [];

    for (const rule of this.rules) {
      // Each rule gets a fresh regex: a shared /g regex carries lastIndex
      // between calls and would skip matches on the next input.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const span = resolveSpan(match, rule);
        if (span) spans.push({ ...span, name: rule.name });

        // A zero-length match would loop forever.
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
    }

    // Entropy is the fallback. Where a named rule already covers a region, its
    // span wins: `PASSWORD=[REDACTED:secret-assignment]` tells a diagnosis more
    // than `[REDACTED:high-entropy]`, which loses the key name entirely.
    for (const line of splitLines(text)) {
      for (const finding of findEntropySecrets(line.text)) {
        const start = line.offset + finding.start;
        const end = line.offset + finding.end;
        if (spans.some((span) => start < span.end && end > span.start)) continue;
        spans.push({ start, end, name: 'high-entropy' });
      }
    }

    return apply(text, spans);
  }

  /** Redacts every string in a structure, leaving its shape intact. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value).text as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = this.redactDeep(item);
      return out as T;
    }
    return value;
  }
}

/** Turns a match into the span to replace, honouring the rule's capture group. */
function resolveSpan(
  match: RegExpExecArray,
  rule: RedactionRule,
): { start: number; end: number } | undefined {
  const group = rule.group ?? 0;
  if (group === 0) {
    return match[0].length > 0
      ? { start: match.index, end: match.index + match[0].length }
      : undefined;
  }

  const captured = match[group];
  if (captured === undefined || captured.length === 0) return undefined;

  // A capture group's offset is not reported, so it is located inside the
  // match. The secret is the part worth hiding; the surrounding key is the
  // part worth keeping.
  const offset = match[0].lastIndexOf(captured);
  if (offset < 0) return undefined;

  return { start: match.index + offset, end: match.index + offset + captured.length };
}

/**
 * Replaces spans, merging overlaps.
 *
 * Rules are deliberately allowed to overlap — a URL password may also match
 * the generic assignment rule — so the earliest-starting, longest span wins and
 * anything inside it is absorbed rather than producing nested markers.
 */
function apply(text: string, spans: readonly Span[]): RedactionReport {
  if (spans.length === 0) return { text, counts: {}, total: 0 };

  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: span.end, name: last.name };
      }
      continue;
    }
    merged.push(span);
  }

  const counts: Record<string, number> = {};
  let out = '';
  let cursor = 0;

  for (const span of merged) {
    out += text.slice(cursor, span.start);
    out += `[REDACTED:${span.name}]`;
    counts[span.name] = (counts[span.name] ?? 0) + 1;
    cursor = span.end;
  }
  out += text.slice(cursor);

  return { text: out, counts, total: merged.length };
}

/** Lines with their offsets, so entropy findings map back to the whole text. */
function splitLines(text: string): { text: string; offset: number }[] {
  const lines: { text: string; offset: number }[] = [];
  let offset = 0;

  for (const line of text.split('\n')) {
    lines.push({ text: line, offset });
    offset += line.length + 1;
  }
  return lines;
}

/** Compiles a policy pattern, ignoring one that will not compile. */
function compile(source: string): RegExp {
  try {
    return new RegExp(source, 'g');
  } catch {
    // A broken pattern in a policy file must not stop redaction entirely; the
    // built-in rules still apply. `dwara doctor` is where a user finds out.
    return /(?!)/g;
  }
}

/** A redactor with the built-in rules only. */
export const defaultRedactor = new Redactor();
