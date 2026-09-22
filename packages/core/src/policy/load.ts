import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { DwaraError } from '../errors.js';
import { policySchema, type Policy } from './schema.js';

/** A loaded policy, with the hash that every audit entry records. */
export interface LoadedPolicy {
  readonly policy: Policy;
  /** SHA-256 of the file's raw bytes. */
  readonly hash: string;
  /** Absolute path the policy was read from. */
  readonly path: string;
}

/** Where `dwara init` writes the policy, relative to the project root. */
export const DEFAULT_POLICY_PATH = '.dwara/policy.yaml';

/**
 * Reads, parses and validates a policy file.
 *
 * The hash is taken over the raw bytes rather than the parsed object: it has to
 * change whenever the file changes, so that an audit entry pins the exact text
 * that was in force, comments and all.
 *
 * @throws DwaraError `POLICY_NOT_FOUND` or `POLICY_INVALID`
 */
export async function loadPolicy(path: string = DEFAULT_POLICY_PATH): Promise<LoadedPolicy> {
  const absolute = resolve(path);

  let raw: Buffer;
  try {
    raw = await readFile(absolute);
  } catch (cause) {
    throw new DwaraError('POLICY_NOT_FOUND', `no policy file at ${absolute}`, {
      details: { path: absolute },
      hint: 'run `dwara init` to create one, or pass --policy <path>',
      cause,
    });
  }

  return parsePolicy(raw.toString('utf8'), absolute);
}

/**
 * Validates policy text that has already been read.
 *
 * Exposed separately so callers that hold the text — tests, `dwara init`'s
 * preview — can validate without touching the filesystem.
 *
 * @throws DwaraError `POLICY_INVALID`
 */
export function parsePolicy(text: string, path = '<inline>'): LoadedPolicy {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (cause) {
    const where =
      cause instanceof YAMLParseError ? ` at line ${cause.linePos?.[0]?.line ?? '?'}` : '';
    throw new DwaraError('POLICY_INVALID', `${path} is not valid YAML${where}`, {
      details: { path, detail: cause instanceof Error ? cause.message : String(cause) },
      cause,
    });
  }

  const parsed = policySchema.safeParse(document);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    });

    throw new DwaraError('POLICY_INVALID', `${path} is not a valid policy`, {
      details: { path, problems },
      hint: problems.join('\n'),
    });
  }

  return {
    policy: parsed.data,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    path,
  };
}
