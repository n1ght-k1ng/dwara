import { parse } from 'shell-quote';

/**
 * Deciding whether a shell command reaches a managed host.
 *
 * Written against `shell-quote`'s measured output, not its documentation. The
 * shapes that matter, each confirmed by running the parser:
 *
 * - `ssh $HOST` -> `['ssh', '']`. A variable becomes an **empty string**, so the
 *   host vanishes rather than surviving as something recognisable.
 * - `` `ssh lab-api` `` -> ``['`ssh', 'lab-api']``. Backticks are not
 *   interpreted; the verb arrives with one stuck to the front.
 * - `$(ssh lab-api x)` -> `['$', {op:'('}, 'ssh', 'lab-api', 'x', {op:')'}]`.
 *   Substitutions are flattened into ordinary tokens, which is convenient.
 * - `ssh *-api` -> `['ssh', {op:'glob', pattern:'*-api'}]`. Globs come back
 *   unresolved.
 * - `ssh lab-api"` -> `['ssh', 'lab-api']`. Unbalanced quotes **do not throw**,
 *   so a parse failure cannot be relied on to catch malformed input.
 *
 * The result is three answers rather than two. `unreadable` is not a hedge: it
 * is the honest outcome when a command could reach a managed host and the hook
 * cannot tell, and it is reported as such rather than dressed up as a match.
 */

export type Verdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly verb: string; readonly host: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Programs that reach another machine. */
const REMOTE_VERBS = new Set(['ssh', 'slogin', 'scp', 'sftp', 'rsync', 'mosh']);

/** Verbs whose host argument carries a `host:path` rather than a bare host. */
const PATH_VERBS = new Set(['scp', 'sftp', 'rsync']);

/** Shells that take a command as a string argument. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/**
 * Programs that run another program, which the walker steps past.
 *
 * The number is how many of their own arguments to skip before the real
 * command begins: `timeout 5 ssh …` hides the verb one argument deep.
 */
const WRAPPERS = new Map([
  ['sudo', 0],
  ['doas', 0],
  ['env', 0],
  ['command', 0],
  ['builtin', 0],
  ['exec', 0],
  ['nohup', 0],
  ['stdbuf', 0],
  ['timeout', 1],
  ['nice', 0],
  ['ionice', 0],
]);

/** `ssh` options that take a value, so the value is not mistaken for the host. */
const SSH_OPTS_WITH_VALUE = new Set([
  '-o',
  '-i',
  '-p',
  '-l',
  '-J',
  '-F',
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-I',
  '-L',
  '-m',
  '-O',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
]);

/** Operators that end one command and begin another. */
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '{', '}']);

/** A shell variable reference, in either form. */
const VARIABLE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

/** True when the raw text runs one of the remote-access programs. */
function namesRemoteVerb(command: string): boolean {
  return [...REMOTE_VERBS].some((verb) =>
    new RegExp(`(^|[\\s;&|(\`'"/])${verb}(\\s|$)`).test(command),
  );
}

/** A token the parser would not resolve, standing where a value should be. */
const UNKNOWN = Symbol('unknown');
type Token = string | typeof UNKNOWN;

/**
 * Decides what a command does about managed hosts.
 *
 * With no managed hosts, every command is allowed: Dwara governs nothing here,
 * and a hook that blocked anyway would make the plugin unusable in every
 * project that does not use it.
 */
export function inspect(command: string, managed: readonly string[]): Verdict {
  if (managed.length === 0) return { kind: 'allow' };

  const hosts = new Set(managed);
  return walk(command, hosts, 0);
}

