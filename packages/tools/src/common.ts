import { z } from 'zod';
import type { RawResult } from '@dwara/core';

/**
 * Shared pieces for tool definitions.
 *
 * The parsers here are written against the fixtures in `./fixtures`, captured
 * from real hosts. Every one of them has to survive empty input: a host that
 * returns nothing is a real answer — `docker ps` says nothing while a container
 * is between restarts, and `systemctl list-units --state=failed` says nothing
 * when the host is healthy.
 */

/** Every tool takes a host, and it is always a managed alias. */
export const hostField = z
  .string()
  .min(1)
  .describe('Host alias from your SSH config. Must be one Dwara manages.');

/** Standard timeout for a read command. */
export const READ_TIMEOUT_MS = 20_000;

/** Non-empty lines, trimmed of the trailing newline only. */
export function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** `key=value` output, as `systemctl show` produces. */
export function keyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

/** Tab-separated rows, as `--format "{{.A}}\t{{.B}}"` produces. */
export function tabRows(text: string): string[][] {
  return lines(text).map((line) => line.split('\t'));
}

/** Whitespace-separated columns, as `df` and `ss` produce. */
export function columns(text: string, limit?: number): string[][] {
  return lines(text).map((line) =>
    limit === undefined ? line.trim().split(/\s+/) : splitN(line.trim(), limit),
  );
}

/** Splits on whitespace into at most `limit` parts, keeping the remainder whole. */
function splitN(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (parts.length < limit - 1) {
    const match = /\s+/.exec(rest);
    if (!match) break;
    parts.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  parts.push(rest);
  return parts;
}

/** A finite number, or undefined. Never NaN, which would reach the model as null. */
export function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The nth result, or a blank one. Keeps parsers free of index assertions. */
export function at(raws: readonly RawResult[], index: number): RawResult {
  return (
    raws[index] ?? {
      argv: [],
      exitCode: -1,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }
  );
}

/** Marks a result the host could not produce, so the model is not told "0". */
export interface Unavailable {
  readonly available: false;
  readonly reason: string;
}

/**
 * Reports a failed command as explicitly unavailable.
 *
 * A read tool that silently returns an empty list when a command was refused
 * tells the model the host is fine. Saying "this could not be read, and why" is
 * the difference between a diagnosis and a wrong conclusion.
 */
export function unavailable(raw: RawResult): Unavailable | undefined {
  if (raw.exitCode === 0) return undefined;

  const reason = raw.stderr.trim() || raw.stdout.trim() || `command exited ${raw.exitCode}`;
  return { available: false, reason: reason.split('\n')[0]!.slice(0, 200) };
}
