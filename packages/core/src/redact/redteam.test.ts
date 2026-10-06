import { describe, expect, it } from 'vitest';
import { defaultRedactor } from './redact.js';

/**
 * Phase 6 Task 3 — a deliberate attempt to get a secret past the redactor.
 *
 * Two kinds of case live here, and the second kind matters more:
 *
 *   - **Caught.** An attack the redactor stops. A regression here is a leak.
 *   - **Known gap.** An attack it does *not* stop, asserted as leaking on
 *     purpose. These are the tradeoffs that make the redactor usable rather than
 *     bugs nobody noticed, and writing them as passing tests means the next
 *     person reads the reasoning instead of rediscovering the hole. If one is
 *     ever closed, the test fails and the comment gets deleted deliberately.
 *
 * `docs/THREAT_MODEL.md` summarises these; this file is the evidence.
 */

const redact = (text: string): string => defaultRedactor.redact(text).text;
const leaks = (text: string): boolean => !redact(text).includes('REDACTED');

/** A 24-character token with four character classes and high entropy. */
const SECRET = 'Xk9mQ2vL8pR4tY7wZ1nB3hJ6';

describe('red team: getting a secret past the redactor', () => {
  describe('caught', () => {
    const attacks: Record<string, string> = {
      'plain assignment': `password=${SECRET}`,
      'yaml scalar': `password: ${SECRET}`,
      'key on the line above': `POSTGRES_PASSWORD:\n  ${SECRET}`,
      'yaml block scalar': `database:\n  password: |\n    ${SECRET}`,
      'yaml folded scalar': `api_key: >\n  ${SECRET}`,
      'yaml block with strip indicator': `secret: |-\n  ${SECRET}`,
      'yaml block with explicit indent': `token: |2\n  ${SECRET}`,
      'quoted value': `password: "${SECRET}"`,
      'whitespace separated': `requirepass ${SECRET}`,
      'aws access key, no context needed': 'AKIAIOSFODNN7EXAMPLE',
      'github token by prefix': 'token ghp_abcdefghijklmnop1234',
      'private key header': '-----BEGIN OPENSSH PRIVATE KEY-----',
      // Built from an escape rather than the literal character: a zero-width
      // space in the source is invisible to a reviewer, which is the very thing
      // the hidden-text detector exists to catch.
      'zero-width character inside the value': 'password=Xk9mQ2v\u200bL8pR4tY7wZ1nB3hJ6',
      'value split from key by a newline and indent': `api-token:\n    ${SECRET}`,
    };

    for (const [name, attack] of Object.entries(attacks)) {
      it(name, () => {
        expect(leaks(attack), `leaked: ${redact(attack)}`).toBe(false);
      });
    }
  });

  describe('known gaps, asserted as gaps', () => {
    // Each of these was *measured*, not assumed. Two gaps written here first --
    // a value under twenty characters, and a value split mid-token -- turned out
    // to be caught by rules the author of this file had not accounted for, so
    // they were removed rather than left as comfortable-sounding limitations.

    it('a high-entropy token on a line with no secret-like word is left alone', () => {
      // The deliberate tradeoff. Entropy analysis only runs on a line with
      // secret-like context, because without that every image digest in
      // `docker ps`, every git SHA and every UUID would be redacted -- and a
      // redactor nobody can read through is one people turn off.
      expect(leaks(`Oct 06 user logged in from 10.0.0.4 ${SECRET}`)).toBe(true);
    });

    it('a long token of only two character classes is left alone', () => {
      // Three classes is the floor for the entropy path. Dropping to two would
      // redact every hex digest and container id, which is the same unusable
      // outcome. The line below has secret-like context ("key"), so entropy is
      // reached and declines on the class count alone.
      expect(leaks('key rotation completed a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('a value wrapped mid-token leaks its tail', () => {
      // The assignment is caught, so the first half goes. Nothing is anchored
      // across the break, so the remainder survives. No pattern-based redactor
      // fixes this without reassembling arbitrary text, and the secret is at
      // least no longer usable whole.
      const out = redact('password=Xk9mQ2vL8pR4\ntY7wZ1nB3hJ6');
      expect(out).toContain('REDACTED');
      expect(out).toContain('tY7wZ1nB3hJ6');
    });
  });

  describe('the redactor does not eat the diagnosis', () => {
    it('keeps the key name, which is the part worth reading', () => {
      expect(redact(`POSTGRES_PASSWORD=${SECRET}`)).toContain('POSTGRES_PASSWORD');
    });

    it('leaves a container id alone', () => {
      expect(leaks('CONTAINER ID 82e3d841c8b7 dwara-lab-app:dev Up 4 minutes')).toBe(true);
    });

    it('leaves an image digest alone', () => {
      expect(leaks('sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e')).toBe(
        true,
      );
    });

    it('leaves ordinary prose under a block scalar alone', () => {
      expect(leaks('description: |\n  This service proxies requests to the API')).toBe(true);
    });
  });
});
