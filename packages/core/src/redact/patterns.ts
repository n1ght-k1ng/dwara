/**
 * Named patterns for credential material.
 *
 * Order matters. The first rule that matches a span wins, so the specific
 * shapes (a recognisable vendor prefix) come before the general ones (anything
 * after `password=`), which keeps `[REDACTED:aws-access-key]` in the output
 * instead of a less useful `[REDACTED:secret]`.
 */
export interface RedactionRule {
  /** Appears in the output as `[REDACTED:<name>]`. */
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * Which capture group holds the secret. Group 0 redacts the whole match;
   * a higher group keeps the surrounding context — `password=[REDACTED:password]`
   * reads far better in a diagnosis than `[REDACTED:password]` alone.
   */
  readonly group?: number;
}

/**
 * Keys whose values are secret whatever the value looks like.
 *
 * `api[_ -]?key` covers `api key` written with a space, which is how it appears
 * in prose-ish log lines ("datadog api key: ...") rather than in config.
 */
const SECRET_KEY =
  '(?:pass(?:word|wd)?|secret|token|api[_ -]?key|apikey|auth|credential|private[_ -]?key|access[_ -]?key|client[_ -]?secret|requirepass|session[_ -]?secret|encryption[_ -]?key|signing[_ -]?key|license[_ -]?key|key[_ -]?data|dsn)';

/**
 * A secret keyword can sit inside a longer identifier — `PGPASSWORD`,
 * `api_secret`, `AZURE_CLIENT_SECRET`. A leading \b would anchor to the start
 * of the whole identifier and miss all of them, so the prefix is matched
 * explicitly instead.
 */
const KEY_PREFIX = '[a-z0-9_]*';

