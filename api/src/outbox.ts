import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { addMs, Clock, HOUR, MINUTE } from './clock';
import type { AppConfig } from './config';
import { describeError } from './errors';
import { EventBus } from './events';
import { OutboxMessage, Page, Store, STORE } from './repository';
import { CLOCK, CONFIG, FETCH, FetchFn, RANDOM } from './tokens';

/**
 * Transactional-outbox webhooks. Publishing an item writes a message per downstream endpoint (the PIM
 * and the storefront CMS); a dispatcher delivers them with retries, so a downstream outage never loses
 * a publish and never blocks a reviewer.
 *
 * Signatures follow the common `t=<unix>,v1=<hex hmac>` scheme over `<t>.<body>`, so receivers can
 * reject replays older than five minutes.
 */

export const SIGNATURE_HEADER = 'x-contentloom-signature';

export function sign(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

/** Receiver-side check, exported for downstream teams and for tests. */
export function verifySignature(secret: string, header: string, body: string, nowSec: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, t, body).split('v1=')[1], 'hex');
  const got = Buffer.from(parts.v1, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Exponential backoff with ±20% jitter: 30s, 1m, 2m, 4m … capped at 6h. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(6 * HOUR, 30_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.round(base * jitter);
}

/** Should a response status be retried? 4xx other than 408/409/425/429 means the receiver rejected it. */
export function retryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 409 || status === 425 || status === 429;
}

export interface DispatchResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

@Injectable()
export class OutboxService {
  private readonly timeoutMs = 10_000;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FETCH) private readonly fetchFn: FetchFn,
    @Inject(RANDOM) private readonly rand: () => number,
    private readonly events: EventBus,
  ) {}

  get enabled(): boolean {
    return this.config.webhooks.urls.length > 0;
  }

  /** Queue an event for every configured endpoint. Returns the message ids. */
  async enqueue(event: string, data: Record<string, unknown>): Promise<string[]> {
    if (!this.enabled) return [];
    const now = this.clock.now().toISOString();
    const eventId = randomUUID();
    const messages: OutboxMessage[] = this.config.webhooks.urls.map((target) => ({
      id: randomUUID(),
      event,
      target,
      payload: { id: eventId, type: event, occurredAt: now, data },
      createdAt: now,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lastStatus: null,
      deliveredAt: null,
      lockedUntil: null,
    }));
    await this.store.outbox.enqueue(messages);
    return messages.map((m) => m.id);
  }

  async dispatch(limit = 25): Promise<DispatchResult> {
    const now = this.clock.now();
    const due = await this.store.outbox.claimDue(now, limit, 2 * MINUTE);
    const result: DispatchResult = { claimed: due.length, delivered: 0, retried: 0, dead: 0 };
    for (const m of due) {
      const outcome = await this.deliver(m);
      result[outcome]++;
    }
    return result;
  }

  private async deliver(m: OutboxMessage): Promise<'delivered' | 'retried' | 'dead'> {
    const body = JSON.stringify(m.payload);
    const ts = Math.floor(this.clock.now().getTime() / 1000);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'ContentLoom-Webhooks/1.0',
      'x-contentloom-event': m.event,
      'x-contentloom-delivery': m.id,
    };
    if (this.config.webhooks.secret) headers[SIGNATURE_HEADER] = sign(this.config.webhooks.secret, ts, body);
    m.attempts += 1;
    let status: number | null = null;
    let error: string | null = null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(m.target, { method: 'POST', headers, body, signal: ctrl.signal });
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
    } catch (e) {
      error = ctrl.signal.aborted ? `timed out after ${this.timeoutMs} ms` : describeError(e, 300);
    } finally {
      clearTimeout(timer);
    }
    const now = this.clock.now();
    m.lastStatus = status;
    m.lockedUntil = null;
    if (!error) {
      m.status = 'delivered';
      m.deliveredAt = now.toISOString();
      m.lastError = null;
      await this.store.outbox.save(m);
      return 'delivered';
    }
    m.lastError = error;
    const giveUp = (status !== null && !retryableStatus(status)) || m.attempts >= this.config.webhooks.maxAttempts;
    if (giveUp) {
      m.status = 'dead';
      await this.store.outbox.save(m);
      this.events.publish({ type: 'outbox.dead', messageId: m.id, event: m.event, target: m.target, at: now.toISOString() });
      return 'dead';
    }
    m.nextAttemptAt = addMs(now, backoffMs(m.attempts, this.rand)).toISOString();
    await this.store.outbox.save(m);
    return 'retried';
  }

  /** Send a dead message again (after the receiver is fixed). Keeps its attempt history. */
  async retry(id: string): Promise<OutboxMessage | null> {
    const m = await this.store.outbox.get(id);
    if (!m) return null;
    if (m.status === 'delivered') return m;
    m.status = 'pending';
    m.nextAttemptAt = this.clock.now().toISOString();
    m.lockedUntil = null;
    await this.store.outbox.save(m);
    return m;
  }

  list(opts: { status?: OutboxMessage['status']; limit?: number; cursor?: string | null }): Promise<Page<OutboxMessage>> {
    return this.store.outbox.list(opts);
  }

  counts() {
    return this.store.outbox.counts();
  }
}
