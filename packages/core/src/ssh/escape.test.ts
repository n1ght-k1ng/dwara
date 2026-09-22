import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertSafeArg, quoteArgv } from './escape.js';

/**
 * Restated here rather than imported from the implementation: an oracle that
 * shares the implementation's own constant cannot catch a mistake in it.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/**
 * Escaping is the one place where a value the model supplied meets shell
 * syntax, so it is checked against a real shell rather than against
 * `shell-quote`'s own parser — round-tripping a library through itself proves
 * only that it is self-consistent.
 *
 * A subprocess per case would cap the sample at a few hundred, so a whole batch
 * becomes one script of `printf '%s\0' <quoted>` lines, run once, with stdout
 * split on NUL. NUL is a safe delimiter precisely because `quoteArgv` refuses
 * any argument containing one.
 */
function roundTripThroughShell(args: readonly string[]): string[] {
  const script = args.map((arg) => `printf '%s\\0' ${quoteArgv([arg])}`).join('\n');
  const stdout = execFileSync('/bin/sh', ['-c', script], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });

  const parts = stdout.toString('utf8').split('\0');
  // A trailing empty element is the tail after the final delimiter.
  parts.pop();
  return parts;
}

describe('assertSafeArg', () => {
  it.each([
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['tab', 'a\tb'],
    ['carriage return', 'a\rb'],
    ['escape', 'a\u001bb'],
    ['DEL', 'a\u007fb'],
  ])('rejects an argument containing a %s', (_label, arg) => {
    expect(() => assertSafeArg(arg, 0)).toThrowError(/control character/);
  });

  it('names the position and the byte, and says what to do instead', () => {
    try {
      assertSafeArg('x\u0000', 3);
      throw new Error('expected a rejection');
    } catch (err) {
      const error = err as { code: string; details: Record<string, unknown>; hint?: string };
      expect(error.code).toBe('UNSAFE_ARGUMENT');
      expect(error.details['position']).toBe(3);
      expect(error.details['byte']).toBe('NUL');
      expect(error.hint).toContain('stdin');
    }
  });

  it.each(['plain', 'with space', 'héllo', '日本語', '--flag=value', "it's", '$(whoami)'])(
    'accepts %j',
    (arg) => {
      expect(() => assertSafeArg(arg, 0)).not.toThrow();
    },
  );
});

describe('quoteArgv', () => {
  it('requires at least one element', () => {
    expect(() => quoteArgv([])).toThrowError(/at least one argument/);
  });

  it('leaves a simple command readable', () => {
    expect(quoteArgv(['systemctl', 'is-active', 'nginx'])).toBe('systemctl is-active nginx');
  });

  it.each([
    ['command substitution', '$(id)'],
    ['backticks', '`id`'],
    ['a command separator', 'a; id'],
    ['a pipe', 'a | id'],
    ['an ampersand', 'a && id'],
    ['a redirect', 'a > /etc/passwd'],
    ['a newline-free glob', '/etc/*'],
    ['a variable', '$HOME'],
    ['a quote', 'it\'s "quoted"'],
  ])('neutralises %s', (_label, arg) => {
    // The shell must hand back exactly the bytes we sent, having executed
    // nothing extra.
    expect(roundTripThroughShell([arg])).toEqual([arg]);
  });

  it.each(['a!b', 'ERROR!', ")!'|*&&>", '!!', 'a!b!c'])(
    'round-trips %j, which shell-quote would corrupt',
    (arg) => {
      // Regression: shell-quote's quote() emits \! inside double quotes to
      // defeat bash history expansion. A non-interactive shell does not treat
      // that as an escape, so the argument came back with a literal backslash.
      expect(roundTripThroughShell([arg])).toEqual([arg]);
      expect(quoteArgv([arg])).not.toContain('\\!');
    },
  );

  it('does not let one argument bleed into the next', () => {
    const args = ['first', '; touch /tmp/dwara-should-not-exist', 'third'];
    expect(roundTripThroughShell(args)).toEqual(args);
  });

  it('survives 10,000 generated arguments through a real shell', () => {
    // Printable characters plus the ones that mean something to a shell, drawn
    // deliberately often so quoting is exercised rather than merely present.
    const nasty = fc.stringMatching(/^[\x20-\x7e]{0,24}$/);
    const shellish = fc
      .array(fc.constantFrom(...'$`"\'\\ ;|&<>(){}[]*?!#~\n\t'.replace(/[\n\t]/g, '')), {
        maxLength: 12,
      })
      .map((chars) => chars.join(''));
    // eslint-disable-next-line no-control-regex -- matching controls is the point
    const CONTROL = /[\u0000-\u001f\u007f]/u;
    const unicode = fc.string({ maxLength: 24 }).filter((s) => !CONTROL.test(s));

    const samples: string[] = [];
    fc.assert(
      fc.property(fc.oneof(nasty, shellish, unicode), (arg) => {
        samples.push(arg);
        return true;
      }),
      { numRuns: 10_000 },
    );

    expect(samples.length).toBeGreaterThanOrEqual(10_000);

    // One shell invocation for the whole batch.
    for (let i = 0; i < samples.length; i += 2000) {
      const batch = samples.slice(i, i + 2000);
      expect(roundTripThroughShell(batch)).toEqual(batch);
    }
  });

  it('never emits a control character, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string(), (arg) => {
        let quoted: string;
        try {
          quoted = quoteArgv([arg]);
        } catch {
          // Rejected outright, which is the other acceptable outcome.
          return CONTROL_CHARS.test(arg);
        }
        return !CONTROL_CHARS.test(quoted);
      }),
      { numRuns: 2000 },
    );
  });
});
