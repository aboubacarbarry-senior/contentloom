import { DelayedError, Queue, Worker } from 'bullmq';

export const MAX_ATTEMPTS = 4;

/** What a job handler can ask for besides success: run again later without using up an attempt. */
export type JobOutcome = void | { retryAt: Date };
export type JobHandler = (itemId: string, attempt: number) => Promise<JobOutcome>;

export interface QueueStats {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
}

/** Job queue seam: BullMQ on Redis in production, in-process for tests and local dev. */
export interface JobQueue {
  add(itemId: string, opts?: { delayMs?: number; priority?: number }): Promise<void>;
  process(handler: JobHandler): void;
  drain?(): Promise<void>;
  stats?(): Promise<QueueStats>;
  close?(): Promise<void>;
}

export class BullQueue implements JobQueue {
  private q: Queue;
  private worker?: Worker;

  constructor(
    private connection: { host: string; port: number },
    private name = 'contentloom-generate',
    private concurrency = 8,
    private readonly opts: { consume: boolean } = { consume: true },
  ) {
    this.q = new Queue(name, { connection });
  }

  async add(itemId: string, opts: { delayMs?: number; priority?: number } = {}) {
    // jobId = itemId: re-enqueueing an item that's already waiting is a no-op (no duplicate generations).
    // A finished job with the same id is removed first, so revisions and retries of failed items run again.
    const existing = await this.q.getJob(itemId);
    if (existing && ((await existing.isCompleted()) || (await existing.isFailed()))) await existing.remove();
    await this.q.add('generate', { itemId }, {
      jobId: itemId, delay: opts.delayMs, priority: opts.priority,
      attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000,
    });
  }

  process(handler: JobHandler) {
    // API processes only enqueue; consuming there would compete with the dedicated workers.
    if (!this.opts.consume) return;
    // Concurrency + a global rate limit keep us under the model API's rate limits across all workers.
    this.worker = new Worker(
      this.name,
      async (job, token) => {
        const outcome = await handler(job.data.itemId, job.attemptsMade + 1);
        if (outcome && 'retryAt' in outcome) {
          // Budget exhausted: park the job without counting an attempt.
          await job.moveToDelayed(outcome.retryAt.getTime(), token);
          throw new DelayedError();
        }
      },
      { connection: this.connection, concurrency: this.concurrency, limiter: { max: 50, duration: 60_000 } },
    );
  }

  async stats(): Promise<QueueStats> {
    const c = await this.q.getJobCounts('waiting', 'delayed', 'active', 'failed', 'prioritized');
    return { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), delayed: c.delayed ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 };
  }

  async close() {
    await this.worker?.close();
    await this.q.close();
  }
}

interface MemoryJob {
  itemId: string;
  priority: number;
  readyAt: number;
  seq: number;
}

/**
 * In-process queue for tests and local dev. Mirrors the BullMQ behaviour the service relies on:
 * de-duplication by item id, priorities (lower runs first), retries up to MAX_ATTEMPTS, and delayed jobs
 * that only run once the clock passes their time.
 */
export class MemoryQueue implements JobQueue {
  private pending: MemoryJob[] = [];
  private handler?: JobHandler;
  private attempts = new Map<string, number>();
  private seq = 0;
  private active = 0;
  private failedIds = new Set<string>();
  readonly maxAttempts = MAX_ATTEMPTS;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async add(itemId: string, opts: { delayMs?: number; priority?: number } = {}) {
    const existing = this.pending.find((j) => j.itemId === itemId);
    if (existing) return;
    this.failedIds.delete(itemId);
    // A re-added item (revision, retry of a failed item) starts with fresh attempts, like a new BullMQ job.
    this.attempts.delete(itemId);
    this.pending.push({ itemId, priority: opts.priority ?? 10, readyAt: this.now() + (opts.delayMs ?? 0), seq: this.seq++ });
  }

  process(handler: JobHandler) {
    this.handler = handler;
  }

  private nextReady(): MemoryJob | undefined {
    const t = this.now();
    let best: MemoryJob | undefined;
    for (const j of this.pending) {
      if (j.readyAt > t) continue;
      if (!best || j.priority < best.priority || (j.priority === best.priority && j.seq < best.seq)) best = j;
    }
    return best;
  }

  /** Run until no job is ready (tests). Retries failed jobs like BullMQ's `attempts`. */
  async drain() {
    for (let job = this.nextReady(); job; job = this.nextReady()) {
      this.pending.splice(this.pending.indexOf(job), 1);
      const id = job.itemId;
      const attempt = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, attempt);
      this.active++;
      try {
        const outcome = await this.handler!(id, attempt);
        if (outcome && 'retryAt' in outcome) {
          this.attempts.set(id, attempt - 1);
          this.pending.push({ itemId: id, priority: job.priority, readyAt: outcome.retryAt.getTime(), seq: this.seq++ });
        }
      } catch {
        if (attempt < this.maxAttempts) this.pending.push({ itemId: id, priority: job.priority, readyAt: this.now(), seq: this.seq++ });
        else this.failedIds.add(id);
      } finally {
        this.active--;
      }
    }
  }

  async stats(): Promise<QueueStats> {
    const t = this.now();
    return {
      waiting: this.pending.filter((j) => j.readyAt <= t).length,
      delayed: this.pending.filter((j) => j.readyAt > t).length,
      active: this.active,
      failed: this.failedIds.size,
    };
  }

  /** Ids waiting to run, in the order they would run now (tests). */
  peek(): string[] {
    const t = this.now();
    return this.pending
      .filter((j) => j.readyAt <= t)
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      .map((j) => j.itemId);
  }

  get size(): number {
    return this.pending.length;
  }
}
