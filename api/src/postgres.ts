import { Pool, PoolClient, PoolConfig } from 'pg';
import type { Batch, Item, Status, Usage } from './domain';
import { EMPTY_USAGE } from './domain';
import { StaleWriteError } from './errors';
import type { GlossaryTerm } from './glossary';
import {
  AuditEntry,
  AuditStore,
  BatchStore,
  clampLimit,
  Comment,
  CommentStore,
  decodeCursor,
  emptyStatusCounts,
  encodeCursor,
  GlossaryStore,
  ItemFilter,
  ItemQuery,
  ItemSort,
  ItemStore,
  OutboxMessage,
  OutboxStatus,
  OutboxStore,
  Page,
  Store,
} from './repository';
import type { UsageLedger } from './usage';

type Queryable = Pick<Pool, 'query'> | PoolClient;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function isoOrThrow(v: unknown): string {
  const s = iso(v);
  if (!s) throw new Error('expected a timestamp');
  return s;
}

/** Escape LIKE wildcards so user text matches literally. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Translate an ItemFilter into a WHERE clause with numbered parameters. Kept pure (no pool) so the
 * SQL can be unit-tested without a database.
 */
export function buildItemWhere(f: ItemFilter, startIndex = 1): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${startIndex + params.length - 1}`;
  };
  if (f.ids) parts.push(`id = any(${p(f.ids)}::uuid[])`);
  if (f.excludeIds?.length) parts.push(`not (id = any(${p(f.excludeIds)}::uuid[]))`);
  if (f.status?.length) parts.push(`status = any(${p(f.status)}::text[])`);
  if (f.batchId) parts.push(`batch_id = ${p(f.batchId)}::uuid`);
  if (f.category?.length) parts.push(`category = any(${p(f.category)}::text[])`);
  if (f.locale?.length) parts.push(`locale = any(${p(f.locale)}::text[])`);
  if (f.sku) {
    if (f.sku.endsWith('*')) parts.push(`lower(sku) like ${p(`${likeEscape(f.sku.slice(0, -1).toLowerCase())}%`)}`);
    else parts.push(`lower(sku) = ${p(f.sku.toLowerCase())}`);
  }
  if (f.reviewer) parts.push(`reviewer = ${p(f.reviewer)}`);
  if (f.minScore !== undefined) parts.push(`score_total >= ${p(f.minScore)}`);
  if (f.maxScore !== undefined) parts.push(`score_total <= ${p(f.maxScore)}`);
  if (f.text) {
    parts.push(`lower(sku || ' ' || coalesce(doc ->> 'draft', '') || ' ' || coalesce(doc ->> 'finalText', '')) like ${p(`%${likeEscape(f.text.toLowerCase())}%`)}`);
  }
  if (f.finding) {
    const code = f.finding;
    const cond = code.endsWith('.') ? `f ->> 'code' like ${p(`${likeEscape(code)}%`)}` : `(f ->> 'code' = ${p(code)} or f ->> 'code' like ${p(`${likeEscape(code)}.%`)})`;
    parts.push(`exists (select 1 from jsonb_array_elements(coalesce(doc -> 'score' -> 'findings', '[]'::jsonb)) f where ${cond})`);
  }
  if (f.variant) parts.push(`coalesce(variant, 'control') = ${p(f.variant)}`);
  if (f.sampled !== undefined) parts.push(`sampled = ${p(f.sampled)}`);
  if (f.createdAfter) parts.push(`created_at >= ${p(f.createdAfter)}::timestamptz`);
  if (f.createdBefore) parts.push(`created_at < ${p(f.createdBefore)}::timestamptz`);
  return { clause: parts.length ? parts.join(' and ') : 'true', params };
}

export function orderBy(sort: ItemSort): string {
  switch (sort) {
    case 'score_asc':
      return 'score_total asc nulls first, created_at asc, id asc';
    case 'score_desc':
      return 'score_total desc nulls last, created_at asc, id asc';
    case 'created_asc':
      return 'created_at asc, id asc';
    case 'created_desc':
      return 'created_at desc, id desc';
    case 'updated_desc':
      return 'updated_at desc, id asc';
    case 'sku_asc':
      return 'sku asc, locale asc, id asc';
  }
}

function itemColumns(i: Item) {
  const doc = { ...i } as Partial<Item>;
  delete doc.version;
  return {
    id: i.id,
    batch_id: i.batchId,
    sku: i.brief.sku,
    locale: i.brief.locale,
    category: i.brief.category,
    status: i.status,
    score_total: i.score?.total ?? null,
    reviewer: i.reviewer,
    variant: i.variant ?? null,
    sampled: i.routing?.sampled ?? false,
    lease_reviewer: i.lease?.reviewer ?? null,
    lease_expires_at: i.lease?.expiresAt ?? null,
    created_at: i.createdAt ?? i.history[0]?.at,
    updated_at: i.updatedAt ?? i.history.at(-1)?.at ?? i.createdAt,
    doc: JSON.stringify(doc),
  };
}

const ITEM_COLS = ['id', 'batch_id', 'sku', 'locale', 'category', 'status', 'score_total', 'reviewer', 'variant', 'sampled', 'lease_reviewer', 'lease_expires_at', 'created_at', 'updated_at', 'doc'] as const;

function rowToItem(r: { doc: Item; version: number }): Item {
  return { ...r.doc, version: r.version };
}

export class PgItemStore implements ItemStore {
  constructor(private readonly db: Pool) {}

  async insertMany(items: Item[]): Promise<void> {
    if (!items.length) return;
    await withTx(this.db, async (c) => {
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const params: unknown[] = [];
        const rows = chunk.map((item) => {
          const cols = itemColumns(item);
          const ph = ITEM_COLS.map((k) => {
            params.push(cols[k]);
            return `$${params.length}`;
          });
          params.push(item.version ?? 0);
          return `(${ph.join(', ')}, $${params.length})`;
        });
        await c.query(`insert into items (${ITEM_COLS.join(', ')}, version) values ${rows.join(', ')}`, params);
      }
    });
  }

  async get(id: string): Promise<Item | null> {
    const r = await this.db.query('select doc, version from items where id = $1', [id]);
    return r.rows[0] ? rowToItem(r.rows[0]) : null;
  }

  async getMany(ids: string[]): Promise<Item[]> {
    if (!ids.length) return [];
    const r = await this.db.query('select doc, version from items where id = any($1::uuid[])', [ids]);
    const byId = new Map(r.rows.map((row) => [row.doc.id as string, rowToItem(row)]));
    return ids.map((id) => byId.get(id)).filter((x): x is Item => !!x);
  }

  async save(item: Item): Promise<Item> {
    const cols = itemColumns(item);
    const expected = item.version ?? 0;
    const sets = ITEM_COLS.filter((k) => k !== 'id').map((k, idx) => `${k} = $${idx + 3}`);
    const values = ITEM_COLS.filter((k) => k !== 'id').map((k) => cols[k]);
    const r = await this.db.query(`update items set ${sets.join(', ')}, version = version + 1 where id = $1 and version = $2 returning version`, [item.id, expected, ...values]);
    if (r.rowCount === 0) {
      const exists = await this.db.query('select 1 from items where id = $1', [item.id]);
      if (!exists.rowCount) throw new Error(`item ${item.id} does not exist`);
      throw new StaleWriteError(item.id, expected);
    }
    return { ...item, version: r.rows[0].version };
  }

  async query(q: ItemQuery): Promise<Page<Item>> {
    const limit = clampLimit(q.limit);
    const offset = decodeCursor(q.cursor);
    const { clause, params } = buildItemWhere(q);
    const r = await this.db.query(
      `select doc, version, count(*) over () as total from items where ${clause} order by ${orderBy(q.sort ?? 'created_asc')} limit ${limit} offset ${offset}`,
      params,
    );
    let total = r.rows[0] ? Number(r.rows[0].total) : 0;
    if (!r.rows.length && offset > 0) {
      const c = await this.db.query(`select count(*)::int as n from items where ${clause}`, params);
      total = c.rows[0].n;
    }
    return { items: r.rows.map(rowToItem), total, nextCursor: offset + limit < total ? encodeCursor(offset + limit) : null };
  }

  async countByStatus(filter: ItemFilter = {}): Promise<Record<Status, number>> {
    const { clause, params } = buildItemWhere(filter);
    const r = await this.db.query(`select status, count(*)::int as n from items where ${clause} group by status`, params);
    const out = emptyStatusCounts();
    for (const row of r.rows) out[row.status as Status] = row.n;
    return out;
  }

  async *scan(filter: ItemFilter = {}, pageSize = 500): AsyncIterable<Item> {
    // Keyset pagination: stable under concurrent inserts, no OFFSET cost on large tables.
    let after: { created: string; id: string } | null = null;
    for (;;) {
      const { clause, params } = buildItemWhere(filter);
      const extra: unknown[] = [];
      let keyset = '';
      if (after) {
        extra.push(after.created, after.id);
        keyset = ` and (created_at, id) > ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`;
      }
      const r: { rows: { doc: Item; version: number; created_at: Date }[] } = await this.db.query(
        `select doc, version, created_at from items where ${clause}${keyset} order by created_at, id limit ${pageSize}`,
        [...params, ...extra],
      );
      for (const row of r.rows) yield rowToItem(row);
      if (r.rows.length < pageSize) return;
      const last = r.rows[r.rows.length - 1];
      after = { created: isoOrThrow(last.created_at), id: last.doc.id };
    }
  }

  async claimNext(reviewer: string, now: Date, leaseMs: number, filter: ItemFilter = {}): Promise<Item | null> {
    const { clause, params } = buildItemWhere(filter, 4);
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    const lease = JSON.stringify({ reviewer, expiresAt: expires });
    const r = await this.db.query(
      `update items set
         lease_reviewer = $1,
         lease_expires_at = $3::timestamptz,
         doc = jsonb_set(doc, '{lease}', $${params.length + 4}::jsonb),
         version = version + 1
       where id = (
         select id from items
          where status = 'in_review'
            and (lease_reviewer is null or lease_reviewer = $1 or lease_expires_at <= $2::timestamptz)
            and ${clause}
          order by (lease_reviewer = $1 and lease_expires_at > $2::timestamptz) desc nulls last,
                   score_total asc nulls first, created_at asc, id asc
          limit 1
          for update skip locked)
       returning doc, version`,
      [reviewer, now.toISOString(), expires, ...params, lease],
    );
    return r.rows[0] ? rowToItem(r.rows[0]) : null;
  }

  async stuck(status: Status, before: string, limit = 100): Promise<Item[]> {
    const r = await this.db.query('select doc, version from items where status = $1 and updated_at < $2::timestamptz order by created_at limit $3', [status, before, limit]);
    return r.rows.map(rowToItem);
  }
}

export class PgBatchStore implements BatchStore {
  constructor(private readonly db: Pool) {}

  private static row(r: Record<string, unknown>): Batch {
    return {
      id: r.id as string,
      name: r.name as string,
      createdBy: r.created_by as string,
      createdAt: isoOrThrow(r.created_at),
      itemCount: r.item_count as number,
      source: r.source as Batch['source'],
      cancelledAt: iso(r.cancelled_at),
      cancelledBy: (r.cancelled_by as string | null) ?? null,
    };
  }

  async insert(b: Batch): Promise<void> {
    await this.db.query(
      'insert into batches (id, name, created_by, created_at, item_count, source, cancelled_at, cancelled_by) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [b.id, b.name, b.createdBy, b.createdAt, b.itemCount, b.source, b.cancelledAt, b.cancelledBy],
    );
  }

  async get(id: string): Promise<Batch | null> {
    const r = await this.db.query('select * from batches where id = $1', [id]);
    return r.rows[0] ? PgBatchStore.row(r.rows[0]) : null;
  }

  async save(b: Batch): Promise<void> {
    const r = await this.db.query('update batches set name = $2, cancelled_at = $3, cancelled_by = $4 where id = $1', [b.id, b.name, b.cancelledAt, b.cancelledBy]);
    if (!r.rowCount) throw new Error(`batch ${b.id} does not exist`);
  }

  async list(opts: { limit?: number; cursor?: string | null; createdBy?: string }): Promise<Page<Batch>> {
    const limit = clampLimit(opts.limit);
    const offset = decodeCursor(opts.cursor);
    const where = opts.createdBy ? 'where created_by = $1' : '';
    const params = opts.createdBy ? [opts.createdBy] : [];
    const r = await this.db.query(`select *, count(*) over () as total from batches ${where} order by created_at desc, id limit ${limit} offset ${offset}`, params);
    const total = r.rows[0] ? Number(r.rows[0].total) : 0;
    return { items: r.rows.map(PgBatchStore.row), total, nextCursor: offset + limit < total ? encodeCursor(offset + limit) : null };
  }
}

export class PgAuditStore implements AuditStore {
  constructor(private readonly db: Pool) {}

  async append(e: AuditEntry): Promise<void> {
    await this.db.query('insert into audit_log (id, at, actor, action, subject, detail) values ($1, $2, $3, $4, $5, $6)', [e.id, e.at, e.actor, e.action, e.subject, JSON.stringify(e.detail)]);
  }

  async list(opts: { subject?: string; actor?: string; action?: string; limit?: number; cursor?: string | null }): Promise<Page<AuditEntry>> {
    const limit = clampLimit(opts.limit);
    const offset = decodeCursor(opts.cursor);
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [col, v] of [
      ['subject', opts.subject],
      ['actor', opts.actor],
      ['action', opts.action],
    ] as const) {
      if (v) {
        params.push(v);
        conds.push(`${col} = $${params.length}`);
      }
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : '';
    const r = await this.db.query(`select *, count(*) over () as total from audit_log ${where} order by at desc, id limit ${limit} offset ${offset}`, params);
    const total = r.rows[0] ? Number(r.rows[0].total) : 0;
    return {
      items: r.rows.map((row) => ({ id: row.id, at: isoOrThrow(row.at), actor: row.actor, action: row.action, subject: row.subject, detail: row.detail })),
      total,
      nextCursor: offset + limit < total ? encodeCursor(offset + limit) : null,
    };
  }
}

export class PgCommentStore implements CommentStore {
  constructor(private readonly db: Pool) {}

  private static row(r: Record<string, unknown>): Comment {
    return {
      id: r.id as string,
      itemId: r.item_id as string,
      author: r.author as string,
      body: r.body as string,
      at: isoOrThrow(r.at),
      start: (r.start_offset as number | null) ?? null,
      end: (r.end_offset as number | null) ?? null,
      resolved: r.resolved as boolean,
    };
  }

  async add(c: Comment): Promise<void> {
    await this.db.query('insert into comments (id, item_id, author, body, at, start_offset, end_offset, resolved) values ($1, $2, $3, $4, $5, $6, $7, $8)', [
      c.id,
      c.itemId,
      c.author,
      c.body,
      c.at,
      c.start,
      c.end,
      c.resolved,
    ]);
  }

  async get(id: string): Promise<Comment | null> {
    const r = await this.db.query('select * from comments where id = $1', [id]);
    return r.rows[0] ? PgCommentStore.row(r.rows[0]) : null;
  }

  async save(c: Comment): Promise<void> {
    await this.db.query('update comments set body = $2, resolved = $3 where id = $1', [c.id, c.body, c.resolved]);
  }

  async list(itemId: string): Promise<Comment[]> {
    const r = await this.db.query('select * from comments where item_id = $1 order by at, id', [itemId]);
    return r.rows.map(PgCommentStore.row);
  }

  async countOpen(itemIds: string[]): Promise<Record<string, number>> {
    if (!itemIds.length) return {};
    const r = await this.db.query('select item_id, count(*)::int as n from comments where item_id = any($1::uuid[]) and not resolved group by item_id', [itemIds]);
    return Object.fromEntries(r.rows.map((row) => [row.item_id, row.n]));
  }
}

export class PgOutboxStore implements OutboxStore {
  constructor(private readonly db: Pool) {}

  private static row(r: Record<string, unknown>): OutboxMessage {
    return {
      id: r.id as string,
      event: r.event as string,
      target: r.target as string,
      payload: r.payload as Record<string, unknown>,
      createdAt: isoOrThrow(r.created_at),
      status: r.status as OutboxStatus,
      attempts: r.attempts as number,
      nextAttemptAt: isoOrThrow(r.next_attempt_at),
      lastError: (r.last_error as string | null) ?? null,
      lastStatus: (r.last_status as number | null) ?? null,
      deliveredAt: iso(r.delivered_at),
      lockedUntil: iso(r.locked_until),
    };
  }

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    await withTx(this.db, async (c) => {
      for (const m of messages) {
        await c.query(
          `insert into outbox (id, event, target, payload, created_at, status, attempts, next_attempt_at, last_error, last_status, delivered_at, locked_until)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [m.id, m.event, m.target, JSON.stringify(m.payload), m.createdAt, m.status, m.attempts, m.nextAttemptAt, m.lastError, m.lastStatus, m.deliveredAt, m.lockedUntil],
        );
      }
    });
  }

  async claimDue(now: Date, limit: number, lockMs: number): Promise<OutboxMessage[]> {
    const r = await this.db.query(
      `update outbox set locked_until = $2::timestamptz
        where id in (select id from outbox
                      where status = 'pending' and next_attempt_at <= $1::timestamptz
                        and (locked_until is null or locked_until <= $1::timestamptz)
                      order by next_attempt_at, created_at
                      limit $3
                      for update skip locked)
        returning *`,
      [now.toISOString(), new Date(now.getTime() + lockMs).toISOString(), limit],
    );
    return r.rows.map(PgOutboxStore.row).sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
  }

  async save(m: OutboxMessage): Promise<void> {
    await this.db.query(
      `update outbox set status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, last_status = $6, delivered_at = $7, locked_until = $8 where id = $1`,
      [m.id, m.status, m.attempts, m.nextAttemptAt, m.lastError, m.lastStatus, m.deliveredAt, m.lockedUntil],
    );
  }

  async get(id: string): Promise<OutboxMessage | null> {
    const r = await this.db.query('select * from outbox where id = $1', [id]);
    return r.rows[0] ? PgOutboxStore.row(r.rows[0]) : null;
  }

  async list(opts: { status?: OutboxStatus; limit?: number; cursor?: string | null }): Promise<Page<OutboxMessage>> {
    const limit = clampLimit(opts.limit);
    const offset = decodeCursor(opts.cursor);
    const where = opts.status ? 'where status = $1' : '';
    const r = await this.db.query(`select *, count(*) over () as total from outbox ${where} order by created_at desc limit ${limit} offset ${offset}`, opts.status ? [opts.status] : []);
    const total = r.rows[0] ? Number(r.rows[0].total) : 0;
    return { items: r.rows.map(PgOutboxStore.row), total, nextCursor: offset + limit < total ? encodeCursor(offset + limit) : null };
  }

  async counts(): Promise<Record<OutboxStatus, number>> {
    const r = await this.db.query('select status, count(*)::int as n from outbox group by status');
    const out: Record<OutboxStatus, number> = { pending: 0, delivered: 0, dead: 0 };
    for (const row of r.rows) out[row.status as OutboxStatus] = row.n;
    return out;
  }
}

