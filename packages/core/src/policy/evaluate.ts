import type { Decision } from '../types.js';
import { Risk } from '../types.js';
import { matchesAny, selectHostRules } from './match.js';
import type { HostRule, Policy, ToolOverride } from './schema.js';

/** Everything the evaluator needs. It reads state; it never changes any. */
export interface EvaluateInput {
  readonly policy: Policy;
  /** Tool name as the registry knows it, without the risk prefix. */
  readonly tool: string;
  /** The tool's declared risk class. */
  readonly risk: Risk;
  /** Hosts this single action targets. */
  readonly hosts: readonly string[];
  /** Host aliases discovered in the SSH config. */
  readonly knownHosts: readonly string[];
  /** Actions already executed in this session. Denied actions do not count. */
  readonly session?: { readonly actionsUsed: number };
}

/** A verdict before it is turned into a `Decision`. */
type Verdict = 'allow' | 'approval' | 'deny';

/** Strictest last, so a higher index wins any comparison. */
const STRICTNESS: readonly Verdict[] = ['allow', 'approval', 'deny'];

function strictest(a: Verdict, b: Verdict): Verdict {
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}

/** The verdict a single rule states for a risk class, if it states one at all. */
function verdictOf(
  rule: Pick<HostRule, 'allow' | 'require_approval' | 'deny'>,
  risk: Risk,
): Verdict | undefined {
  // Precedence within one level: deny > require_approval > allow.
  if (rule.deny?.includes(risk)) return 'deny';
  if (rule.require_approval?.includes(risk)) return 'approval';
  if (rule.allow?.includes(risk)) return 'allow';
  return undefined;
}

/** The strictest override action whose host list matches. */
function overrideVerdict(override: ToolOverride, host: string): Verdict | undefined {
  if (override.deny_on && matchesAny(override.deny_on, host)) return 'deny';
  if (override.require_approval_on && matchesAny(override.require_approval_on, host)) {
    return 'approval';
  }
  if (override.allow_on && matchesAny(override.allow_on, host)) return 'allow';
  return undefined;
}

function deny(
  reason: string,
  rule: string,
  code: Extract<Decision, { kind: 'deny' }>['code'],
): Decision {
  return { kind: 'deny', reason, rule, code };
}

/**
 * Decides whether a tool may run on a host.
 *
 * The model never reaches this function's inputs except through validated tool
 * arguments, and nothing here consults the tool's description — a tool is
 * judged by its declared risk class, the policy file and the host.
 *
 * Evaluation order, which is also the order of the reasons it reports:
 *
 * 1. request shape — one action may not span more hosts than `max_hosts_per_action`
 * 2. the host must exist in the SSH config, and be covered by a policy rule
 * 3. `tools.never` — an absolute deny
 * 4. the destructive floor, which lives in code and no policy can lift
 * 5. the risk class, resolved most-specific-rule-first
 * 6. tool overrides, which may tighten anything and may only loosen approval
 * 7. the session budget
 *
 * A refusal by policy is reported ahead of an exhausted budget: the agent needs
 * to learn that an action is not permitted at all, not that it ran out of turns.
 */
export function evaluate(input: EvaluateInput): Decision {
  const { policy, tool, risk, hosts, knownHosts } = input;
  const limits = policy.limits;

  // 1 · Request shape.
  if (hosts.length === 0) {
    return deny('no host was given for this action', 'limits.max_hosts_per_action', 'HOST_LIMIT');
  }
  if (hosts.length > limits.max_hosts_per_action) {
    return deny(
      `this action targets ${hosts.length} hosts but the policy allows ${limits.max_hosts_per_action} per action`,
      'limits.max_hosts_per_action',
      'HOST_LIMIT',
    );
  }

  const host = hosts[0]!;

  // 2 · Host resolution.
  if (!knownHosts.includes(host)) {
    return deny(
      `host "${host}" is not in the SSH config, so Dwara has no way to reach it`,
      'ssh_config',
      'UNKNOWN_HOST',
    );
  }

  const hostRules = selectHostRules(policy.hosts, host);
  if (hostRules.length === 0) {
    return deny(
      `host "${host}" is not covered by any rule in the policy, so it is not managed by Dwara`,
      'policy.hosts',
      'UNMANAGED_HOST',
    );
  }

  // 3 · The never list. Nothing below can undo this.
  if (policy.tools.never.includes(tool)) {
    return deny(`"${tool}" is on the policy's never list`, 'tools.never', 'DENIED_BY_POLICY');
  }

  // 4 · The destructive floor. Deliberately not expressible in policy: the MVP
  // denies this class outright (CLAUDE.md), so a permissive or compromised
  // policy file cannot open it.
  if (risk === Risk.Destructive) {
    return deny(
      `"${tool}" is a destructive tool; that risk class is denied in this release and no policy can allow it`,
      'code:destructive-floor',
      'DESTRUCTIVE_DENIED',
    );
  }

  // 5 · The risk class. The most specific matching rules decide; ties among
  // them are merged strictest-first so document order cannot loosen anything.
  // The defaults only fill in classes no winning host rule mentions.
  let verdict: Verdict | undefined;
  let rule = '';

  for (const candidate of hostRules) {
    const stated = verdictOf(candidate, risk);
    if (stated === undefined) continue;
    if (verdict === undefined || strictest(verdict, stated) !== verdict) {
      rule = `hosts["${candidate.match}"]`;
    }
    verdict = verdict === undefined ? stated : strictest(verdict, stated);
  }

  if (verdict === undefined) {
    const fromDefaults = verdictOf(policy.defaults, risk);
    if (fromDefaults !== undefined) {
      verdict = fromDefaults;
      rule = 'defaults';
    }
  }

  if (verdict === undefined) {
    // Fail closed. Silence in a security policy is not permission.
    return deny(`no rule covers ${risk} actions on "${host}"`, 'policy', 'DENIED_BY_POLICY');
  }

  // 6 · Tool overrides. They may tighten freely; they may only loosen a
  // require_approval, never a deny and never the never list.
  const override = policy.tools.overrides[tool];
  if (override) {
    const stated = overrideVerdict(override, host);
    if (stated !== undefined && !(verdict === 'deny' && stated !== 'deny')) {
      verdict = stated;
      rule = `tools.overrides.${tool}`;
    }
  }

  if (verdict === 'deny') {
    return deny(`${rule} denies ${risk} actions on "${host}"`, rule, 'DENIED_BY_POLICY');
  }

  // 7 · Session budget, checked last so a refusal by policy is reported first.
  const actionsUsed = input.session?.actionsUsed ?? 0;
  if (actionsUsed >= limits.max_actions_per_session) {
    return deny(
      `this session has used its ${limits.max_actions_per_session} permitted actions`,
      'limits.max_actions_per_session',
      'SESSION_LIMIT',
    );
  }

  if (verdict === 'approval') {
    return {
      kind: 'approval',
      reason: `${rule} requires human approval for ${risk} actions on "${host}"`,
      rule,
    };
  }

  return { kind: 'allow', reason: `${rule} allows ${risk} actions on "${host}"`, rule };
}
