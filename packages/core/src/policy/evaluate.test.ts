import { describe, expect, it } from 'vitest';
import { Risk } from '../types.js';
import { parsePolicy } from './load.js';
import { evaluate, type EvaluateInput } from './evaluate.js';

/**
 * Table-driven tests for the policy evaluator, following the case table agreed
 * in the Phase 1 plan. Policies are written as YAML and run through the real
 * loader so the tests exercise the schema's defaults too.
 */

const KNOWN_HOSTS = ['lab-api', 'lab-db', 'prod-api', 'staging-web', 'other-thing'];

function decide(yaml: string, over: Partial<EvaluateInput> = {}) {
  return evaluate({
    policy: parsePolicy(yaml).policy,
    tool: 'service_status',
    risk: Risk.Read,
    hosts: ['lab-api'],
    knownHosts: KNOWN_HOSTS,
    session: { actionsUsed: 0 },
    ...over,
  });
}

const DEFAULTS = `
version: 1
defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]
hosts:
  - match: "lab-*"
`;

// ───────────────────────────── A · Host resolution ─────────────────────────────

describe('A · host resolution', () => {
  // Case 1
  it('denies a host that is not in the SSH config', () => {
    const decision = decide(DEFAULTS, { hosts: ['lab-ghost'] });
    expect(decision).toMatchObject({ kind: 'deny', code: 'UNKNOWN_HOST' });
    expect(decision.reason).toContain('lab-ghost');
  });

  // Case 2
  it('denies a known host that no policy rule covers', () => {
    const decision = decide(DEFAULTS, { hosts: ['other-thing'] });
    expect(decision).toMatchObject({ kind: 'deny', code: 'UNMANAGED_HOST' });
  });

  // Case 3
  it('uses an exact rule when one matches', () => {
    const decision = decide(`${DEFAULTS}  - match: "lab-api"\n    deny: [read]\n`);
    expect(decision).toMatchObject({ kind: 'deny', rule: 'hosts["lab-api"]' });
  });

  // Case 4
  it('uses a wildcard rule when only that matches', () => {
    expect(decide(DEFAULTS)).toMatchObject({ kind: 'allow', rule: 'defaults' });
  });

  // Case 5
  it('still requires a policy rule for a host the SSH config knows', () => {
    expect(decide('version: 1\nhosts: []\n', { hosts: ['lab-api'] })).toMatchObject({
      code: 'UNMANAGED_HOST',
    });
  });

  // Case 6
  it('denies every host when the rule list is empty', () => {
    for (const host of KNOWN_HOSTS) {
      expect(decide('version: 1\n', { hosts: [host] }).kind).toBe('deny');
    }
  });
});

// ─────────────────────────────── B · Specificity ───────────────────────────────

describe('B · specificity', () => {
  // Case 7
  it('prefers an exact rule over a wildcard rule', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    deny: [read]
  - match: "lab-api"
    allow: [read]
`;
    expect(decide(yaml)).toMatchObject({ kind: 'allow', rule: 'hosts["lab-api"]' });
  });

  // Case 8
  it('prefers the wildcard rule with more literal characters', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    deny: [read]
  - match: "lab-ap*"
    allow: [read]
`;
    expect(decide(yaml)).toMatchObject({ kind: 'allow', rule: 'hosts["lab-ap*"]' });
  });

  // Case 9
  it('treats a bare * as the least specific rule', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "*"
    deny: [read]
  - match: "lab-*"
    allow: [read]
`;
    expect(decide(yaml)).toMatchObject({ kind: 'allow', rule: 'hosts["lab-*"]' });
  });

  // Cases 10 & 11
  it('takes the strictest verdict when equally specific rules disagree', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    allow: [read]
  - match: "*-api"
    deny: [read]
`;
    const decision = decide(yaml);
    expect(decision).toMatchObject({ kind: 'deny' });
    expect(decision.rule).toContain('*-api');
  });

  // Case 12
  it('prefers approval over allow among tied rules', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    allow: [reversible]
  - match: "*-api"
    require_approval: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Reversible })).toMatchObject({ kind: 'approval' });
  });

  // Case 13
  it('takes the strictest of a three-way tie', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    allow: [reversible]
  - match: "*-api"
    require_approval: [reversible]
  - match: "?ab-api"
    deny: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Reversible })).toMatchObject({ kind: 'deny' });
  });

  // Case 10, order independence
  it('gives the same verdict whichever order tied rules are written in', () => {
    const a = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    allow: [reversible]
  - match: "*-api"
    require_approval: [reversible]
`;
    const b = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "*-api"
    require_approval: [reversible]
  - match: "lab-*"
    allow: [reversible]
`;
    expect(decide(a, { risk: Risk.Reversible }).kind).toBe(
      decide(b, { risk: Risk.Reversible }).kind,
    );
  });
});

