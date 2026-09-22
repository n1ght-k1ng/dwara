import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DepsService, type CheckResult } from './deps.service';

const startedAt = Date.now();

@Controller()
export class HealthController {
  constructor(private readonly deps: DepsService) {}

  /** Liveness only: the process is up. Nginx uses this to tell "app down" from "dependency down". */
  @Get('/live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness across all three dependencies; 503 when any of them is unhealthy. */
  @Get('/health')
  async health(@Res() res: Response): Promise<void> {
    const [postgres, redis, kafka] = await Promise.all([
      this.deps.checkPostgres(),
      this.deps.checkRedis(),
      this.deps.checkKafka(),
    ]);

    const checks: Record<string, CheckResult> = { postgres, redis, kafka };
    const healthy = Object.values(checks).every((c) => c.ok);

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      checks,
    });
  }
}
