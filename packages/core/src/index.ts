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
