import { describe, expect, it } from 'vitest';
import { matchesAny, matchesHost, selectHostRules, specificity } from './match.js';

describe('matchesHost', () => {
  it.each([
    ['lab-api', 'lab-api', true],
    ['lab-api', 'lab-db', false],
    ['lab-*', 'lab-api', true],
    ['lab-*', 'lab-', true],
    ['lab-*', 'prod-api', false],
    ['*', 'anything', true],
    ['*-api', 'lab-api', true],
    ['*-api', 'lab-api-2', false],
    ['lab-?b', 'lab-db', true],
    ['lab-?b', 'lab-ddb', false],
  ])('%s vs %s -> %s', (pattern, host, expected) => {
    expect(matchesHost(pattern, host)).toBe(expected);
  });

  it('treats regex metacharacters as literals', () => {
    // Without escaping, `lab.api` would match `lab-api` and a policy rule would
    // silently cover a host its author never named.
    expect(matchesHost('lab.api', 'lab-api')).toBe(false);
    expect(matchesHost('lab.api', 'lab.api')).toBe(true);
    expect(matchesHost('lab+api', 'lab+api')).toBe(true);
    expect(matchesHost('lab(api)', 'lab(api)')).toBe(true);
  });

  it('anchors at both ends', () => {
    expect(matchesHost('lab', 'lab-api')).toBe(false);
    expect(matchesHost('api', 'lab-api')).toBe(false);
  });

  it('matches any pattern in a list', () => {
    expect(matchesAny(['prod-*', 'lab-*'], 'lab-api')).toBe(true);
    expect(matchesAny(['prod-*'], 'lab-api')).toBe(false);
    expect(matchesAny([], 'lab-api')).toBe(false);
  });
});

describe('specificity', () => {
  // Case 7
  it('ranks an exact pattern above any wildcard pattern', () => {
    expect(specificity('lab-api')).toBeGreaterThan(specificity('lab-api-server-*'));
  });

  // Case 8
  it('ranks more literal characters higher among wildcards', () => {
    expect(specificity('lab-api-*')).toBeGreaterThan(specificity('lab-*'));
  });

  // Case 9
  it('ranks bare * lowest', () => {
    expect(specificity('*')).toBe(0);
    expect(specificity('lab-*')).toBeGreaterThan(specificity('*'));
  });

  it('gives equally literal wildcard patterns the same score', () => {
    expect(specificity('lab-*')).toBe(specificity('*-api'));
  });
});

describe('selectHostRules', () => {
  const rules = [
    { match: '*' },
    { match: 'lab-*' },
    { match: '*-api' },
    { match: 'lab-api' },
    { match: 'prod-*' },
  ];

  it('returns the single most specific match', () => {
    expect(selectHostRules(rules, 'lab-api')).toEqual([{ match: 'lab-api' }]);
  });

  // Case 10: a tie is reported in full rather than broken by document order
  it('returns every rule tied at the top score', () => {
    const tied = selectHostRules(
      [{ match: '*' }, { match: 'lab-*' }, { match: '*-api' }],
      'lab-api',
    );
    expect(tied).toEqual([{ match: 'lab-*' }, { match: '*-api' }]);
  });

  it('is independent of the order rules appear in', () => {
    const forward = selectHostRules([{ match: 'lab-*' }, { match: '*-api' }], 'lab-api');
    const reversed = selectHostRules([{ match: '*-api' }, { match: 'lab-*' }], 'lab-api');
    expect(new Set(forward.map((r) => r.match))).toEqual(new Set(reversed.map((r) => r.match)));
  });

  // Case 2 / 6
  it('returns nothing when no rule matches', () => {
    const noCatchAll = rules.filter((rule) => rule.match !== '*');
    expect(selectHostRules(noCatchAll, 'unknown-host')).toEqual([]);
    expect(selectHostRules([], 'lab-api')).toEqual([]);
  });

  it('falls back to a bare * only when nothing better matches', () => {
    expect(selectHostRules(rules, 'other-thing')).toEqual([{ match: '*' }]);
  });
});
