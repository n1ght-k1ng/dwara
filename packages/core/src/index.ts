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

export { quoteArgv, assertSafeArg } from './ssh/escape.js';
export { parseSshConfig, resolveHost } from './ssh/config.js';
export type { SshConfig, SshHostBlock, ResolvedHost } from './ssh/config.js';
export { SshTransport, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from './ssh/transport.js';
export type { TransportOptions } from './ssh/transport.js';

export { Redactor, defaultRedactor } from './redact/redact.js';
export type { RedactionReport, RedactorOptions } from './redact/redact.js';
export { shannonEntropy, looksLikeSecret, findEntropySecrets } from './redact/entropy.js';
export { RULES as REDACTION_RULES } from './redact/patterns.js';
export type { RedactionRule } from './redact/patterns.js';

export { wrap, findSuspicions } from './envelope.js';
export type { Envelope, Suspicion, SuspicionKind, WrapOptions } from './envelope.js';

export { AuditLog, DEFAULT_AUDIT_PATH } from './audit/log.js';
export type { AuditLogOptions } from './audit/log.js';
export { verifyChain } from './audit/verify.js';
export type { ChainReport, ChainProblem } from './audit/verify.js';
export { auditEntrySchema, canonicalise, hashEntry, GENESIS_HASH } from './audit/entry.js';
export type { AuditEntry, AuditInput } from './audit/entry.js';
