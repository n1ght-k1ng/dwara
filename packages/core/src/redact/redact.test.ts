import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Redactor, defaultRedactor } from './redact.js';
import { looksLikeSecret, shannonEntropy } from './entropy.js';

/**
 * The corpus is the specification. It was written before the redactor so the
 * rules are measured against cases rather than tuned to them.
 *
 * Two budgets, from DESIGN section 12: **zero leaks** on the positives, and
 * **under 2% false positives** on the negatives.
 */
function loadCorpus(name: string): string[] {
  const path = fileURLToPath(new URL(`./corpus/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * A positive case: the line as a host would emit it, plus the exact substrings
 * that must not survive.
 *
 * The corpus marks the secret with ⟦ ⟧ rather than leaving the test to guess
 * which words on the line were credential material. Guessing produced both
 * false alarms (flagging the word `refresh_token`) and missed leaks.
 */
interface SecretCase {
  readonly input: string;
  readonly secrets: readonly string[];
}

function parseSecretLine(line: string): SecretCase {
  const secrets = [...line.matchAll(/⟦([^⟧]*)⟧/g)].map((match) => match[1]!);
  return { input: line.replaceAll('⟦', '').replaceAll('⟧', ''), secrets };
}

const SECRETS = loadCorpus('secrets.txt').map(parseSecretLine);
const CLEAN = loadCorpus('clean.txt');

describe('redactor corpus', () => {
  it('has a corpus of the size DESIGN requires', () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(100);
    expect(CLEAN.length).toBeGreaterThanOrEqual(100);
  });

  it('every positive case marks what must not survive', () => {
    const unmarked = SECRETS.filter((testCase) => testCase.secrets.length === 0);
    expect(unmarked.map((c) => c.input)).toEqual([]);
  });

  it('leaks no secret from the positive corpus', () => {
    const leaks: string[] = [];

    for (const { input, secrets } of SECRETS) {
      const redacted = defaultRedactor.redact(input).text;
      for (const secret of secrets) {
        if (redacted.includes(secret)) leaks.push(`${secret}\n    in: ${input.slice(0, 100)}`);
      }
    }

    expect(leaks, `leaked ${leaks.length} secret(s):\n  ${leaks.join('\n  ')}`).toEqual([]);
  });

  it('keeps false positives under 2% of the negative corpus', () => {
    const altered = CLEAN.filter((line) => defaultRedactor.redact(line).text !== line);
    const rate = altered.length / CLEAN.length;

    expect(
      rate,
      `${altered.length}/${CLEAN.length} altered (${(rate * 100).toFixed(1)}%):\n${altered
        .map(
          (line) =>
            `  ${line.slice(0, 100)}\n    -> ${defaultRedactor.redact(line).text.slice(0, 100)}`,
        )
        .join('\n')}`,
    ).toBeLessThan(0.02);
  });
});

describe('redactor behaviour', () => {
  it('keeps the surrounding context and names the type', () => {
    // "the config has a password here" is a different fact from "the config is
    // empty", and a diagnosis often turns on which one it is.
    const { text } = defaultRedactor.redact('POSTGRES_PASSWORD=hunter2correcthorse');
    expect(text).toBe('POSTGRES_PASSWORD=[REDACTED:secret-assignment]');
  });

  it('names a recognisable vendor shape rather than falling back to a generic type', () => {
    expect(defaultRedactor.redact('AKIAIOSFODNN7EXAMPLE').text).toBe('[REDACTED:aws-access-key]');
    expect(defaultRedactor.redact('ghp_A1b2C3d4E5f6G7h8I9j0K1l2').text).toBe(
      '[REDACTED:github-token]',
    );
  });

  it('keeps the host reachable in a connection string', () => {
    // The host and database are the diagnostic value; only the password goes.
    const { text } = defaultRedactor.redact('postgres://labapp:S3cretP4ss@db.internal:5432/orders');
    expect(text).toBe('postgres://labapp:[REDACTED:url-credentials]@db.internal:5432/orders');
  });

  it('does not nest markers when rules overlap', () => {
    const { text } = defaultRedactor.redact('password=AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toMatch(/REDACTED[^\]]*REDACTED/);
  });

  it('reports what it removed', () => {
    const report = defaultRedactor.redact('AKIAIOSFODNN7EXAMPLE and ghp_A1b2C3d4E5f6G7h8I9j0K1l2');
    expect(report.total).toBe(2);
    expect(report.counts['aws-access-key']).toBe(1);
    expect(report.counts['github-token']).toBe(1);
  });

  it('leaves clean text and empty input untouched', () => {
    const clean = 'Active: active (running) since Mon 2026-09-22 07:10:03 UTC';
    expect(defaultRedactor.redact(clean).text).toBe(clean);
    expect(defaultRedactor.redact('').total).toBe(0);
  });

  it('applies extra patterns from policy', () => {
    const redactor = new Redactor({ extraPatterns: ['INTERNAL-[0-9]{6}'] });
    expect(redactor.redact('ticket INTERNAL-123456 filed').text).toBe(
      'ticket [REDACTED:policy-pattern] filed',
    );
  });

  it('ignores a policy pattern that will not compile', () => {
    // A broken pattern must not disable redaction entirely; the built-ins still
    // have to run.
    const redactor = new Redactor({ extraPatterns: ['([unclosed'] });
    expect(redactor.redact('AKIAIOSFODNN7EXAMPLE').text).toBe('[REDACTED:aws-access-key]');
  });

  it('redacts strings throughout a structure', () => {
    const redacted = defaultRedactor.redactDeep({
      host: 'lab-api',
      env: ['PATH=/usr/bin', 'TOKEN=9fK2mX7pQ4rV8sT1uW3yZ5aB6cD0eF2g'],
      nested: { url: 'postgres://u:p4ssw0rd-long@db:5432/x', count: 3, missing: null },
    });

    expect(redacted.host).toBe('lab-api');
    expect(redacted.env[0]).toBe('PATH=/usr/bin');
    expect(redacted.env[1]).toContain('[REDACTED:');
    expect(redacted.nested.url).toContain('[REDACTED:');
    expect(redacted.nested.count).toBe(3);
    expect(redacted.nested.missing).toBeNull();
  });

  it('is not confused by repeated calls', () => {
    // A shared /g regex carries lastIndex between calls and would skip matches.
    const input = 'AKIAIOSFODNN7EXAMPLE';
    expect(defaultRedactor.redact(input).text).toBe(defaultRedactor.redact(input).text);
  });
});

describe('entropy analysis', () => {
  it('scores a uniform string below a random one', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('9fK2mX7pQ4rV8sT1uW3yZ5aB')).toBeGreaterThan(3.5);
    expect(shannonEntropy('')).toBe(0);
  });

  it('rejects identifier shapes however long', () => {
    // The largest source of false positives in real diagnostic output.
    expect(looksLikeSecret('9f2a4c6e0b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a')).toBe(false);
    expect(looksLikeSecret('3b5d7f9a-1c3e-5b7d-9f1a-3c5e7b9d1f3a')).toBe(false);
    expect(looksLikeSecret('12345678901234567890')).toBe(false);
    expect(looksLikeSecret('short')).toBe(false);
  });

  it('accepts a mixed-class high-entropy token', () => {
    expect(looksLikeSecret('9fK2mX7pQ4rV8sT1uW3yZ5aB6cD0eF2g')).toBe(true);
  });

  it('only fires where there is secret-like context', () => {
    // Without this, every image digest in `docker ps` output would go.
    const digest = 'sha256:632904517119686c049d887414a500f827965de669eedf03b85782516224ca65';
    expect(defaultRedactor.redact(digest).text).toBe(digest);
  });
});
