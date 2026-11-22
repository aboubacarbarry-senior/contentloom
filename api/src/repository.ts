import type { Batch, Item, Locale, Status } from './domain';
import type { GlossaryTerm } from './glossary';
import type { UsageLedger } from './usage';

/**
 * Persistence seams. Postgres in production (postgres.ts); an in-memory store for tests and local dev
 * (memory.ts). Both implement the same contracts, including optimistic concurrency on items.
 */

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface ItemFilter {
  ids?: string[];
  /** Items to leave out (e.g. drafts a reviewer skipped). */
  excludeIds?: string[];
  status?: Status[];
  batchId?: string;
  category?: string[];
  locale?: Locale[];
  /** Exact SKU, or a prefix when it ends with `*`. */
  sku?: string;
  reviewer?: string;
  minScore?: number;
  maxScore?: number;
  /** Case-insensitive substring of the draft, final text or SKU. */
  text?: string;
  /** Finding code or code prefix ending in `.` (e.g. `claim.`). */
  finding?: string;
  variant?: string;
  sampled?: boolean;
  createdAfter?: string;
  createdBefore?: string;
}

export type ItemSort = 'score_asc' | 'score_desc' | 'created_asc' | 'created_desc' | 'updated_desc' | 'sku_asc';

export interface ItemQuery extends ItemFilter {
  sort?: ItemSort;
  limit?: number;
  cursor?: string | null;
}

export interface ItemStore {
  insertMany(items: Item[]): Promise<void>;
  get(id: string): Promise<Item | null>;
  getMany(ids: string[]): Promise<Item[]>;
  /**
   * Write an item if nobody else has since it was read: the stored version must equal `item.version`.
   * Returns the saved item with its version bumped. Throws StaleWriteError on a lost race.
   */
  save(item: Item): Promise<Item>;
  query(q: ItemQuery): Promise<Page<Item>>;
  countByStatus(filter?: ItemFilter): Promise<Record<Status, number>>;
  /** Stream every matching item in pages; used by metrics and exports. */
  scan(filter?: ItemFilter, pageSize?: number): AsyncIterable<Item>;
  /**
   * Atomically lease the next item for a reviewer: the worst-scoring `in_review` item that is not leased
   * by someone else (or whose lease expired). Returns null when there is nothing to review.
   */
  claimNext(reviewer: string, now: Date, leaseMs: number, filter?: ItemFilter): Promise<Item | null>;
  /** Items stuck in a status since before `before` (e.g. workers that died mid-generation). */
  stuck(status: Status, before: string, limit?: number): Promise<Item[]>;
}

export interface BatchStore {
  insert(batch: Batch): Promise<void>;
  get(id: string): Promise<Batch | null>;
  save(batch: Batch): Promise<void>;
  list(opts: { limit?: number; cursor?: string | null; createdBy?: string }): Promise<Page<Batch>>;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  /** What the action was about: `item:<id>`, `batch:<id>`, `glossary:<id>`, `policy`. */
  subject: string;
  detail: Record<string, unknown>;
}

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  list(opts: { subject?: string; actor?: string; action?: string; limit?: number; cursor?: string | null }): Promise<Page<AuditEntry>>;
}

export interface Comment {
  id: string;
  itemId: string;
  author: string;
  body: string;
  at: string;
  /** Optional anchor in the draft the comment is about. */
  start: number | null;
  end: number | null;
  resolved: boolean;
}

export interface CommentStore {
  add(c: Comment): Promise<void>;
  get(id: string): Promise<Comment | null>;
  save(c: Comment): Promise<void>;
  list(itemId: string): Promise<Comment[]>;
  countOpen(itemIds: string[]): Promise<Record<string, number>>;
}

export type OutboxStatus = 'pending' | 'delivered' | 'dead';

export interface OutboxMessage {
  id: string;
  event: string;
  /** Delivery target URL. One message per target, so a slow endpoint doesn't hold up the others. */
  target: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastStatus: number | null;
  deliveredAt: string | null;
  /** Lease so two dispatchers don't send the same message at once. */
  lockedUntil: string | null;
}

