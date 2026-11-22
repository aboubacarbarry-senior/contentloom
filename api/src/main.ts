import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { productionDeps } from './bootstrap';
import { loadConfig } from './config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(await productionDeps(cfg, 'api')), {
    logger: cfg.logLevel === 'debug' ? ['error', 'warn', 'log', 'debug'] : cfg.logLevel === 'info' ? ['error', 'warn', 'log'] : cfg.logLevel === 'warn' ? ['error', 'warn'] : ['error'],
  });
  app.enableShutdownHooks();
  await app.listen(cfg.port);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
