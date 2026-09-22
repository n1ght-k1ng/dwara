import { Module } from '@nestjs/common';
import { DepsService } from './deps.service';
import { HealthController } from './health.controller';
import { OrdersController } from './orders.controller';

@Module({
  controllers: [HealthController, OrdersController],
  providers: [DepsService],
})
export class AppModule {}
