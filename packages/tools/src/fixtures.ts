import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawResult } from '@dwara/core';

/**
 * Loads captured host output for the parser tests.
 *
 * Fixtures are real command output from the testbed, so a parser is measured
 * against what a host actually emits rather than against something written to
 * suit the parser. See `fixtures/README.md`.
 */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.txt`, import.meta.url)), 'utf8');
}

/** Wraps fixture text as a `RawResult`, as the transport would deliver it. */
export function asResult(stdout: string, over: Partial<RawResult> = {}): RawResult {
  return {
    argv: [],
    exitCode: 0,
    stdout,
    stderr: '',
    truncated: false,
    durationMs: 1,
    ...over,
  };
}

/** Several fixtures as the sequence of results a tool's commands would produce. */
export function asResults(names: readonly (string | RawResult)[]): RawResult[] {
  return names.map((name) => (typeof name === 'string' ? asResult(fixture(name)) : name));
}
