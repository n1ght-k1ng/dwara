import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka, type Producer } from 'kafkajs';
import { config } from './config';

export type CheckResult = { ok: boolean; detail: string; latencyMs: number };

/** Owns the connections to the three backing services the lab app depends on. */
@Injectable()
export class DepsService implements OnModuleDestroy {
  private readonly logger = new Logger(DepsService.name);
  readonly pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
  });
  readonly redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  private readonly kafka = new Kafka({
    clientId: 'lab-app',
    brokers: config.kafkaBrokers,
    retry: { retries: 2, initialRetryTime: 200 },
  });
  private producer: Producer | undefined;

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
    this.redis.disconnect();
    await this.producer?.disconnect().catch(() => undefined);
  }

  /** Lazily connects the Kafka producer; the broker may start after the app. */
  async getProducer(): Promise<Producer> {
    if (!this.producer) {
      const producer = this.kafka.producer();
      await producer.connect();
      this.producer = producer;
    }
    return this.producer;
  }

  async checkPostgres(): Promise<CheckResult> {
    return timed(async () => {
      const { rows } = await this.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM orders',
      );
      return `${rows[0]?.count ?? '0'} orders`;
    });
  }

  async checkRedis(): Promise<CheckResult> {
    return timed(async () => {
      if (this.redis.status !== 'ready') await this.redis.connect().catch(() => undefined);
      const pong = await this.redis.ping();
      return `ping ${pong}`;
    });
  }

  async checkKafka(): Promise<CheckResult> {
    return timed(async () => {
      const admin = this.kafka.admin();
      await admin.connect();
      try {
        const topics = await admin.listTopics();
        return `${topics.length} topics`;
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    });
  }

  /** Fails the process if Postgres is unreachable at boot, the way a real service would. */
  async assertPostgresAtBoot(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.logger.log('postgres reachable');
  }
}

async function timed(fn: () => Promise<string>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, latencyMs: Date.now() - started };
  }
}
