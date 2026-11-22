import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { BatchService } from './batches';
import { loadConfig } from './config';
import { AutoDrainQueue, COLLECTIONS, demoBriefs, SimulatedClient } from './demo';
import { GlossaryService } from './glossary.service';
import { MemoryStore } from './memory';

/**
 * `npm run demo`: the API with a simulated model, an in-memory store and a self-draining queue, seeded
 * with two batches. Then run the review app (`cd review && npm run dev`) and open http://localhost:3002.
 *
 * There is no SSO gateway in the demo, so requests without x-user get a demo user with every role.
 */
async function main() {
  const base = loadConfig();
  const config = { ...base, promptCache: true, scheduler: { enabled: true, intervalMs: 10_000 }, leaseMs: 10 * 60_000 };
  const queue = new AutoDrainQueue();
  const client = new SimulatedClient(Number(process.env.DEMO_LATENCY_MS ?? 120));
  const app = await NestFactory.create(AppModule.forRoot({ client, queue, store: new MemoryStore(), config, policy: config.policy }), { logger: ['error', 'warn', 'log'] });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.headers['x-user']) {
      req.headers['x-user'] = process.env.DEMO_USER ?? 'demo';
      req.headers['x-roles'] = 'editor,reviewer,publisher,admin';
    }
    next();
  });
  app.enableShutdownHooks();
  await app.listen(config.port);

  const glossary = app.get(GlossaryService);
  for (const c of COLLECTIONS) await glossary.add({ locale: '*', term: c, kind: 'keep', caseSensitive: true, note: 'collection name' }, 'demo');
  await glossary.add({ locale: 'en-US', term: 'luxurious', kind: 'forbidden', replacement: 'soft', note: 'legal asked us to avoid it' }, 'demo');
  await glossary.add({ locale: 'fr-CA', term: 'e-mail', kind: 'preferred', replacement: 'courriel' }, 'demo');

  const batches = app.get(BatchService);
  const briefs = demoBriefs(Number(process.env.DEMO_SKUS ?? 40));
  const half = Math.ceil(briefs.length / 2 / 3) * 3; // keep each SKU's three locales together
  await batches.create(briefs.slice(0, half), 'demo', { name: 'Spring collection' });
  await batches.create(briefs.slice(half), 'demo', { name: 'Kitchen and decor refresh' });

  console.log(`ContentLoom demo API on http://localhost:${config.port} with ${briefs.length} items generating.`);
  console.log('Start the review app with: cd review && npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
