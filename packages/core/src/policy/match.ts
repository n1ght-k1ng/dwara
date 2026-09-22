/**
 * Host pattern matching for policy rules.
 *
 * Patterns use the same two wildcards as `ssh_config`: `*` for any run of
 * characters and `?` for exactly one. Everything else is literal.
 */

/** Escapes regex metacharacters so only `*` and `?` stay special. */
function toRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*?]/g, (char) => (char === '*' ? '.*' : '.'));
  return new RegExp(`^${body}$`);
}

/** True when `host` matches `pattern`. */
export function matchesHost(pattern: string, host: string): boolean {
  return toRegExp(pattern).test(host);
}

/** True when any pattern in the list matches. */
export function matchesAny(patterns: readonly string[], host: string): boolean {
  return patterns.some((pattern) => matchesHost(pattern, host));
}

/**
 * How specific a pattern is. Higher wins.
 *
 * An exact pattern — one with no wildcards at all — always beats a wildcard
 * pattern, however long. Among wildcard patterns, the one pinning down more
 * literal characters wins: `lab-api-*` beats `lab-*` beats `*`.
 *
 * Equal scores are a genuine tie, not something to break by document order.
 * `selectHostRules` returns all of them and the evaluator merges them
 * strictest-first, so reordering a policy file can never loosen it.
 */
export function specificity(pattern: string): number {
  const literals = pattern.replace(/[*?]/g, '').length;
  const isExact = !/[*?]/.test(pattern);
  // The exact-match bonus is larger than any realistic hostname, so no amount
  // of literal characters in a wildcard pattern can outrank an exact one.
  return isExact ? 1_000_000 + literals : literals;
}

/**
 * The most specific rules matching `host`, as a tied set.
 *
 * Returns an empty array when nothing matches, which the evaluator treats as an
 * unmanaged host and denies.
 */
export function selectHostRules<T extends { readonly match: string }>(
  rules: readonly T[],
  host: string,
): readonly T[] {
  const matching = rules.filter((rule) => matchesHost(rule.match, host));
  if (matching.length === 0) return [];

  const best = Math.max(...matching.map((rule) => specificity(rule.match)));
  return matching.filter((rule) => specificity(rule.match) === best);
}
