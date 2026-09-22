/**
 * Package identifier, used by the CLI's `doctor` output and by the audit log
 * so every entry records which build produced it.
 *
 * This package is a Phase 0 stub; its implementation lands in a later phase
 * (see `docs/PLAN.md`).
 */
export const PACKAGE_NAME = '@dwara/tools' as const;

/** Version of the Dwara toolchain this build belongs to. */
export const VERSION = '0.0.0' as const;
