import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YAMLParseError } from 'yaml';
import type * as Yaml from 'yaml';

/**
 * The YAML parser's failure path, including what happens when it throws
 * something other than a `YAMLParseError`.
 *
 * These branches cannot be reached with real input — that is the point of
 * them — so the parser is stubbed. Leaving them untested would mean a policy
 * file could fail to load and produce a useless message at exactly the moment
 * an operator needs a good one.
 */

let thrown: unknown = null;

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof Yaml>();
  return {
    ...actual,
    parse: (...args: unknown[]) => {
      if (thrown !== null) throw thrown;
      return (actual.parse as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { parsePolicy } = await import('./load.js');

describe('policy loader, parser failures', () => {
  beforeEach(() => {
    thrown = null;
  });

  it('parses normally when the parser behaves', () => {
    expect(parsePolicy('version: 1\n').policy.version).toBe(1);
  });

  it('reports an unknown line when the parse error carries no position', () => {
    const error: YAMLParseError = Object.create(YAMLParseError.prototype) as YAMLParseError;
    Object.assign(error, { message: 'broken', linePos: undefined });
    thrown = error;

    expect(() => parsePolicy('version: 1\n', 'p.yaml')).toThrowError(
      /p\.yaml is not valid YAML at line \?/,
    );
  });

  it('handles a parser failure that is not a YAMLParseError', () => {
    thrown = new Error('parser exploded');

    try {
      parsePolicy('version: 1\n', 'p.yaml');
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as Error).message).toBe('p.yaml is not valid YAML');
      expect((err as { details: Record<string, unknown> }).details['detail']).toBe(
        'parser exploded',
      );
    }
  });

  it('handles a parser that throws a non-Error value', () => {
    thrown = 'just a string';

    try {
      parsePolicy('version: 1\n', 'p.yaml');
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as { details: Record<string, unknown> }).details['detail']).toBe('just a string');
    }
  });
});