export class PgGlossaryStore implements GlossaryStore {
  constructor(private readonly db: Pool) {}

  private static row(r: Record<string, unknown>): GlossaryTerm {
    return {
      id: r.id as string,
      locale: r.locale as GlossaryTerm['locale'],
      term: r.term as string,
      kind: r.kind as GlossaryTerm['kind'],
      replacement: (r.replacement as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      caseSensitive: r.case_sensitive as boolean,
      createdBy: r.created_by as string,
      createdAt: isoOrThrow(r.created_at),
    };
  }

  async list(locale?: GlossaryTerm['locale']): Promise<GlossaryTerm[]> {
    const r = locale
      ? await this.db.query(`select * from glossary where locale = $1 or locale = '*' order by locale, term`, [locale])
      : await this.db.query('select * from glossary order by locale, term');
    return r.rows.map(PgGlossaryStore.row);
  }

  async get(id: string): Promise<GlossaryTerm | null> {
    const r = await this.db.query('select * from glossary where id = $1', [id]);
    return r.rows[0] ? PgGlossaryStore.row(r.rows[0]) : null;
  }

  async add(t: GlossaryTerm): Promise<void> {
    await this.db.query(
      'insert into glossary (id, locale, term, kind, replacement, note, case_sensitive, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [t.id, t.locale, t.term, t.kind, t.replacement, t.note, t.caseSensitive, t.createdBy, t.createdAt],
    );
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.query('delete from glossary where id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }
}

export class PgLedger implements UsageLedger {
  constructor(private readonly db: Pool) {}

  private static row(r: Record<string, unknown>): Usage {
    return {
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      costUsd: Number(r.cost_usd),
    };
  }

  async record(day: string, u: Usage): Promise<void> {
    await this.db.query(
      `insert into usage_daily (day, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (day) do update set
         calls = usage_daily.calls + excluded.calls,
         input_tokens = usage_daily.input_tokens + excluded.input_tokens,
         output_tokens = usage_daily.output_tokens + excluded.output_tokens,
         cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
         cost_usd = usage_daily.cost_usd + excluded.cost_usd`,
      [day, u.calls, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costUsd],
    );
  }

  async spent(day: string): Promise<Usage> {
    const r = await this.db.query('select * from usage_daily where day = $1', [day]);
    return r.rows[0] ? PgLedger.row(r.rows[0]) : { ...EMPTY_USAGE };
  }

  async range(from: string, to: string): Promise<{ day: string; usage: Usage }[]> {
    const r = await this.db.query(`select to_char(day, 'YYYY-MM-DD') as d, * from usage_daily where day between $1 and $2 order by day`, [from, to]);
    return r.rows.map((row) => ({ day: row.d as string, usage: PgLedger.row(row) }));
  }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export class PostgresStore implements Store {
  readonly items: PgItemStore;
  readonly batches: PgBatchStore;
  readonly audit: PgAuditStore;
  readonly comments: PgCommentStore;
  readonly outbox: PgOutboxStore;
  readonly glossary: PgGlossaryStore;
  readonly ledger: PgLedger;

  constructor(readonly pool: Pool) {
    this.items = new PgItemStore(pool);
    this.batches = new PgBatchStore(pool);
    this.audit = new PgAuditStore(pool);
    this.comments = new PgCommentStore(pool);
    this.outbox = new PgOutboxStore(pool);
    this.glossary = new PgGlossaryStore(pool);
    this.ledger = new PgLedger(pool);
  }

  static connect(url: string, extra: PoolConfig = {}): PostgresStore {
    return new PostgresStore(new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, ...extra }));
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await (this.pool as Queryable).query('select 1 as ok');
      return { ok: r.rows[0]?.ok === 1, detail: `pool total=${this.pool.totalCount} idle=${this.pool.idleCount} waiting=${this.pool.waitingCount}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
