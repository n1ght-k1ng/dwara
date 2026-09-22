import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DwaraError } from '../errors.js';
import { matchesHost } from '../policy/match.js';

/** One `Host` block, in the order it appeared. */
export interface SshHostBlock {
  /** The patterns on the `Host` line. */
  readonly patterns: readonly string[];
  /** Keyword/value pairs inside the block, keywords lowercased. */
  readonly settings: Readonly<Record<string, string>>;
  /** File the block came from, for error messages. */
  readonly source: string;
}

/** A parsed SSH config, including anything pulled in by `Include`. */
export interface SshConfig {
  readonly blocks: readonly SshHostBlock[];
  /**
   * Host aliases a user could actually connect to: the literal, wildcard-free
   * patterns. `Host *` sets defaults for everything and is not a host, so it
   * never appears here.
   */
  readonly hosts: readonly string[];
}

/** Settings that apply to one alias, after every matching block is considered. */
export interface ResolvedHost {
  readonly host: string;
  readonly hostname: string;
  readonly port: number | undefined;
  readonly user: string | undefined;
  readonly identityFile: string | undefined;
  readonly proxyJump: string | undefined;
}

const INTERESTING = new Set(['hostname', 'port', 'user', 'identityfile', 'proxyjump']);

function expandTilde(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Parses an SSH config file, following `Include` directives.
 *
 * Only the keywords Dwara needs are retained. The parser is deliberately
 * tolerant of the rest: a config it does not fully understand is normal, and
 * refusing to start over an unrecognised keyword would be worse than ignoring
 * it. What it must not do is *invent* a host, which is why only literal
 * patterns become aliases.
 *
 * @throws DwaraError `SSH_CONFIG_INVALID`
 */
export async function parseSshConfig(path: string): Promise<SshConfig> {
  const blocks: SshHostBlock[] = [];
  const visited = new Set<string>();

  await readInto(blocks, resolve(expandTilde(path)), visited, 0);

  const hosts: string[] = [];
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      // `!pattern` is a negation, never a connectable alias.
      if (/[*?!]/.test(pattern)) continue;
      if (!hosts.includes(pattern)) hosts.push(pattern);
    }
  }

  return { blocks, hosts };
}

async function readInto(
  blocks: SshHostBlock[],
  file: string,
  visited: Set<string>,
  depth: number,
): Promise<void> {
  // An Include cycle would otherwise recurse until the stack gives out.
  if (visited.has(file)) return;
  if (depth > 16) {
    throw new DwaraError('SSH_CONFIG_INVALID', `Include nesting is too deep at ${file}`, {
      details: { file },
    });
  }
  visited.add(file);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if (depth > 0) return; // A missing Include target is not an error for ssh.
    throw new DwaraError('SSH_CONFIG_INVALID', `cannot read SSH config at ${file}`, {
      details: { file },
      cause,
    });
  }

  let current: { patterns: string[]; settings: Record<string, string> } | undefined;

  const flush = (): void => {
    if (current) blocks.push({ ...current, source: file });
    current = undefined;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // ssh accepts `Keyword value` and `Keyword=value`.
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|\s)\s*(.+)$/.exec(line);
    if (!match) continue;

    const keyword = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (keyword === 'host') {
      flush();
      current = { patterns: splitValues(value), settings: {} };
      continue;
    }

    if (keyword === 'include') {
      for (const pattern of splitValues(value)) {
        await includeMatching(blocks, pattern, file, visited, depth);
      }
      continue;
    }

    // Anything outside a Host block applies globally; ssh treats it as `Host *`.
    if (!current) current = { patterns: ['*'], settings: {} };

    // ssh keeps the first value it sees for a keyword.
    if (INTERESTING.has(keyword) && !(keyword in current.settings)) {
      current.settings[keyword] = stripQuotes(value);
    }
  }

  flush();
}

async function includeMatching(
  blocks: SshHostBlock[],
  pattern: string,
  from: string,
  visited: Set<string>,
  depth: number,
): Promise<void> {
  // Relative Include paths resolve against ~/.ssh, not the current directory,
  // except inside a config that is itself somewhere else.
  const base = from.startsWith(resolve(homedir(), '.ssh'))
    ? resolve(homedir(), '.ssh')
    : dirname(from);
  const expanded = expandTilde(pattern);
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);

  if (!/[*?]/.test(absolute)) {
    await readInto(blocks, absolute, visited, depth + 1);
    return;
  }

  // Wildcards are resolved by reading the directory rather than with fs.glob,
  // which is still experimental and behaves differently across the Node
  // versions this repo supports. Only the final segment may be a wildcard,
  // which covers how Include is actually written (`Include conf.d/*`).
  const directory = dirname(absolute);
  const filePattern = absolute.slice(directory.length + 1);
  if (/[*?]/.test(directory)) return;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return; // An unmatchable Include glob is not an error for ssh either.
  }

  for (const entry of entries.sort()) {
    if (!matchesHost(filePattern, entry)) continue;
    await readInto(blocks, resolve(directory, entry), visited, depth + 1);
  }
}

function splitValues(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(stripQuotes)
    .filter((part) => part.length > 0);
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

/**
 * Resolves the settings that apply to one alias.
 *
 * Follows ssh's own rule: blocks are considered in file order and the first
 * value seen for a keyword wins, so an earlier specific block beats a later
 * `Host *`.
 */
export function resolveHost(config: SshConfig, host: string): ResolvedHost {
  const settings: Record<string, string> = {};

  for (const block of config.blocks) {
    if (!blockMatches(block, host)) continue;
    for (const [keyword, value] of Object.entries(block.settings)) {
      if (!(keyword in settings)) settings[keyword] = value;
    }
  }

  const port = settings['port'] === undefined ? undefined : Number(settings['port']);

  return {
    host,
    hostname: settings['hostname'] ?? host,
    port: port !== undefined && Number.isInteger(port) && port > 0 ? port : undefined,
    user: settings['user'],
    identityFile: settings['identityfile'],
    proxyJump: settings['proxyjump'],
  };
}

/** A block matches when a pattern matches and no negated pattern does. */
function blockMatches(block: SshHostBlock, host: string): boolean {
  let matched = false;
  for (const pattern of block.patterns) {
    if (pattern.startsWith('!')) {
      if (matchesHost(pattern.slice(1), host)) return false;
    } else if (matchesHost(pattern, host)) {
      matched = true;
    }
  }
  return matched;
}