// ────────────────────────── C · Specificity-wins merge ──────────────────────────

describe('C · merge semantics', () => {
  // Case 14: the reason this semantics was chosen — DESIGN's own staging example
  it('lets a host rule allow what the defaults would send to approval', () => {
    const yaml = `
version: 1
defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]
hosts:
  - match: "staging-*"
    allow: [read, reversible]
`;
    expect(decide(yaml, { hosts: ['staging-web'], risk: Risk.Reversible })).toMatchObject({
      kind: 'allow',
      rule: 'hosts["staging-*"]',
    });
  });

  // Case 15
  it('lets a host rule require approval for what the defaults allow', () => {
    const yaml = `
version: 1
defaults: { allow: [read, reversible] }
hosts:
  - match: "lab-*"
    require_approval: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Reversible })).toMatchObject({ kind: 'approval' });
  });

  // Case 16
  it('lets a host rule deny what the defaults allow', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    deny: [read]
`;
    expect(decide(yaml)).toMatchObject({ kind: 'deny', code: 'DENIED_BY_POLICY' });
  });

  // Case 17
  it('inherits the defaults for a class the host rule never mentions', () => {
    const yaml = `
version: 1
defaults:
  allow: [read]
  require_approval: [config]
hosts:
  - match: "lab-*"
    allow: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Config })).toMatchObject({
      kind: 'approval',
      rule: 'defaults',
    });
  });

  // Case 18
  it('applies precedence within a single rule', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
    allow: [reversible]
    require_approval: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Reversible })).toMatchObject({ kind: 'approval' });
  });

  // Case 19
  it('falls back entirely to the defaults for a rule with no risk keys', () => {
    expect(decide(DEFAULTS, { risk: Risk.Config })).toMatchObject({
      kind: 'approval',
      rule: 'defaults',
    });
  });

  // Case 20
  it('fails closed when nothing mentions the class at all', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
`;
    const decision = decide(yaml, { risk: Risk.Config });
    expect(decision).toMatchObject({ kind: 'deny', code: 'DENIED_BY_POLICY' });
    expect(decision.reason).toMatch(/no rule/i);
  });

  // Case 21
  it('lets a host rule allow a class the defaults deny', () => {
    const yaml = `
version: 1
defaults:
  allow: [read]
  deny: [reversible]
hosts:
  - match: "lab-*"
    allow: [reversible]
`;
    expect(decide(yaml, { risk: Risk.Reversible })).toMatchObject({ kind: 'allow' });
  });
});

// ───────────────────────────── D · The never list ─────────────────────────────

describe('D · tools.never', () => {
  const never = `
version: 1
defaults: { allow: [read, reversible, config] }
hosts:
  - match: "lab-*"
    allow: [read, reversible, config]
tools:
  never: [drop_database]
`;

  // Case 22
  it('denies a tool on the never list whatever its risk', () => {
    for (const risk of [Risk.Read, Risk.Reversible, Risk.Config]) {
      expect(decide(never, { tool: 'drop_database', risk })).toMatchObject({
        kind: 'deny',
        rule: 'tools.never',
      });
    }
  });

  // Case 23
  it('denies a never-listed tool even with an allow_on override', () => {
    const yaml = `${never}  overrides:\n    drop_database: { allow_on: ["*"] }\n`;
    expect(decide(yaml, { tool: 'drop_database' })).toMatchObject({
      kind: 'deny',
      rule: 'tools.never',
    });
  });

  // Case 24
  it('denies a never-listed tool even under a permissive host rule', () => {
    expect(decide(never, { tool: 'drop_database', hosts: ['lab-api'] }).kind).toBe('deny');
  });

  // Case 25
  it('leaves other tools alone', () => {
    expect(decide(never, { tool: 'service_status' }).kind).toBe('allow');
  });
});