export const RULES: readonly RedactionRule[] = [
  // ── private key material ────────────────────────────────────────────────
  {
    name: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)?/g,
  },
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  {
    name: 'private-key',
    pattern: /-----BEGIN NATS USER JWT-----[\s\S]{0,4000}?(?:-----END[^\n]*|$)/g,
  },
  // A bare PEM body line: long base64 with the RSA/PKCS marker prefixes.
  { name: 'private-key-body', pattern: /\bMII[A-Za-z0-9+/]{40,}={0,2}/g },
  { name: 'private-key-body', pattern: /\bLS0tLS1CRUdJTi[A-Za-z0-9+/]{20,}={0,2}/g },

  // ── cloud provider keys ─────────────────────────────────────────────────
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  {
    name: 'aws-secret-key',
    pattern: /\b(aws_secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{30,})["']?/gi,
    group: 2,
  },
  { name: 'aws-session-token', pattern: /\bFwoG[A-Za-z0-9+/=]{20,}/g },
  { name: 'gcp-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'gcp-oauth-token', pattern: /\bya29\.[A-Za-z0-9._-]{20,}/g },
  { name: 'gcp-service-key', pattern: /\bGOOG[A-Z0-9]{20,}\b/g },

  // ── vendor tokens with recognisable prefixes ────────────────────────────
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g },
  { name: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'gitlab-token', pattern: /\b(?:glpat|glcbt)-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-key', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'stripe-webhook-secret', pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { name: 'openai-key', pattern: /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9-]{16,}\b/g },
  { name: 'llm-api-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: 'docker-token', pattern: /\bdckr_(?:pat_)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: 'vault-token', pattern: /\bhvs\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'vault-token', pattern: /\bs\.[A-Za-z0-9]{24,}\b/g },
  { name: 'pypi-token', pattern: /\bpypi-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'cargo-token', pattern: /\bcio[A-Za-z0-9]{24,}\b/g },
  { name: 'digitalocean-token', pattern: /\bdop_v1_[a-f0-9]{32,}\b/g },
  { name: 'sentry-dsn', pattern: /\bhttps:\/\/[a-f0-9]{16,}@[\w.-]*ingest[\w.-]*\/\d+/gi },
  { name: 'newrelic-key', pattern: /\b[a-z]{2}\d{2}xx[A-Za-z0-9]{20,}NRAL\b/g },
  { name: 'twilio-sid', pattern: /\bAC[a-f0-9]{32}\b/gi },

  // ── JWTs and authorization headers ──────────────────────────────────────
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{20,}/g },
  {
    name: 'bearer-token',
    pattern: /\b(authorization\s*[:=]\s*bearer)\s+([A-Za-z0-9._~+/-]{12,}=*)/gi,
    group: 2,
  },
  {
    name: 'basic-auth',
    pattern: /\b((?:proxy-)?authorization\s*[:=]\s*basic)\s+([A-Za-z0-9+/]{8,}=*)/gi,
    group: 2,
  },
  {
    name: 'api-key-header',
    pattern: /\b(x-(?:api|auth|access)[_-]?(?:key|token)\s*[:=]\s*)(\S{8,})/gi,
    group: 2,
  },
  {
    name: 'aws-security-token',
    pattern: /\b(x-amz-security-token\s*[:=]\s*)(\S{16,})/gi,
    group: 2,
  },
  {
    name: 'session-cookie',
    pattern: /\b((?:set-)?cookie\s*[:=]\s*[^\s=]*(?:session|auth|token)[^\s=]*=)([^\s;,]{8,})/gi,
    group: 2,
  },

  // ── credentials inside URLs and connection strings ──────────────────────
  {
    // The username may be empty — `redis://:password@host` is ordinary.
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s/@]+)(?=@)/gi,
    group: 2,
  },
  {
    name: 'connection-password',
    pattern: /\b([?&;](?:password|pwd)=)([^\s&;"']+)/gi,
    group: 2,
  },
  {
    name: 'connection-password',
    pattern: /\b(Password\s*=\s*)([^;"'\s]+)/gi,
    group: 2,
  },

  // ── unix credential shapes ──────────────────────────────────────────────
  { name: 'unix-hash', pattern: /\$(?:1|2[aby]?|5|6|y)\$[^\s:]{8,}/g },
  { name: 'apr1-hash', pattern: /\$apr1\$[^\s:]{8,}/g },
  {
    // Anchored to the real netrc shape. A bare `password <word>` rule matched
    // "password authentication failed" in ordinary log lines and redacted the
    // word "authentication".
    name: 'netrc-password',
    pattern: /\b(machine\s+\S+\s+login\s+\S+\s+password)\s+(\S+)/gi,
    group: 2,
  },

  // ── command-line credentials ────────────────────────────────────────────
  { name: 'cli-password', pattern: /(--password[= ]+)(["']?)([^\s"']{4,})\2/gi, group: 3 },
  { name: 'cli-password', pattern: /(^|\s)-p\s+(["'])([^"']{4,})\2/gm, group: 3 },
  { name: 'cli-password', pattern: /(\bsshpass\s+-p\s+)(["']?)([^\s"']{4,})\2/gi, group: 3 },
  { name: 'cli-password', pattern: /(\bdocker\s+login\b[^\n]*?\s-p\s+)(\S{8,})/gi, group: 2 },
  { name: 'curl-userinfo', pattern: /(\bcurl\b[^\n]*?\s-u\s+)([^\s:]+:)(\S+)/gi, group: 3 },

  // ── the general case: a secret-ish key with any value ───────────────────
  {
    name: 'secret-assignment',
    pattern: new RegExp(
      `${KEY_PREFIX}${SECRET_KEY}${KEY_PREFIX}\\s*[:=]\\s*(["']?)([^\\s"',;]{4,})\\1`,
      'gi',
    ),
    group: 2,
  },
  {
    /**
     * A YAML block scalar: `password: |` and the value on the following lines.
     *
     * Found by the Phase 6 red-team pass, and the only leak it found. The rule
     * above already reaches across a newline — `POSTGRES_PASSWORD:\n  value` is
     * redacted — but the `|` or `>` indicator sits between the key and the value
     * and stops it matching. Entropy analysis does not save it either, because
     * that requires secret-like context **on the same line** and the value's own
     * line is just an indented token.
     *
     * `read_config` on anything that keeps a credential this way would have
     * returned it in full.
     */
    name: 'secret-assignment',
    pattern: new RegExp(
      `${KEY_PREFIX}${SECRET_KEY}${KEY_PREFIX}\\s*:\\s*[|>][-+]?[0-9]*[ \\t]*\\r?\\n([ \\t]+)([^\\n]{4,})`,
      'gi',
    ),
    group: 2,
  },
  {
    // `requirepass a9f2…`, `api key: 9f2a…`, `TOKEN kY8m…` — whitespace
    // separated rather than assigned, which is how prose-ish log lines render
    // it. The value must contain a digit: without that the rule fires on
    // "authentication succeeded" and redacts the word "succeeded".
    name: 'secret-assignment',
    pattern: new RegExp(
      `${KEY_PREFIX}${SECRET_KEY}${KEY_PREFIX}\\s+(["']?)((?=[^\\s"',;]*\\d)[^\\s"',;]{8,})\\1`,
      'gi',
    ),
    group: 2,
  },
] as const;
