import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import type { AppDeps } from './app.module';
import type { AppConfig } from './config';
import { MemoryStore } from './memory';
import { pending } from './migrate';
import { PostgresStore } from './postgres';
import { BullQueue } from './queue';
import type { Store } from './repository';

/**
 * Shared wiring for the API and worker processes: Postgres when DATABASE_URL is set (in-memory
 * otherwise, for local demos), BullMQ on Redis, and the Anthropic client from the environment.
 */
export async function productionDeps(cfg: AppConfig, role: 'api' | 'worker'): Promise<AppDeps> {
  const log = new Logger('Bootstrap');
  let store: Store;
  if (cfg.databaseUrl) {
    const pg = PostgresStore.connect(cfg.databaseUrl);
    const todo = await pending(pg.pool);
    if (todo.length) throw new Error(`database has unapplied migrations (${todo.join(', ')}); run "npm run migrate" first`);
    store = pg;
  } else {
    if (role === 'worker') throw new Error('workers need DATABASE_URL: an in-memory store is not shared with the API process');
    log.warn('DATABASE_URL is not set; using an in-memory store (data is lost on restart)');
    store = new MemoryStore();
  }
  // The API process only enqueues; worker processes consume. Both share the same queue name.
  const queue = new BullQueue(cfg.redis, 'contentloom-generate', 8, { consume: role === 'worker' || !cfg.databaseUrl });
  return { client: new Anthropic(), queue, store, config: cfg, policy: cfg.policy };
}