// ──────────────────────────── E · Tool overrides ────────────────────────────

describe('E · tool overrides', () => {
  const base = `
version: 1
defaults:
  allow: [read]
  require_approval: [reversible]
hosts:
  - match: "lab-*"
tools:
  overrides:
`;

  // Case 26
  it('allow_on raises an approval requirement to allow', () => {
    const yaml = `${base}    prune_images: { allow_on: ["*"] }\n`;
    expect(decide(yaml, { tool: 'prune_images', risk: Risk.Reversible })).toMatchObject({
      kind: 'allow',
      rule: 'tools.overrides.prune_images',
    });
  });

  // Case 27
  it('ignores an override whose pattern does not match the host', () => {
    const yaml = `${base}    prune_images: { allow_on: ["prod-*"] }\n`;
    expect(decide(yaml, { tool: 'prune_images', risk: Risk.Reversible })).toMatchObject({
      kind: 'approval',
      rule: 'defaults',
    });
  });

  // Case 28
  it('cannot loosen a deny', () => {
    const yaml = `
version: 1
defaults: { allow: [read], deny: [reversible] }
hosts:
  - match: "lab-*"
tools:
  overrides:
    prune_images: { allow_on: ["*"] }
`;
    expect(decide(yaml, { tool: 'prune_images', risk: Risk.Reversible }).kind).toBe('deny');
  });

  // Case 30
  it('require_approval_on tightens an allow', () => {
    const yaml = `${base}    tail_logs: { require_approval_on: ["lab-*"] }\n`;
    expect(decide(yaml, { tool: 'tail_logs', risk: Risk.Read })).toMatchObject({
      kind: 'approval',
      rule: 'tools.overrides.tail_logs',
    });
  });

  // Case 31
  it('deny_on tightens an allow', () => {
    const yaml = `${base}    tail_logs: { deny_on: ["lab-*"] }\n`;
    expect(decide(yaml, { tool: 'tail_logs', risk: Risk.Read })).toMatchObject({
      kind: 'deny',
      rule: 'tools.overrides.tail_logs',
    });
  });

  it('takes the strictest action when several override lists match', () => {
    const yaml = `${base}    tail_logs: { allow_on: ["*"], deny_on: ["lab-*"] }\n`;
    expect(decide(yaml, { tool: 'tail_logs', risk: Risk.Read }).kind).toBe('deny');
  });

  it('ignores overrides naming a different tool', () => {
    const yaml = `${base}    some_other_tool: { deny_on: ["*"] }\n`;
    expect(decide(yaml, { tool: 'tail_logs', risk: Risk.Read }).kind).toBe('allow');
  });
});

// ───────────────────────────── F · Hard floors ─────────────────────────────

describe('F · destructive is a floor in code', () => {
  const permissive = `
version: 1
defaults:
  allow: [read, reversible, config, destructive]
hosts:
  - match: "lab-*"
    allow: [read, reversible, config, destructive]
tools:
  overrides:
    delete_volume: { allow_on: ["*"] }
`;

  // Cases 32-34
  it('denies destructive risk however permissive the policy is', () => {
    const decision = decide(permissive, { tool: 'delete_volume', risk: Risk.Destructive });
    expect(decision).toMatchObject({ kind: 'deny', code: 'DESTRUCTIVE_DENIED' });
    expect(decision.rule).toBe('code:destructive-floor');
  });

  it('does not affect other risk classes', () => {
    expect(decide(permissive, { risk: Risk.Config }).kind).toBe('allow');
  });
});

