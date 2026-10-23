import { ToolRegistry, packageVersion } from '@dwara/core';

export { hostOverview } from './host-overview.js';
export { serviceStatus } from './service-status.js';
export { tailLogs } from './tail-logs.js';
export { diskUsage } from './disk-usage.js';
export { openPorts } from './open-ports.js';
export { dockerPs } from './docker-ps.js';
export { containerLogs } from './container-logs.js';
export { containerInspect } from './container-inspect.js';
export { certExpiry } from './cert-expiry.js';
export { readConfig } from './read-config.js';
export { securityAudit } from './security-audit.js';
export {
  PROTECTED_UNITS,
  RESTART_TIMEOUT_MS,
  createRestartService,
  restartService,
} from './restart-service.js';
export type { RestartResult, RestartServiceOptions, UnitReading } from './restart-service.js';
export {
  PROTECTED_CONTAINERS,
  createRestartContainer,
  restartContainer,
} from './restart-container.js';
export type {
  ContainerReading,
  RestartContainerOptions,
  RestartContainerResult,
} from './restart-container.js';
export { createRotateLogs, rotateLogs } from './rotate-logs.js';
export type { RotateLogsOptions, RotateLogsResult, RotatedFile } from './rotate-logs.js';
export { createPruneImages, pruneImages } from './prune-images.js';
export type { DanglingImage, PruneImagesOptions, PruneImagesResult } from './prune-images.js';
export { UNEDITABLE_PATHS, createEditConfig, editConfig } from './edit-config.js';
export type { EditConfigOptions, EditConfigResult } from './edit-config.js';
export { applyDiff, parseDiff, summariseDiff } from './diff.js';
export { createRollback, rollback } from './rollback.js';
export type { RollbackOptions, RollbackResult } from './rollback.js';

export { DENIED_PATHS, DEFAULT_CONFIG_PATHS, DEFAULT_LOG_PATHS, guardPath } from './paths.js';

import { hostOverview } from './host-overview.js';
import { serviceStatus } from './service-status.js';
import { tailLogs } from './tail-logs.js';
import { diskUsage } from './disk-usage.js';
import { openPorts } from './open-ports.js';
import { dockerPs } from './docker-ps.js';
import { containerLogs } from './container-logs.js';
import { containerInspect } from './container-inspect.js';
import { certExpiry } from './cert-expiry.js';
import { readConfig } from './read-config.js';
import { securityAudit } from './security-audit.js';
import { restartService } from './restart-service.js';
import { restartContainer } from './restart-container.js';
import { rotateLogs } from './rotate-logs.js';
import { pruneImages } from './prune-images.js';
import { editConfig } from './edit-config.js';
import { rollback } from './rollback.js';

/**
 * A registry holding every tool in this release.
 *
 * The registry refuses any mutating tool that does not define snapshot, verify
 * and rollback, so a change Dwara cannot undo never becomes callable.
 */
export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(hostOverview);
  registry.register(serviceStatus);
  registry.register(tailLogs);
  registry.register(diskUsage);
  registry.register(openPorts);
  registry.register(dockerPs);
  registry.register(containerLogs);
  registry.register(containerInspect);
  registry.register(certExpiry);
  registry.register(readConfig);
  registry.register(securityAudit);

  registry.register(restartService);
  registry.register(restartContainer);
  registry.register(rotateLogs);
  registry.register(pruneImages);

  registry.register(editConfig);
  registry.register(rollback);

  return registry;
}

/** Package identifier, recorded in audit entries so each one names its build. */
export const PACKAGE_NAME = '@dwara/tools' as const;

/**
 * Version of the Dwara toolchain this build belongs to.
 *
 * Read from the nearest `package.json` rather than written here, so the
 * published binaries cannot report a version the package does not have.
 */
export const VERSION: string = packageVersion(import.meta.url);
