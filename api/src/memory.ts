import { addMs } from './clock';
import type { Batch, Item, Status } from './domain';
import { StaleWriteError } from './errors';
import type { GlossaryTerm } from './glossary';
import {
  AuditEntry,
  AuditStore,
  BatchStore,
  Comment,
  CommentStore,
  compareItems,
  emptyStatusCounts,
  GlossaryStore,
  ItemFilter,
  ItemQuery,
  ItemStore,
  matchesFilter,
  OutboxMessage,
  OutboxStatus,
  OutboxStore,
  Page,
  pageOf,
  Store,
} from './repository';
import { MemoryLedger } from './usage';

/**
 * In-memory store. Every read and write copies, so callers can't mutate stored state behind the
 * store's back — the same isolation a database gives, which keeps tests honest about saves.
 */
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryItemStore implements ItemStore {
  private readonly rows = new Map<string, Item>();

  async insertMany(items: Item[]): Promise<void> {
    for (const i of items) {
      if (this.rows.has(i.id)) throw new Error(`duplicate item id ${i.id}`);
    }
    for (const i of items) this.rows.set(i.id, clone({ ...i, version: i.version ?? 0 }));
  }

  async get(id: string): Promise<Item | null> {
    const r = this.rows.get(id);
    return r ? clone(r) : null;
  }

  async getMany(ids: string[]): Promise<Item[]> {
    return ids.map((id) => this.rows.get(id)).filter((x): x is Item => !!x).map(clone);
  }

  async save(item: Item): Promise<Item> {
    const current = this.rows.get(item.id);
    const expected = item.version ?? 0;
    if (!current) throw new Error(`item ${item.id} does not exist`);
    if ((current.version ?? 0) !== expected) throw new StaleWriteError(item.id, expected);
    const next = clone({ ...item, version: expected + 1 });
    this.rows.set(item.id, next);
    return clone(next);
  }

  async query(q: ItemQuery): Promise<Page<Item>> {
    const all = [...this.rows.values()].filter((i) => matchesFilter(i, q)).sort(compareItems(q.sort ?? 'created_asc'));
    const page = pageOf(all, q.limit, q.cursor);
    return { ...page, items: page.items.map(clone) };
  }

  async countByStatus(filter: ItemFilter = {}): Promise<Record<Status, number>> {
    const counts = emptyStatusCounts();
    for (const i of this.rows.values()) if (matchesFilter(i, filter)) counts[i.status]++;
    return counts;
  }

  async *scan(filter: ItemFilter = {}, pageSize = 500): AsyncIterable<Item> {
    const ids = [...this.rows.values()].filter((i) => matchesFilter(i, filter)).sort(compareItems('created_asc')).map((i) => i.id);
    for (let i = 0; i < ids.length; i += pageSize) {
      for (const id of ids.slice(i, i + pageSize)) {
        const r = this.rows.get(id);
        if (r) yield clone(r);
      }
    }
  }

  async claimNext(reviewer: string, now: Date, leaseMs: number, filter: ItemFilter = {}): Promise<Item | null> {
    const t = now.getTime();
    const candidates = [...this.rows.values()]
      .filter((i) => i.status === 'in_review' && matchesFilter(i, filter))
      .filter((i) => !i.lease || i.lease.reviewer === reviewer || Date.parse(i.lease.expiresAt) <= t)
      .sort((a, b) => {
        // A reviewer's own unexpired lease comes back first, so a page reload resumes the same item.
        const mineA = a.lease?.reviewer === reviewer && Date.parse(a.lease.expiresAt) > t ? 0 : 1;
        const mineB = b.lease?.reviewer === reviewer && Date.parse(b.lease.expiresAt) > t ? 0 : 1;
        return mineA - mineB || compareItems('score_asc')(a, b);
      });
    const pick = candidates[0];
    if (!pick) return null;
    const next: Item = { ...pick, lease: { reviewer, expiresAt: addMs(now, leaseMs).toISOString() }, version: (pick.version ?? 0) + 1 };
    this.rows.set(pick.id, clone(next));
    return clone(next);
  }

  async stuck(status: Status, before: string, limit = 100): Promise<Item[]> {
    return [...this.rows.values()]
      .filter((i) => i.status === status && (i.updatedAt ?? i.history.at(-1)?.at ?? '') < before)
      .sort(compareItems('created_asc'))
      .slice(0, limit)
      .map(clone);
  }

  /** Test helper: number of stored items. */
  get size(): number {
    return this.rows.size;
  }
}

export class MemoryBatchStore implements BatchStore {
  private readonly rows = new Map<string, Batch>();

  async insert(batch: Batch): Promise<void> {
    if (this.rows.has(batch.id)) throw new Error(`duplicate batch id ${batch.id}`);
    this.rows.set(batch.id, clone(batch));
  }