export interface OutboxStore {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Lease up to `limit` pending messages that are due. */
  claimDue(now: Date, limit: number, lockMs: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  get(id: string): Promise<OutboxMessage | null>;
  list(opts: { status?: OutboxStatus; limit?: number; cursor?: string | null }): Promise<Page<OutboxMessage>>;
  counts(): Promise<Record<OutboxStatus, number>>;
}

export interface GlossaryStore {
  list(locale?: Locale | '*'): Promise<GlossaryTerm[]>;
  get(id: string): Promise<GlossaryTerm | null>;
  add(term: GlossaryTerm): Promise<void>;
  remove(id: string): Promise<boolean>;
}

export interface Store {
  items: ItemStore;
  batches: BatchStore;
  audit: AuditStore;
  comments: CommentStore;
  outbox: OutboxStore;
  glossary: GlossaryStore;
  ledger: UsageLedger;
  health(): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}

export const STORE = Symbol('STORE');

/* ---------- helpers shared by the implementations ---------- */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Opaque cursors: base64url of the offset. Clients must not build them. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^o:(\d+)$/.exec(raw);
  if (!m) throw new Error('invalid cursor');
  return Number(m[1]);
}

export function pageOf<T>(all: T[], limit: number | undefined, cursor: string | null | undefined): Page<T> {
  const lim = clampLimit(limit);
  const offset = decodeCursor(cursor);
  const items = all.slice(offset, offset + lim);
  return { items, total: all.length, nextCursor: offset + lim < all.length ? encodeCursor(offset + lim) : null };
}

export function emptyStatusCounts(): Record<Status, number> {
  return {
    queued: 0,
    generating: 0,
    scored: 0,
    in_review: 0,
    auto_approved: 0,
    approved: 0,
    rejected: 0,
    published: 0,
    withdrawn: 0,
    failed: 0,
    cancelled: 0,
  };
}

/** Does an item pass a filter? The Postgres store translates the same filter into SQL. */
export function matchesFilter(item: Item, f: ItemFilter): boolean {
  if (f.ids && !f.ids.includes(item.id)) return false;
  if (f.excludeIds?.includes(item.id)) return false;
  if (f.status?.length && !f.status.includes(item.status)) return false;
  if (f.batchId && item.batchId !== f.batchId) return false;
  if (f.category?.length && !f.category.includes(item.brief.category)) return false;
  if (f.locale?.length && !f.locale.includes(item.brief.locale)) return false;
  if (f.sku) {
    const prefix = f.sku.endsWith('*');
    const want = (prefix ? f.sku.slice(0, -1) : f.sku).toLowerCase();
    const sku = item.brief.sku.toLowerCase();
    if (prefix ? !sku.startsWith(want) : sku !== want) return false;
  }
  if (f.reviewer && item.reviewer !== f.reviewer) return false;
  const total = item.score?.total;
  if (f.minScore !== undefined && (total === undefined || total < f.minScore)) return false;
  if (f.maxScore !== undefined && (total === undefined || total > f.maxScore)) return false;
  if (f.text) {
    const needle = f.text.toLowerCase();
    const hay = `${item.brief.sku}\n${item.draft ?? ''}\n${item.finalText ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.finding) {
    const fs = item.score?.findings ?? [];
    const want = f.finding;
    if (!fs.some((x) => (want.endsWith('.') ? x.code.startsWith(want) : x.code === want || x.code.startsWith(`${want}.`)))) return false;
  }
  if (f.variant && (item.variant ?? 'control') !== f.variant) return false;
  if (f.sampled !== undefined && (item.routing?.sampled ?? false) !== f.sampled) return false;
  const created = item.createdAt ?? item.history[0]?.at;
  if (f.createdAfter && (!created || created < f.createdAfter)) return false;
  if (f.createdBefore && (!created || created >= f.createdBefore)) return false;
  return true;
}

export function compareItems(sort: ItemSort): (a: Item, b: Item) => number {
  const score = (i: Item) => i.score?.total ?? 0;
  const created = (i: Item) => i.createdAt ?? i.history[0]?.at ?? '';
  const updated = (i: Item) => i.updatedAt ?? i.history.at(-1)?.at ?? '';
  const tie = (a: Item, b: Item) => created(a).localeCompare(created(b)) || a.id.localeCompare(b.id);
  switch (sort) {
    case 'score_asc':
      return (a, b) => score(a) - score(b) || tie(a, b);
    case 'score_desc':
      return (a, b) => score(b) - score(a) || tie(a, b);
    case 'created_asc':
      return tie;
    case 'created_desc':
      return (a, b) => -tie(a, b);
    case 'updated_desc':
      return (a, b) => updated(b).localeCompare(updated(a)) || a.id.localeCompare(b.id);
    case 'sku_asc':
      return (a, b) => a.brief.sku.localeCompare(b.brief.sku) || a.brief.locale.localeCompare(b.brief.locale) || a.id.localeCompare(b.id);
  }
}
