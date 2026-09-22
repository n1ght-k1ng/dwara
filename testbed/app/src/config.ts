export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://labapp:labpass@lab-db:5432/labdb',
  redisUrl: process.env.REDIS_URL ?? 'redis://lab-cache:6379',
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'lab-queue:9092').split(','),
  kafkaTopic: process.env.KAFKA_TOPIC ?? 'lab.orders',
};
