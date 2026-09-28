import { z } from 'zod';
import { Risk, type BuiltToolDef } from '@dwara/core';
import { READ_TIMEOUT_MS, at, hostField, keyValues, toNumber } from './common.js';

const serviceInput = z
  .object({
    host: hostField,
    unit: z
      .string()
      .min(1)
      .describe('Unit name, with or without the .service suffix, e.g. "nginx" or "nginx.service".'),
  })
  .strict();
type ServiceInput = z.output<typeof serviceInput>;

export interface ServiceStatus {
  readonly unit: string;
  /** False when systemd has never heard of the unit. */
  readonly exists: boolean;
  readonly description: string;
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly enabled: string;
  readonly mainPid: number | undefined;
  readonly restarts: number | undefined;
  readonly startedAt: string | undefined;
  readonly result: string;
  /** A short read of the numbers above, so the obvious cases are not missed. */
  readonly assessment: string;
}

const SHOW_PROPERTIES = [
  'Id',
  'Description',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'NRestarts',
  'ExecMainStartTimestamp',
  'Result',
].join(',');

/**
 * The state of one systemd unit.
 *
 * `NRestarts` is the field that matters most and the one people forget to look
 * at: a unit in a restart loop reports `active` at the instant you ask, because
 * it has just been started again.
 */
export const serviceStatus: BuiltToolDef<ServiceInput, ServiceStatus> = {
  name: 'service_status',
  risk: Risk.Read,
  description: [
    'State of a single systemd unit: active state, sub state, whether it is enabled,',
    'its main PID, how many times it has been restarted, when it last started, and',
    'the result of its last run.',
    '',
    'Check `restarts` before concluding a unit is healthy. A unit in a crash loop',
    'reports activeState "active" at the moment you ask, because systemd has just',
    'started it again — a climbing restart count is the tell. Call this tool twice a',
    'few seconds apart to see it move.',
    '',
    'If `exists` is false the unit name is wrong; use host_overview to list failed',
    "units. When `restarts` is high, read the unit's own logs with tail_logs to find",
    'out why it keeps dying.',
  ].join('\n'),
  input: serviceInput,

  build: (params) => [
    {
      argv: [
        'systemctl',
        'show',
        unitName(params.unit),
        '--no-pager',
        `--property=${SHOW_PROPERTIES}`,
      ],
      sudo: true,
      timeoutMs: READ_TIMEOUT_MS,
    },
  ],

  parse: (raws) => {
    const fields = keyValues(at(raws, 0).stdout);
    const loadState = fields['LoadState'] ?? 'unknown';
    const activeState = fields['ActiveState'] ?? 'unknown';
    const subState = fields['SubState'] ?? 'unknown';
    const restarts = toNumber(fields['NRestarts']);
    const mainPid = toNumber(fields['MainPID']);

    return {
      unit: fields['Id'] ?? '',
      exists: loadState !== 'not-found',
      description: fields['Description'] ?? '',
      loadState,
      activeState,
      subState,
      enabled: fields['UnitFileState'] ?? '',
      // MainPID is 0 for a unit that is not running; that is absence, not a pid.
      ...(mainPid === undefined || mainPid === 0 ? { mainPid: undefined } : { mainPid }),
      restarts,
      startedAt: fields['ExecMainStartTimestamp'] || undefined,
      result: fields['Result'] ?? '',
      assessment: assess(loadState, activeState, subState, restarts),
    };
  },
};

function unitName(unit: string): string {
  return /\.(service|socket|timer|target|mount|path|slice)$/.test(unit) ? unit : `${unit}.service`;
}

function assess(
  loadState: string,
  activeState: string,
  subState: string,
  restarts: number | undefined,
): string {
  if (loadState === 'not-found') return 'no such unit on this host';
  if (loadState === 'masked') return 'masked, so it cannot start until it is unmasked';
  if (activeState === 'failed') return 'failed; read its logs for the reason';
  if ((restarts ?? 0) > 3) {
    return `restarted ${restarts} times, which looks like a crash loop rather than a healthy service`;
  }
  if (activeState === 'activating') return 'still starting up';
  if (activeState === 'inactive') return 'not running';
  if (activeState === 'active' && subState === 'running') return 'running normally';
  return `${activeState} (${subState})`;
}
