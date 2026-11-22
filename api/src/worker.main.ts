import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { productionDeps } from './bootstrap';
import { loadConfig } from './config';

/** Worker-only process: no HTTP server; scales horizontally on queue depth (KEDA in k8s). */
async function bootstrap() {
  const cfg = loadConfig();
  // Workers run the housekeeping sweep unless explicitly disabled; one replica is enough, more is harmless.
  const config = { ...cfg, scheduler: { ...cfg.scheduler, enabled: process.env.SCHEDULER_ENABLED === undefined ? true : cfg.scheduler.enabled } };
  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(await productionDeps(config, 'worker')));
  ctx.enableShutdownHooks();
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
