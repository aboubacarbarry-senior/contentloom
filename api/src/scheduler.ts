import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import { normalizeItem, reviewSpan, transition } from './domain';
import { StaleWriteError } from './errors';
import { EventBus } from './events';
import { OutboxService } from './outbox';
import { JobQueue, MAX_ATTEMPTS } from './queue';
import { Store, STORE } from './repository';
import { CLOCK, CONFIG, JOB_QUEUE } from './tokens';

export interface SweepResult {
  requeued: number;
  failed: number;
  leasesExpired: number;
  overdue: number;
  outbox: { claimed: number; delivered: number; retried: number; dead: number };
}

/**
 * Housekeeping that must happen even when nobody calls the API:
 *  - items stuck in `generating` (a worker died mid-call) go back to the queue, or fail after MAX_ATTEMPTS;
 *  - expired review leases are cleared so the queue shows them as free;
 *  - the webhook outbox is dispatched.
 * Runs on an interval when SCHEDULER_ENABLED is set; `sweep()` is also callable directly (tests, cron).
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly log = new Logger('Scheduler');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly outbox: OutboxService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    if (!this.config.scheduler.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.scheduler.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow sweep must not overlap the next one
    this.running = true;
    try {
      const r = await this.sweep();
      if (r.requeued || r.failed || r.leasesExpired || r.overdue || r.outbox.claimed) this.log.log(JSON.stringify(r));
    } catch (e) {
      this.log.error(`sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async sweep(): Promise<SweepResult> {
    const stuck = await this.recoverStuck();
    const leasesExpired = await this.expireLeases();
    const overdue = await this.flagOverdue();
    const outbox = await this.outbox.dispatch();
    return { ...stuck, leasesExpired, overdue, outbox };
  }

  /** Items announced as overdue in this process, so each one is announced once per stay in review. */
  private readonly announced = new Map<string, string>();

  /**
   * Announce drafts that have waited in review longer than the SLA (the review app shows a banner and
   * the team channel bot posts them). Returns how many crossed the line since the last sweep.
   */
  async flagOverdue(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    const stillWaiting = new Set<string>();
    for await (const item of this.store.items.scan({ status: ['in_review'] })) {
      const span = reviewSpan(item);
      if (!span) continue;
      stillWaiting.add(item.id);
      if (now.getTime() - Date.parse(span.enteredAt) <= this.config.reviewSlaMs) continue;
      if (this.announced.get(item.id) === span.enteredAt) continue;
      this.announced.set(item.id, span.enteredAt);
      this.events.publish({ type: 'review.overdue', itemId: item.id, batchId: item.batchId, sku: item.brief.sku, enteredAt: span.enteredAt, at: now.toISOString() });
      n++;
    }
    for (const id of [...this.announced.keys()]) if (!stillWaiting.has(id)) this.announced.delete(id);
    return n;
  }

  async recoverStuck(): Promise<{ requeued: number; failed: number }> {
    const now = this.clock.now();
    const before = new Date(now.getTime() - this.config.stuckGeneratingMs).toISOString();
    let requeued = 0;
    let failed = 0;
    for (const item of await this.store.items.stuck('generating', before)) {
      const working = normalizeItem(item);
      const giveUp = working.attempts >= MAX_ATTEMPTS;
      transition(working, giveUp ? 'failed' : 'queued', 'scheduler', now, giveUp ? 'stuck in generating after the last attempt' : 'worker stopped responding');
      if (giveUp) working.lastError = working.lastError ?? 'generation timed out';
      try {
        await this.store.items.save(working);
      } catch (e) {
        if (e instanceof StaleWriteError) continue; // the worker came back and finished it
        throw e;
      }
      this.events.publish({ type: 'item.status', itemId: working.id, batchId: working.batchId, from: 'generating', to: working.status, by: 'scheduler', at: now.toISOString() });
      if (giveUp) failed++;
      else {
        await this.queue.add(working.id);
        requeued++;
      }
    }
    return { requeued, failed };
  }

  async expireLeases(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for await (const item of this.store.items.scan({ status: ['in_review'] })) {
      if (!item.lease || Date.parse(item.lease.expiresAt) > now.getTime()) continue;
      const reviewer = item.lease.reviewer;
      try {
        await this.store.items.save({ ...item, lease: null });
      } catch (e) {
        if (e instanceof StaleWriteError) continue;
        throw e;
      }
      this.events.publish({ type: 'item.released', itemId: item.id, reviewer, at: now.toISOString() });
      n++;
    }
    return n;
  }
}
