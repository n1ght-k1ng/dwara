export { DwaraError } from './errors.js';
export type { DwaraErrorCode, DwaraErrorDetails } from './errors.js';

export { Risk, RISK_ORDER } from './types.js';
export type {
  Ctx,
  Decision,
  RawResult,
  RemoteCommand,
  SnapshotRef,
  SnapshotSpec,
  ToolDef,
  ToolResult,
  VerifyResult,
} from './types.js';

/** Package identifier, recorded in audit entries so each one names its build. */
export const PACKAGE_NAME = '@dwara/core' as const;

/** Version of the Dwara toolchain this build belongs to. */
export const VERSION = '0.0.0' as const;

export { loadPolicy, parsePolicy, DEFAULT_POLICY_PATH } from './policy/load.js';
export type { LoadedPolicy } from './policy/load.js';
export { policySchema } from './policy/schema.js';
export type { Policy, HostRule, ToolOverride } from './policy/schema.js';
export { matchesHost, matchesAny, selectHostRules, specificity } from './policy/match.js';
export { evaluate } from './policy/evaluate.js';
export type { EvaluateInput } from './policy/evaluate.js';
