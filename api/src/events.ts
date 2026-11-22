import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';
import type { Status } from './domain';

/**
 * In-process event bus. The review app subscribes over Server-Sent Events, so a reviewer's queue
 * updates when items arrive or a colleague takes one. Across several API processes, put Redis pub/sub
 * behind `publish` (the interface stays the same).
 */
export type AppEvent =
  | { type: 'item.status'; itemId: string; batchId: string; from: Status | null; to: Status; by: string; at: string }
  | { type: 'item.leased'; itemId: string; reviewer: string; expiresAt: string; at: string }
  | { type: 'item.released'; itemId: string; reviewer: string; at: string }
  | { type: 'item.comment'; itemId: string; commentId: string; author: string; at: string }
  | { type: 'batch.created'; batchId: string; itemCount: number; by: string; at: string }
  | { type: 'batch.completed'; batchId: string; at: string }
  | { type: 'batch.cancelled'; batchId: string; by: string; cancelled: number; at: string }
  | { type: 'review.overdue'; itemId: string; batchId: string; sku: string; enteredAt: string; at: string }
  | { type: 'budget.exceeded'; spentUsd: number; limitUsd: number; at: string }
  | { type: 'outbox.dead'; messageId: string; event: string; target: string; at: string };

export type AppEventType = AppEvent['type'];

@Injectable()
export class EventBus implements OnModuleDestroy {
  private readonly subject = new Subject<AppEvent>();
  private readonly recent: AppEvent[] = [];
  private seq = 0;
  private readonly bufferSize = 200;

  publish(e: AppEvent): void {
    this.recent.push(e);
    if (this.recent.length > this.bufferSize) this.recent.shift();
    this.seq++;
    this.subject.next(e);
  }

  get published(): number {
    return this.seq;
  }

  stream(types?: AppEventType[]): Observable<AppEvent> {
    const want = types?.length ? new Set(types) : null;
    return this.subject.asObservable().pipe(filter((e) => !want || want.has(e.type)));
  }

  /** As SSE frames for Nest's @Sse() handlers. */
  sse(types?: AppEventType[]): Observable<{ type: string; data: AppEvent }> {
    return this.stream(types).pipe(map((e) => ({ type: e.type, data: e })));
  }

  /** The last few events, for a client that just connected (newest last). */
  replay(types?: AppEventType[], limit = 50): AppEvent[] {
    const want = types?.length ? new Set(types) : null;
    return this.recent.filter((e) => !want || want.has(e.type)).slice(-limit);
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}

export function parseEventTypes(raw: string | undefined): AppEventType[] | undefined {
  if (!raw) return undefined;
  const known: AppEventType[] = [
    'item.status',
    'item.leased',
    'item.released',
    'item.comment',
    'batch.created',
    'batch.completed',
    'batch.cancelled',
    'review.overdue',
    'budget.exceeded',
    'outbox.dead',
  ];
  const out = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AppEventType => (known as string[]).includes(s));
  return out.length ? out : undefined;
}
