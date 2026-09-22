import { Body, Controller, Get, Post } from '@nestjs/common';
import { config } from './config';
import { DepsService } from './deps.service';

type CreateOrder = { sku?: string; quantity?: number };

/** Writes touch all three dependencies, so a broken one shows up in real traffic. */
@Controller('orders')
export class OrdersController {
  constructor(private readonly deps: DepsService) {}

  @Get()
  async list(): Promise<{ orders: unknown[]; cached: boolean }> {
    const cached = await this.deps.redis.get('orders:latest').catch(() => null);
    if (cached) return { orders: JSON.parse(cached) as unknown[], cached: true };

    const { rows } = await this.deps.pool.query('SELECT id, sku, quantity, created_at FROM orders ORDER BY id DESC LIMIT 20');
    await this.deps.redis.set('orders:latest', JSON.stringify(rows), 'EX', 10).catch(() => undefined);
    return { orders: rows, cached: false };
  }

  @Post()
  async create(@Body() body: CreateOrder): Promise<{ id: number }> {
    const sku = body.sku ?? 'LAB-SKU';
    const quantity = body.quantity ?? 1;

    const { rows } = await this.deps.pool.query<{ id: number }>(
      'INSERT INTO orders (sku, quantity) VALUES ($1, $2) RETURNING id',
      [sku, quantity],
    );
    const id = rows[0]!.id;

    await this.deps.redis.del('orders:latest').catch(() => undefined);

    const producer = await this.deps.getProducer();
    await producer.send({
      topic: config.kafkaTopic,
      messages: [{ key: String(id), value: JSON.stringify({ id, sku, quantity }) }],
    });

    return { id };
  }
}
