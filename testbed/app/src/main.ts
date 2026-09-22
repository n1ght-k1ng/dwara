import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { DepsService } from './deps.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  const app = await NestFactory.create(AppModule);

  // A service that cannot reach its database should not report itself healthy;
  // it should die and let the supervisor restart it. This is what makes the
  // api-crash-loop scenario behave like a real incident.
  const deps = app.get(DepsService);
  try {
    await deps.assertPostgresAtBoot();
  } catch (err) {
    logger.error(`database unreachable at boot: ${(err as Error).message}`);
    await app.close();
    process.exit(1);
  }

  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  logger.log(`lab app listening on :${config.port}`);
}

void bootstrap();