  async get(id: string): Promise<Batch | null> {
    const b = this.rows.get(id);
    return b ? clone(b) : null;
  }

  async save(batch: Batch): Promise<void> {
    if (!this.rows.has(batch.id)) throw new Error(`batch ${batch.id} does not exist`);
    this.rows.set(batch.id, clone(batch));
  }

  async list(opts: { limit?: number; cursor?: string | null; createdBy?: string }): Promise<Page<Batch>> {
    const all = [...this.rows.values()]
      .filter((b) => !opts.createdBy || b.createdBy === opts.createdBy)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const p = pageOf(all, opts.limit, opts.cursor);
    return { ...p, items: p.items.map(clone) };
  }
}

export class MemoryAuditStore implements AuditStore {
  private readonly rows: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.rows.push(clone(entry));
  }

  async list(opts: { subject?: string; actor?: string; action?: string; limit?: number; cursor?: string | null }): Promise<Page<AuditEntry>> {
    const all = this.rows
      .filter((e) => (!opts.subject || e.subject === opts.subject) && (!opts.actor || e.actor === opts.actor) && (!opts.action || e.action === opts.action))
      .slice()
      .reverse();
    const p = pageOf(all, opts.limit, opts.cursor);
    return { ...p, items: p.items.map(clone) };
  }
}

export class MemoryCommentStore implements CommentStore {
  private readonly rows = new Map<string, Comment>();

  async add(c: Comment): Promise<void> {
    this.rows.set(c.id, clone(c));
  }

  async get(id: string): Promise<Comment | null> {
    const c = this.rows.get(id);
    return c ? clone(c) : null;
  }

  async save(c: Comment): Promise<void> {
    if (!this.rows.has(c.id)) throw new Error(`comment ${c.id} does not exist`);
    this.rows.set(c.id, clone(c));
  }

  async list(itemId: string): Promise<Comment[]> {
    return [...this.rows.values()]
      .filter((c) => c.itemId === itemId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async countOpen(itemIds: string[]): Promise<Record<string, number>> {
    const want = new Set(itemIds);
    const out: Record<string, number> = {};
    for (const c of this.rows.values()) {
      if (!want.has(c.itemId) || c.resolved) continue;
      out[c.itemId] = (out[c.itemId] ?? 0) + 1;
    }
    return out;
  }
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxMessage>();

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) this.rows.set(m.id, clone(m));
  }

  async claimDue(now: Date, limit: number, lockMs: number): Promise<OutboxMessage[]> {
    const t = now.toISOString();
    const due = [...this.rows.values()]
      .filter((m) => m.status === 'pending' && m.nextAttemptAt <= t && (!m.lockedUntil || m.lockedUntil <= t))
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    const lockedUntil = addMs(now, lockMs).toISOString();
    for (const m of due) {
      m.lockedUntil = lockedUntil;
    }
    return due.map(clone);
  }

  async save(message: OutboxMessage): Promise<void> {
    this.rows.set(message.id, clone(message));
  }

  async get(id: string): Promise<OutboxMessage | null> {
    const m = this.rows.get(id);
    return m ? clone(m) : null;
  }

  async list(opts: { status?: OutboxStatus; limit?: number; cursor?: string | null }): Promise<Page<OutboxMessage>> {
    const all = [...this.rows.values()].filter((m) => !opts.status || m.status === opts.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const p = pageOf(all, opts.limit, opts.cursor);
    return { ...p, items: p.items.map(clone) };
  }

  async counts(): Promise<Record<OutboxStatus, number>> {
    const out: Record<OutboxStatus, number> = { pending: 0, delivered: 0, dead: 0 };
    for (const m of this.rows.values()) out[m.status]++;
    return out;
  }
}

export class MemoryGlossaryStore implements GlossaryStore {
  private readonly rows = new Map<string, GlossaryTerm>();

  async list(locale?: GlossaryTerm['locale']): Promise<GlossaryTerm[]> {
    return [...this.rows.values()]
      .filter((t) => !locale || t.locale === locale || t.locale === '*')
      .sort((a, b) => a.locale.localeCompare(b.locale) || a.term.localeCompare(b.term))
      .map(clone);
  }

  async get(id: string): Promise<GlossaryTerm | null> {
    const t = this.rows.get(id);
    return t ? clone(t) : null;
  }

  async add(term: GlossaryTerm): Promise<void> {
    this.rows.set(term.id, clone(term));
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class MemoryStore implements Store {
  readonly items = new MemoryItemStore();
  readonly batches = new MemoryBatchStore();
  readonly audit = new MemoryAuditStore();
  readonly comments = new MemoryCommentStore();
  readonly outbox = new MemoryOutboxStore();
  readonly glossary = new MemoryGlossaryStore();
  readonly ledger = new MemoryLedger();

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'memory' };
  }

  async close(): Promise<void> {}
}
