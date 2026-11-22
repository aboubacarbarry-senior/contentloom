import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from '../src/postgres';
import { migrate } from '../src/migrate';
import { Batch, Item, newItem, transition } from '../src/domain';
import { StaleWriteError } from '../src/errors';
import { brief } from './helpers';

/**
 * Integration tests for the Postgres store. They need a database and run only when
 * CONTENTLOOM_TEST_DATABASE_URL is set; each run works in a throwaway schema that is dropped after.
 *
 *   CONTENTLOOM_TEST_DATABASE_URL=postgres://localhost/contentloom_test npm test
 */
const url = process.env.CONTENTLOOM_TEST_DATABASE_URL;
const skip = url ? false : 'set CONTENTLOOM_TEST_DATABASE_URL to run the Postgres tests';
const schema = `cl_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let admin: Pool;
let store: PostgresStore;

const T0 = new Date('2026-03-02T09:00:00.000Z');

function batch(id = randomUUID()): Batch {
  return { id, name: 'pg test', createdBy: 'ed', createdAt: T0.toISOString(), itemCount: 3, source: 'api', cancelledAt: null, cancelledBy: null };
}

function reviewable(batchId: string, sku: string, total: number): Item {
  const i = newItem(randomUUID(), batchId, brief(sku), T0);
  for (const s of ['generating', 'scored', 'in_review'] as const) transition(i, s, 'x', T0);
  i.draft = `Draft for ${sku}`;
  i.score = { facts: 1, claims: 1, length: 1, judge: 1, total, notes: [], findings: total < 0.5 ? [{ code: 'units.mismatch', severity: 'block', message: 'x' }] : [] };
  return i;
}

before(async () => {
  if (!url) return;
  admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
  store = new PostgresStore(pool);
  await migrate(pool);
});

after(async () => {
  if (!url) return;
  await store?.close();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
});

test('migrations are idempotent', { skip }, async () => {
  const r = await migrate(store.pool);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped, ['001_init.sql', '002_text_search.sql']);
});

test('items round-trip, and saves are compare-and-set', { skip }, async () => {
  const b = batch();
  await store.batches.insert(b);
  const items = [reviewable(b.id, 'PG-1', 0.9), reviewable(b.id, 'PG-2', 0.4), reviewable(b.id, 'PG-3', 0.7)];
  await store.items.insertMany(items);
  const got = (await store.items.get(items[0].id))!;
  assert.equal(got.brief.sku, 'PG-1');
  assert.equal(got.version, 0);
  assert.deepEqual(got.history.map((h) => h.to), ['queued', 'generating', 'scored', 'in_review']);
  const a = (await store.items.get(items[0].id))!;
  const c = (await store.items.get(items[0].id))!;
  a.reviewNote = 'first';
  assert.equal((await store.items.save(a)).version, 1);
  c.reviewNote = 'second';
  await assert.rejects(store.items.save(c), StaleWriteError);
  assert.equal((await store.items.get(items[0].id))!.reviewNote, 'first');
  assert.deepEqual((await store.items.getMany([items[2].id, items[1].id])).map((i) => i.brief.sku), ['PG-3', 'PG-2']);
});

test('query filters match the in-memory store', { skip }, async () => {
  const b = batch();
  await store.batches.insert(b);
  await store.items.insertMany([reviewable(b.id, 'Q_1', 0.95), reviewable(b.id, 'Q%2', 0.3), reviewable(b.id, 'QX3', 0.6)]);
  const byScore = await store.items.query({ batchId: b.id, sort: 'score_asc', limit: 2 });
  assert.deepEqual(byScore.items.map((i) => i.brief.sku), ['Q%2', 'QX3']);
  assert.equal(byScore.total, 3);
  const next = await store.items.query({ batchId: b.id, sort: 'score_asc', limit: 2, cursor: byScore.nextCursor });
  assert.deepEqual(next.items.map((i) => i.brief.sku), ['Q_1']);
  assert.deepEqual((await store.items.query({ sku: 'Q_*' })).items.map((i) => i.brief.sku), ['Q_1'], 'LIKE wildcards in a prefix are literal');
  assert.deepEqual((await store.items.query({ batchId: b.id, finding: 'units' })).items.map((i) => i.brief.sku), ['Q%2']);
  assert.deepEqual((await store.items.query({ batchId: b.id, text: 'draft for qx' })).items.map((i) => i.brief.sku), ['QX3']);
  assert.deepEqual((await store.items.query({ batchId: b.id, minScore: 0.5, excludeIds: [] })).total, 2);
  const counts = await store.items.countByStatus({ batchId: b.id });
  assert.equal(counts.in_review, 3);
  const scanned: string[] = [];
  for await (const i of store.items.scan({ batchId: b.id }, 2)) scanned.push(i.brief.sku);
  assert.equal(scanned.length, 3);
});

test('two reviewers claiming at once never get the same item', { skip }, async () => {
  const b = batch();
  await store.batches.insert(b);
  await store.items.insertMany(Array.from({ length: 6 }, (_, n) => reviewable(b.id, `CL-${n}`, n / 10)));
  const claims = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((r) => store.items.claimNext(r, T0, 600_000, { batchId: b.id })));
  const ids = claims.map((c) => c!.id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(claims[0]!.lease!.expiresAt, '2026-03-02T09:10:00.000Z');
  const again = await store.items.claimNext('r1', T0, 600_000, { batchId: b.id });
  assert.equal(again!.id, claims[0]!.id, 'a reviewer gets their own lease back first');
});

test('outbox leases, ledger upserts and glossary uniqueness', { skip }, async () => {
  const now = T0.toISOString();
  await store.outbox.enqueue([
    { id: randomUUID(), event: 'item.published', target: 'https://pim.example.com/h', payload: { a: 1 }, createdAt: now, status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null, lastStatus: null, deliveredAt: null, lockedUntil: null },
  ]);
  const [first, second] = await Promise.all([store.outbox.claimDue(T0, 10, 60_000), store.outbox.claimDue(T0, 10, 60_000)]);
  assert.equal(first.length + second.length, 1, 'only one dispatcher gets the message');
  await store.ledger.record('2026-03-02', { calls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0014 });
  await store.ledger.record('2026-03-02', { calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 0, costUsd: 0.0001 });
  const spent = await store.ledger.spent('2026-03-02');
  assert.equal(spent.calls, 3);
  assert.equal(spent.costUsd, 0.0015);
  assert.deepEqual((await store.ledger.range('2026-03-01', '2026-03-03')).map((r) => r.day), ['2026-03-02']);
  const term = { id: randomUUID(), locale: 'en-US' as const, term: 'Blankie', kind: 'forbidden' as const, replacement: null, note: null, caseSensitive: false, createdBy: 'ada', createdAt: now };
  await store.glossary.add(term);
  await assert.rejects(store.glossary.add({ ...term, id: randomUUID(), term: 'blankie' }), /duplicate key/);
  assert.equal((await store.glossary.list('en-US')).length, 1);
  assert.deepEqual(await store.health().then((h) => h.ok), true);
});
