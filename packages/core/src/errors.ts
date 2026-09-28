/**
 * Every failure Dwara can produce, as a closed set.
 *
 * Tools never throw raw errors at the MCP layer (see `CLAUDE.md`): each failure
 * is mapped onto one of these codes so the client, the audit log and the eval
 * harness can all reason about it without parsing prose.
 */
export type DwaraErrorCode =
  // Policy and configuration
  | 'POLICY_NOT_FOUND'
  | 'POLICY_INVALID'
  | 'UNKNOWN_HOST'
  | 'UNMANAGED_HOST'
  | 'SSH_CONFIG_INVALID'
  // Refusals; the action never ran
  | 'DENIED_BY_POLICY'
  | 'DESTRUCTIVE_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'SESSION_LIMIT'
  | 'HOST_LIMIT'
  // Transport
  | 'UNSAFE_ARGUMENT'
  | 'SSH_CONNECT_FAILED'
  | 'SUDO_PASSWORD_REQUIRED'
  | 'TIMEOUT'
  | 'COMMAND_FAILED'
  // Mutations. Each names a distinct point on the transactional path, because
  // "the change failed" and "the change failed and could not be undone" are not
  // the same situation for whoever reads the result.
  | 'SNAPSHOT_FAILED'
  | 'VALIDATOR_FAILED'
  | 'VERIFY_FAILED'
  | 'ROLLBACK_FAILED'
  | 'PLAN_MISMATCH'
  // Everything else
  | 'INTERNAL';

/** Extra context attached to an error: short, structured, safe to log. */
export type DwaraErrorDetails = Record<string, string | number | boolean | string[]>;

/**
 * A typed Dwara failure.
 *
 * `hint` is advice for a human — the sudoers line to add, the command to run —
 * and is shown by the CLI. It is never instructions for the model to follow.
 */
export class DwaraError extends Error {
  readonly code: DwaraErrorCode;
  readonly details: DwaraErrorDetails;
  readonly hint: string | undefined;

  constructor(
    code: DwaraErrorCode,
    message: string,
    options: { details?: DwaraErrorDetails; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DwaraError';
    this.code = code;
    this.details = options.details ?? {};
    this.hint = options.hint;
  }

  /** True when `value` is a DwaraError, including across module instances. */
  static is(value: unknown): value is DwaraError {
    return value instanceof DwaraError || (value instanceof Error && value.name === 'DwaraError');
  }

  /** Wraps anything thrown into a DwaraError, preserving one that already is. */
  static from(value: unknown, code: DwaraErrorCode = 'INTERNAL'): DwaraError {
    if (value instanceof DwaraError) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new DwaraError(code, message, { cause: value });
  }

  /** Plain object for the audit log and for MCP error payloads. */
  toJSON(): { code: DwaraErrorCode; message: string; details: DwaraErrorDetails; hint?: string } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}