/** Recurses into nested shells. The depth bound stops a crafted loop. */
function walk(command: string, hosts: ReadonlySet<string>, depth: number): Verdict {
  if (depth > 8) {
    return { kind: 'unreadable', reason: 'nested too deeply to read with confidence' };
  }

  // Checked against the raw text, before the parser gets a chance to erase it.
  // `bash -c "ssh $H"` parses to ['bash','-c','ssh '] -- the variable is gone
  // and so is any trace that there was one, so by the time the tokens exist
  // there is nothing left to be suspicious of.
  if (VARIABLE.test(command) && namesRemoteVerb(command)) {
    return {
      kind: 'unreadable',
      reason: 'the destination comes from a variable, which this hook cannot read',
    };
  }

  // Command substitutions, read from the raw text before parsing.
  //
  // Two shapes need this. Inside double quotes the parser does NOT flatten
  // `$(...)`: `echo "$(ssh lab-api x)"` comes back as a single literal token,
  // so the inner command never becomes tokens of its own. And backticks are
  // never interpreted at all, so `` echo `ssh lab-api x` `` splits across
  // three tokens with the verb wearing a stray backtick.
  for (const inner of substitutions(command)) {
    const verdict = walk(inner, hosts, depth + 1);
    if (verdict.kind !== 'allow') return verdict;
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(command);
  } catch {
    // Not expected -- the parser swallows unbalanced quotes rather than
    // throwing -- but a crash here must never become an allow.
    return mentionsHost(command, hosts)
      ? { kind: 'unreadable', reason: 'could not be parsed, and names a managed host' }
      : { kind: 'allow' };
  }

  for (const segment of segments(parsed)) {
    const verdict = inspectSegment(segment, hosts, depth, command);
    if (verdict.kind !== 'allow') return verdict;
  }

  return { kind: 'allow' };
}

/**
 * The contents of every `$(...)` and `` `...` `` in a command.
 *
 * Nesting is counted for `$(...)` so that `$(echo $(ssh lab-api))` yields the
 * whole inner command rather than stopping at the first closing bracket.
 */
function substitutions(command: string): string[] {
  const found: string[] = [];

  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 1;
      const start = i + 2;
      let j = start;
      for (; j < command.length && depth > 0; j += 1) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
      }
      if (depth === 0) found.push(command.slice(start, j - 1));
      i = j - 1;
      continue;
    }

    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1) break;
      found.push(command.slice(i + 1, end));
      i = end;
    }
  }

  return found;
}

/** Splits a parsed command on operators into individual commands. */
function segments(parsed: ReturnType<typeof parse>): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];

  for (const entry of parsed) {
    if (typeof entry === 'string') {
      current.push(stripBackticks(entry));
      continue;
    }

    const op = (entry as { op?: string }).op;
    if (op === 'glob') {
      // An unresolved pattern. It occupies an argument position, and what it
      // would expand to is not knowable here.
      current.push(UNKNOWN);
      continue;
    }
    if (op !== undefined && SEPARATORS.has(op)) {
      if (current.length > 0) out.push(current);
      current = [];
      continue;
    }
    current.push(UNKNOWN);
  }

  if (current.length > 0) out.push(current);
  return out;
}

function inspectSegment(
  tokens: Token[],
  hosts: ReadonlySet<string>,
  depth: number,
  original: string,
): Verdict {
  const index = skipPrefixes(tokens);
  if (index >= tokens.length) return { kind: 'allow' };

  const head = tokens[index];
  if (head === undefined) return { kind: 'allow' };
  if (head === UNKNOWN) {
    return mentionsHost(original, hosts)
      ? { kind: 'unreadable', reason: 'the program being run could not be read' }
      : { kind: 'allow' };
  }

  const verb = basename(head);

  // A shell given a command as a string: read that string as a command too.
  if (SHELLS.has(verb)) {
    const flag = tokens.indexOf('-c', index);
    if (flag === -1) return { kind: 'allow' };

    const inner = tokens[flag + 1];
    if (inner === undefined) return { kind: 'allow' };
    if (inner === UNKNOWN || inner === '') {
      return { kind: 'unreadable', reason: `${verb} -c was given a command this hook cannot read` };
    }
    return walk(inner, hosts, depth + 1);
  }

  if (verb === 'eval') {
    const rest = tokens.slice(index + 1);
    if (rest.some((token) => token === UNKNOWN || token === '')) {
      // An eval of something the parser erased is a general-purpose command
      // runner with unknowable contents. That is a different thing from a
      // script file, which an operator wrote deliberately and which this hook
      // does not try to read.
      return { kind: 'unreadable', reason: 'eval was given a command this hook cannot read' };
    }
    return walk(rest.join(' '), hosts, depth + 1);
  }

  if (verb === 'xargs') {
    return inspectXargs(tokens.slice(index + 1), hosts);
  }

  if (!REMOTE_VERBS.has(verb)) return { kind: 'allow' };

  return inspectRemote(verb, tokens.slice(index + 1), hosts);
}

