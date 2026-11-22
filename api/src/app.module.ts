import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AuditService } from './audit';
import { BatchService } from './batches';
import { Clock, systemClock } from './clock';
import { AppConfig, defaultConfig } from './config';
import { AdminController } from './controllers/admin.controller';
import { BatchesController } from './controllers/batches.controller';
import { ItemsController } from './controllers/items.controller';
import { ReviewController } from './controllers/review.controller';
import { SkusController } from './controllers/skus.controller';
import { SystemController } from './controllers/system.controller';
import { ConsistencyService } from './consistency';
import type { RoutingPolicy } from './domain';
import { DomainErrorFilter } from './errors';
import { EventBus } from './events';
import { ExportService } from './exports';
import { GlossaryService } from './glossary.service';
import { MemoryStore } from './memory';
import { MetricsService } from './metrics';
import { OutboxService } from './outbox';
import { PolicyService } from './policy';
import type { JobQueue } from './queue';
import { Store, STORE } from './repository';
import { ReviewService } from './review';
import { SchedulerService } from './scheduler';
import { ContentService } from './service';
import { BUDGET, CLOCK, CONFIG, FETCH, FetchFn, JOB_QUEUE, LLM_CLIENT, POLICY, RANDOM } from './tokens';
import { BudgetGuard } from './usage';

export interface AppDeps {
  /** Anthropic client (or a fake with the same `beta.messages.create`). */
  client: unknown;
  queue: JobQueue;
  policy?: RoutingPolicy;
  random?: () => number;
  store?: Store;
  clock?: Clock;
  config?: AppConfig;
  fetch?: FetchFn;
}

/** Closes the queue and the database pool when Nest shuts down (SIGTERM in Kubernetes). */
@Injectable()
class ShutdownHooks implements OnApplicationShutdown {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close?.();
    await this.store.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    const config = deps.config ?? defaultConfig();
    const policy = deps.policy ?? config.policy;
    const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    return {
      module: AppModule,
      controllers: [BatchesController, ItemsController, ReviewController, AdminController, SystemController, SkusController],
      providers: [
        ContentService,
        BatchService,
        ReviewService,
        MetricsService,
        ExportService,
        GlossaryService,
        PolicyService,
        AuditService,
        OutboxService,
        SchedulerService,
        ConsistencyService,
        EventBus,
        ShutdownHooks,
        { provide: LLM_CLIENT, useValue: deps.client },
        { provide: JOB_QUEUE, useValue: deps.queue },
        { provide: POLICY, useValue: policy },
        { provide: RANDOM, useValue: deps.random ?? Math.random },
        { provide: STORE, useValue: deps.store ?? new MemoryStore() },
        { provide: CLOCK, useValue: deps.clock ?? systemClock },
        { provide: CONFIG, useValue: config },
        { provide: FETCH, useValue: fetchFn },
        {
          provide: BUDGET,
          useFactory: (store: Store, clock: Clock, cfg: AppConfig) => new BudgetGuard(store.ledger, clock, cfg.dailyBudgetUsd),
          inject: [STORE, CLOCK, CONFIG],
        },
        { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
