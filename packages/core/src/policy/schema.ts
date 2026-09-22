import { z } from 'zod';
import { Risk } from '../types.js';

/**
 * Schema for `.dwara/policy.yaml`.
 *
 * Every object is strict. A misspelled key in a security policy must fail
 * loudly: silently ignoring `requre_approval` would leave the author believing
 * a restriction is in force when it is not.
 */

const riskSchema = z.enum(Risk, {
  error: () => `must be one of: ${Object.values(Risk).join(', ')}`,
});

const riskList = z.array(riskSchema).readonly();

/** A host glob such as `prod-*`, or a literal alias. */
const hostPattern = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

const healthCheckSchema = z
  .object({
    http: z.url(),
    expect_status: z.number().int().min(100).max(599).default(200),
  })
  .strict();

const riskBucketsSchema = {
  allow: riskList.optional(),
  require_approval: riskList.optional(),
  deny: riskList.optional(),
};

const hostRuleSchema = z
  .object({
    match: hostPattern,
    tags: z.array(z.string().min(1)).readonly().optional(),
    health_checks: z.array(healthCheckSchema).readonly().optional(),
    ...riskBucketsSchema,
  })
  .strict();

const toolOverrideSchema = z
  .object({
    allow_on: z.array(hostPattern).readonly().optional(),
    require_approval_on: z.array(hostPattern).readonly().optional(),
    deny_on: z.array(hostPattern).readonly().optional(),
  })
  .strict();

export const policySchema = z
  .object({
    version: z.literal(1, { error: () => 'unsupported policy version; expected 1' }),
    defaults: z
      .object(riskBucketsSchema)
      .strict()
      .default({ allow: [Risk.Read], require_approval: [Risk.Reversible, Risk.Config], deny: [] }),
    hosts: z
      .array(hostRuleSchema)
      .readonly()
      .default([])
      .superRefine((rules, ctx) => {
        const seen = new Set<string>();
        rules.forEach((rule, index) => {
          if (seen.has(rule.match)) {
            ctx.addIssue({
              code: 'custom',
              path: [index, 'match'],
              message: `duplicate host pattern "${rule.match}"; merge the rules instead`,
            });
          }
          seen.add(rule.match);
        });
      }),
    tools: z
      .object({
        /** Tool names that are denied everywhere, whatever else the policy says. */
        never: z.array(z.string().min(1)).readonly().default([]),
        overrides: z.record(z.string().min(1), toolOverrideSchema).default({}),
      })
      .strict()
      .default({ never: [], overrides: {} }),
    redaction: z
      .object({
        extra_patterns: z.array(z.string().min(1)).readonly().default([]),
      })
      .strict()
      .default({ extra_patterns: [] }),
    limits: z
      .object({
        max_actions_per_session: z.number().int().positive().default(20),
        max_hosts_per_action: z.number().int().positive().default(1),
      })
      .strict()
      .default({ max_actions_per_session: 20, max_hosts_per_action: 1 }),
  })
  .strict();

export type Policy = z.output<typeof policySchema>;
export type HostRule = Policy['hosts'][number];
export type ToolOverride = z.output<typeof toolOverrideSchema>;