/**
 * `xargs ssh` takes its hosts from stdin.
 *
 * There is nothing in the command to match against, so if the program it would
 * run reaches other machines, this cannot be cleared.
 */
function inspectXargs(rest: Token[], hosts: ReadonlySet<string>): Verdict {
  for (const token of rest) {
    if (token === UNKNOWN) continue;
    if (token.startsWith('-')) continue;

    const verb = basename(token);
    if (!REMOTE_VERBS.has(verb)) return { kind: 'allow' };

    // A literal host alongside xargs is still worth catching.
    const named = [...hosts].find((host) => rest.includes(host));
    return named === undefined
      ? {
          kind: 'unreadable',
          reason: `xargs would run ${verb} with hosts read from input, which this hook cannot see`,
        }
      : { kind: 'deny', verb, host: named };
  }

  return { kind: 'allow' };
}

/** Finds the host a remote-access command is aimed at. */
function inspectRemote(verb: string, args: Token[], hosts: ReadonlySet<string>): Verdict {
  const unresolved = args.some((token) => token === UNKNOWN);

  if (PATH_VERBS.has(verb)) {
    for (const token of args) {
      if (token === UNKNOWN) continue;
      const colon = token.indexOf(':');
      if (colon <= 0) continue;
      const host = stripUser(token.slice(0, colon));
      if (hosts.has(host)) return { kind: 'deny', verb, host };
    }

    if (unresolved) {
      return {
        kind: 'unreadable',
        reason: `${verb} was given a destination this hook cannot read`,
      };
    }
    // No `host:path` anywhere, so fall through: `sftp lab-api` names a bare
    // host exactly as ssh does.
  }

  // ssh-like: the first thing that is not an option or an option's value.
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === UNKNOWN) {
      return {
        kind: 'unreadable',
        reason: `${verb} was given a destination this hook cannot read`,
      };
    }
    if (token === undefined) break;

    if (token.startsWith('-')) {
      if (SSH_OPTS_WITH_VALUE.has(token)) i += 1;
      continue;
    }

    if (token === '') {
      // A variable the parser erased. The destination is unknowable, and this
      // is the single most likely way an agent reaches a host by accident.
      return {
        kind: 'unreadable',
        reason: `${verb} was given a destination from a variable, which this hook cannot read`,
      };
    }

    if (token.includes('$')) {
      // `ssh lab-$(echo api)` leaves the parser with a partial host.
      return {
        kind: 'unreadable',
        reason: `${verb} was given a destination built by substitution, which this hook cannot read`,
      };
    }

    const host = stripUser(token);
    if (hosts.has(host)) return { kind: 'deny', verb, host };

    // A host that is not managed. Nothing further in this command is a
    // destination, so there is nothing left to check.
    return { kind: 'allow' };
  }

  return unresolved
    ? { kind: 'unreadable', reason: `${verb} was given a destination this hook cannot read` }
    : { kind: 'allow' };
}

/** Steps past `VAR=value` prefixes and wrapper programs. */
function skipPrefixes(tokens: Token[]): number {
  let index = 0;

  for (;;) {
    const token = tokens[index];
    if (token === undefined || token === UNKNOWN) return index;

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }

    const skip = WRAPPERS.get(basename(token));
    if (skip === undefined) return index;

    index += 1 + skip;
    // `nice -n 10 ssh` and friends: step over flags and their values too.
    while (typeof tokens[index] === 'string' && (tokens[index] as string).startsWith('-')) {
      index += 2;
    }
  }
}

/** True when the raw text names a managed host anywhere in it. */
function mentionsHost(command: string, hosts: ReadonlySet<string>): boolean {
  return [...hosts].some((host) => command.includes(host));
}

/**
 * Backticks are not interpreted by the parser, so they arrive stuck to the
 * tokens either side of the substitution.
 */
function stripBackticks(token: string): string {
  return token.replace(/^`+/, '').replace(/`+$/, '');
}

function basename(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

function stripUser(target: string): string {
  const at = target.lastIndexOf('@');
  return at === -1 ? target : target.slice(at + 1);
}
