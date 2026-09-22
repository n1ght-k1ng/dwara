import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DwaraError } from '../errors.js';
import { Risk } from '../types.js';
import { loadPolicy, parsePolicy } from './load.js';

const MINIMAL = `
version: 1
defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]
hosts:
  - match: "lab-*"
`;

/** Asserts that loading throws, and hands back the error for further checks. */
function expectInvalid(text: string): DwaraError {
  try {
    parsePolicy(text, 'test.yaml');
  } catch (err) {
    expect(DwaraError.is(err)).toBe(true);
    return err as DwaraError;
  }
  throw new Error('expected the policy to be rejected');
}

describe('policy loader', () => {
  // Case 47
  it('hashes the raw bytes, not the parsed object', () => {
    const a = parsePolicy(MINIMAL);
    const b = parsePolicy(MINIMAL);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    // A comment changes nothing semantically but must change the hash: the
    // audit log pins the exact text that was in force.
    expect(parsePolicy(`# a comment\n${MINIMAL}`).hash).not.toBe(a.hash);
  });

  it('applies documented defaults for omitted sections', () => {
    const { policy } = parsePolicy('version: 1\n');

    expect(policy.limits).toEqual({ max_actions_per_session: 20, max_hosts_per_action: 1 });
    expect(policy.tools).toEqual({ never: [], overrides: {} });
    expect(policy.redaction).toEqual({ extra_patterns: [] });
    expect(policy.hosts).toEqual([]);
  });

  it('keeps risk lists as typed enums', () => {
    const { policy } = parsePolicy(MINIMAL);
    expect(policy.defaults.allow).toEqual([Risk.Read]);
    expect(policy.defaults.deny).toEqual([Risk.Destructive]);
  });

  // Case 41
  it('rejects an unknown top-level key', () => {
    const err = expectInvalid('version: 1\nreduction:\n  extra_patterns: []\n');
    expect(err.code).toBe('POLICY_INVALID');
    expect(String(err.details['problems'])).toContain('reduction');
  });

  // Case 41, nested
  it('rejects an unknown key inside a host rule and names its path', () => {
    const err = expectInvalid(
      'version: 1\nhosts:\n  - match: "lab-*"\n    requre_approval: [config]\n',
    );
    const problems = String(err.details['problems']);
    expect(problems).toContain('hosts.0');
    expect(problems).toContain('requre_approval');
  });

  // Case 42
  it.each([
    ['missing version', 'defaults:\n  allow: [read]\n'],
    ['wrong version', 'version: 2\n'],
  ])('rejects a policy with a %s', (_label, text) => {
    expect(expectInvalid(text).code).toBe('POLICY_INVALID');
  });

  // Case 43
  it('rejects an unknown risk name and lists the valid ones', () => {
    const err = expectInvalid('version: 1\ndefaults:\n  allow: [read, sideways]\n');
    const problems = String(err.details['problems']);
    expect(problems).toContain('defaults.allow.1');
    expect(problems).toContain('read, reversible, config, destructive');
  });

  // Case 44
  it.each([
    ['empty', '""'],
    ['whitespace-padded', '" lab-* "'],
  ])('rejects a %s host pattern', (_label, pattern) => {
    expect(expectInvalid(`version: 1\nhosts:\n  - match: ${pattern}\n`).code).toBe(
      'POLICY_INVALID',
    );
  });

  // Case 45
  it('rejects duplicate host patterns instead of silently picking one', () => {
    const err = expectInvalid('version: 1\nhosts:\n  - match: "lab-*"\n  - match: "lab-*"\n');
    const problems = String(err.details['problems']);
    expect(problems).toContain('hosts.1.match');
    expect(problems).toContain('duplicate host pattern');
  });

  // Case 46
  it('rejects malformed YAML with the line number', () => {
    const err = expectInvalid('version: 1\nhosts:\n  - match: "unterminated\n');
    expect(err.code).toBe('POLICY_INVALID');
    expect(err.message).toMatch(/not valid YAML at line \d+/);
  });

  it('rejects a document that is not a mapping', () => {
    expect(expectInvalid('- version: 1\n').code).toBe('POLICY_INVALID');
  });

  it('rejects a tool override with an unknown action', () => {
    const err = expectInvalid(
      'version: 1\ntools:\n  overrides:\n    prune_images: { allow_everywhere: true }\n',
    );
    expect(String(err.details['problems'])).toContain('allow_everywhere');
  });

  it('rejects non-positive limits', () => {
    expect(expectInvalid('version: 1\nlimits:\n  max_actions_per_session: 0\n').code).toBe(
      'POLICY_INVALID',
    );
  });
});

describe('policy loader, on disk', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwara-policy-'));
    await writeFile(join(dir, 'policy.yaml'), MINIMAL, 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a policy from a path', async () => {
    const loaded = await loadPolicy(join(dir, 'policy.yaml'));
    expect(loaded.policy.hosts[0]?.match).toBe('lab-*');
    expect(loaded.path).toBe(join(dir, 'policy.yaml'));
  });

  // Case 48
  it('reports a missing policy file with a usable hint', async () => {
    await expect(loadPolicy(join(dir, 'absent.yaml'))).rejects.toMatchObject({
      code: 'POLICY_NOT_FOUND',
    });

    await loadPolicy(join(dir, 'absent.yaml')).catch((err: DwaraError) => {
      expect(err.hint).toContain('dwara init');
    });
  });
});
