import { DwaraError } from '../errors.js';

/**
 * Turning an argv array into something a remote login shell will take apart
 * again into exactly the same array.
 *
 * `ssh host cmd args...` does not pass an argv vector to the far end. It joins
 * everything with spaces and hands the result to the remote login shell, which
 * parses it as shell source. So every element has to be quoted individually
 * before it ever becomes part of that string — which is why `RemoteCommand`
 * carries `argv` and never a command line.
 */

/**
 * Characters that may never appear in an argument.
 *
 * eslint's no-control-regex guards against control characters landing in a
 * pattern by accident. Matching them is this pattern's entire purpose.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f]/u;

/**
 * Characters that are safe to leave bare. Everything outside this set gets
 * quoted, which keeps ordinary commands readable in the audit log while making
 * no assumptions about the rest.
 */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function describeByte(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 'NUL';
  return `0x${code.toString(16).padStart(2, '0')}`;
}

/**
 * Rejects an argument that could not survive the round trip intact.
 *
 * NUL cannot be carried through a C string at all. The other C0 controls and
 * DEL are refused because they are invisible in every log, diff and audit entry
 * a human will later read to work out what ran — and nothing legitimate needs
 * them: content with newlines goes over stdin, not argv.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT`
 */
export function assertSafeArg(arg: string, position: number): void {
  const match = FORBIDDEN.exec(arg);
  if (match) {
    throw new DwaraError(
      'UNSAFE_ARGUMENT',
      `argument ${position} contains a control character (${describeByte(match[0])}), which Dwara refuses to send`,
      {
        details: { position, byte: describeByte(match[0]) },
        hint: 'pass content containing newlines or control characters over stdin instead of as an argument',
      },
    );
  }
}

/**
 * Quotes one argument for a POSIX shell.
 *
 * Single quotes suppress every form of expansion a shell performs, so the only
 * character needing care is the single quote itself: the string is closed,
 * an escaped quote is emitted, and the string reopens.
 *
 * Dwara does not use `shell-quote`'s `quote()` for this, despite that library
 * being the repo's choice elsewhere. `quote()` targets an interactive bash and
 * emits `\!` inside double quotes to defeat history expansion. A
 * non-interactive shell — which is what `ssh host cmd` runs — does not treat
 * `\!` as an escape inside double quotes, so any argument containing `!` comes
 * back with a literal backslash in it. The property test in this directory
 * catches it. `shell-quote` is still the right tool for *parsing* commands in
 * the PreToolUse hook, which is what Phase 4 uses it for.
 */
function quoteOne(arg: string): string {
  if (arg === '') return "''";
  if (BARE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes an argv array into a single string safe for a remote shell.
 *
 * Every element is quoted separately, so a value that came from the model — a
 * unit name, a grep pattern, a path — cannot end the current word and start a
 * new command. This is the one function standing between a tool argument and
 * shell syntax; `CLAUDE.md` forbids building remote commands any other way.
 *
 * @throws DwaraError `UNSAFE_ARGUMENT` if any element holds a control character
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new DwaraError('UNSAFE_ARGUMENT', 'a remote command needs at least one argument');
  }

  argv.forEach((arg, index) => {
    assertSafeArg(arg, index);
  });

  return argv.map(quoteOne).join(' ');
}
