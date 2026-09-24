/**
 * Entropy-based detection for secrets no pattern recognises.
 *
 * This exists for two cases the pattern rules cannot cover:
 *
 * 1. A credential with no vendor prefix and no `key=` around it — an opaque
 *    token pasted into a log line.
 * 2. A credential the transport cut in half. Output is capped at 64 KB by
 *    discarding the tail, so half a token can survive with nothing left to
 *    anchor a pattern against. Half a secret is still a secret.
 *
 * The risk runs the other way too: diagnostic output is *full* of long
 * random-looking strings that are not secrets — git SHAs, image digests,
 * container IDs, checksums. Redacting those destroys the evidence an operator
 * came for, so this only fires when high entropy coincides with a secret-like
 * word nearby, and never on shapes that are recognisably identifiers.
 */

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Words that make a nearby high-entropy string much more likely to be a secret. */
const SECRET_CONTEXT =
  /(?:pass(?:word|wd)?|secret|token|key|credential|auth|bearer|cred|signature|salt)/i;

/**
 * Shapes that are long and random-looking but are identifiers, not secrets.
 *
 * Pure lowercase hex covers git SHAs, image digests, container IDs, machine
 * IDs and checksums — the single largest source of false positives in real
 * output, and never a credential on its own.
 */
const IDENTIFIER_SHAPES: readonly RegExp[] = [
  /^[a-f0-9]+$/, // hex digest of any length
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^\d+$/, // plain numbers
  /^[A-Z0-9]{2}(?::[A-Z0-9]{2})+$/i, // colon-separated fingerprints
  // A version string has dotted components. Without requiring them this
  // matched any token starting with a digit, which excused real secrets.
  /^v?\d+(?:\.\d+)+[\w.-]*$/,
];

/** Minimum length before a token is even considered. */
const MIN_LENGTH = 20;
/** Bits per character above which a string looks machine-generated. */
const MIN_ENTROPY = 3.6;

/** True when `token` looks like credential material rather than an identifier. */
export function looksLikeSecret(token: string): boolean {
  if (token.length < MIN_LENGTH) return false;
  if (IDENTIFIER_SHAPES.some((shape) => shape.test(token))) return false;

  // A mix of character classes is what separates a generated credential from a
  // hex digest or a long lowercase word.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_\-+/=.~]/].filter((cls) => cls.test(token)).length;
  if (classes < 3) return false;

  return shannonEntropy(token) >= MIN_ENTROPY;
}

/** A span of a line that entropy analysis considers secret. */
export interface EntropyFinding {
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

/**
 * Finds high-entropy tokens on a line that has secret-like context.
 *
 * Context is required: without it, every image digest in `docker ps` output
 * would be redacted, which is exactly the failure that makes a redactor
 * unusable.
 */
export function findEntropySecrets(line: string): EntropyFinding[] {
  if (!SECRET_CONTEXT.test(line)) return [];

  const findings: EntropyFinding[] = [];
  // `=` is allowed only as trailing base64 padding. Treating it as an ordinary
  // token character made `POSTGRES_PASSWORD=hunter2...` one token, so the whole
  // thing was replaced and the key name — the part worth keeping — went with it.
  const tokens = /[A-Za-z0-9_\-+/.~]{20,}={0,2}/g;

  let match: RegExpExecArray | null;
  while ((match = tokens.exec(line)) !== null) {
    const token = match[0];
    if (!looksLikeSecret(token)) continue;
    findings.push({ start: match.index, end: match.index + token.length, token });
  }

  return findings;
}