// ───────────────────────────── G · Session limits ─────────────────────────────

describe('G · limits', () => {
  const limited = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "lab-*"
limits:
  max_actions_per_session: 3
  max_hosts_per_action: 1
`;

  // Case 35
  it('proceeds below the action limit', () => {
    expect(decide(limited, { session: { actionsUsed: 2 } }).kind).toBe('allow');
  });

  // Case 36
  it('denies at the action limit', () => {
    expect(decide(limited, { session: { actionsUsed: 3 } })).toMatchObject({
      kind: 'deny',
      code: 'SESSION_LIMIT',
      rule: 'limits.max_actions_per_session',
    });
  });

  // Case 37
  it('does not consume budget itself', () => {
    const input = { session: { actionsUsed: 2 } };
    expect(decide(limited, input).kind).toBe('allow');
    expect(decide(limited, input).kind).toBe('allow');
    expect(input.session.actionsUsed).toBe(2);
  });

  // Case 38
  it('proceeds within the host limit', () => {
    expect(decide(limited, { hosts: ['lab-api'] }).kind).toBe('allow');
  });

  // Case 39
  it('denies an action spanning more hosts than the limit', () => {
    expect(decide(limited, { hosts: ['lab-api', 'lab-db'] })).toMatchObject({
      kind: 'deny',
      code: 'HOST_LIMIT',
      rule: 'limits.max_hosts_per_action',
    });
  });

  it('denies an action with no host at all', () => {
    expect(decide(limited, { hosts: [] }).kind).toBe('deny');
  });

  // Case 40
  it('applies the documented defaults when limits are omitted', () => {
    expect(decide(DEFAULTS, { session: { actionsUsed: 19 } }).kind).toBe('allow');
    expect(decide(DEFAULTS, { session: { actionsUsed: 20 } })).toMatchObject({
      code: 'SESSION_LIMIT',
    });
    expect(decide(DEFAULTS, { hosts: ['lab-api', 'lab-db'] })).toMatchObject({
      code: 'HOST_LIMIT',
    });
  });

  it('reports a policy refusal before a budget refusal', () => {
    // A denied action is more useful to report than an exhausted budget: the
    // agent needs to know the action is not allowed at all.
    const yaml = `
version: 1
defaults: { deny: [read] }
hosts:
  - match: "lab-*"
limits:
  max_actions_per_session: 1
`;
    expect(decide(yaml, { session: { actionsUsed: 5 } })).toMatchObject({
      kind: 'deny',
      code: 'DENIED_BY_POLICY',
    });
  });

  it('defaults to a fresh session when none is supplied', () => {
    expect(decide(limited, { session: undefined }).kind).toBe('allow');
  });
});

// ──────────────────────────── I · Decision reporting ────────────────────────────

describe('I · decision reporting', () => {
  // Cases 49-51
  it('always names the rule that decided and gives a human reason', () => {
    const cases = [
      decide(DEFAULTS),
      decide(DEFAULTS, { risk: Risk.Config }),
      decide(DEFAULTS, { risk: Risk.Destructive }),
      decide(DEFAULTS, { hosts: ['lab-ghost'] }),
      decide(DEFAULTS, { hosts: ['other-thing'] }),
      decide(DEFAULTS, { session: { actionsUsed: 99 } }),
    ];

    for (const decision of cases) {
      expect(decision.rule.length).toBeGreaterThan(0);
      expect(decision.reason.length).toBeGreaterThan(0);
      if (decision.kind === 'deny') expect(decision.code).toBeTruthy();
    }
  });

  it('names the host rule that required approval', () => {
    const yaml = `
version: 1
defaults: { allow: [read] }
hosts:
  - match: "prod-*"
    require_approval: [read]
`;
    expect(decide(yaml, { hosts: ['prod-api'] })).toMatchObject({
      kind: 'approval',
      rule: 'hosts["prod-*"]',
    });
  });
});
