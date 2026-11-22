import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory';
import { Item, newItem, transition } from '../src/domain';
import { StaleWriteError } from '../src/errors';
import { decodeCursor, encodeCursor, matchesFilter, OutboxMessage } from '../src/repository';
import { brief } from './helpers';

const T0 = new Date('2026-03-02T09:00:00.000Z');

function reviewable(id: string, total: number, at = T0): Item {
  const i = newItem(id, 'b1', brief(id), at);
  for (const s of ['generating', 'scored', 'in_review'] as const) transition(i, s, 'x', at);
  i.score = { facts: 1, claims: 1, length: 1, judge: 1, total, notes: [], findings: [] };
  return i;
}

test('saves are compare-and-set on the version', async () => {
  const s = new MemoryStore();
  await s.items.insertMany([newItem('a', 'b1', brief('A'), T0)]);
  const first = (await s.items.get('a'))!;
  const second = (await s.items.get('a'))!;
  first.draft = 'one';
  const saved = await s.items.save(first);
  assert.equal(saved.version, 1);
  second.draft = 'two';
  await assert.rejects(s.items.save(second), StaleWriteError);
  assert.equal((await s.items.get('a'))!.draft, 'one');
  await assert.rejects(s.items.insertMany([newItem('a', 'b1', brief('A'), T0)]), /duplicate item id/);
});

test('reads return copies; mutating them does not change the store', async () => {
  const s = new MemoryStore();
  await s.items.insertMany([newItem('a', 'b1', brief('A'), T0)]);
  const copy = (await s.items.get('a'))!;
  copy.status = 'published';
  copy.brief.facts.name = 'changed';
  const fresh = (await s.items.get('a'))!;
  assert.equal(fresh.status, 'queued');
  assert.equal(fresh.brief.facts.name, 'Sage Throw A');
});

test('claimNext leases the worst item, honours leases and gives a reviewer their own item back', async () => {
  const s = new MemoryStore();
  await s.items.insertMany([reviewable('good', 0.9), reviewable('bad', 0.4), reviewable('mid', 0.7)]);
  const rita = await s.items.claimNext('rita', T0, 600_000);
  assert.equal(rita!.id, 'bad');
  assert.equal(rita!.lease!.reviewer, 'rita');
  const raj = await s.items.claimNext('raj', T0, 600_000);
  assert.equal(raj!.id, 'mid', 'a leased item is skipped');
  const again = await s.items.claimNext('rita', new Date(T0.getTime() + 60_000), 600_000);
  assert.equal(again!.id, 'bad', 'a reload resumes the same item');
  const later = await s.items.claimNext('sam', new Date(T0.getTime() + 11 * 60_000), 600_000);
  assert.equal(later!.id, 'bad', 'expired leases are free again');
  const filtered = await s.items.claimNext('sam', T0, 600_000, { minScore: 0.8 });
  assert.equal(filtered!.id, 'good');
  assert.equal(await s.items.claimNext('zoe', T0, 600_000, { sku: 'NOPE' }), null);
});

test('query filters, sorts and pages with opaque cursors', async () => {
  const s = new MemoryStore();
  const items = Array.from({ length: 7 }, (_, n) => reviewable(`i${n}`, n / 10, new Date(T0.getTime() + n * 1000)));
  items[3].brief.locale = 'fr-CA';
  items[4].score!.findings = [{ code: 'claim.organic', severity: 'block', message: 'x' }];
  await s.items.insertMany(items);
  const p1 = await s.items.query({ sort: 'score_desc', limit: 3 });
  assert.deepEqual(p1.items.map((i) => i.id), ['i6', 'i5', 'i4']);
  assert.equal(p1.total, 7);
  const p2 = await s.items.query({ sort: 'score_desc', limit: 3, cursor: p1.nextCursor });
  assert.deepEqual(p2.items.map((i) => i.id), ['i3', 'i2', 'i1']);
  const p3 = await s.items.query({ sort: 'score_desc', limit: 3, cursor: p2.nextCursor });
  assert.equal(p3.nextCursor, null);
  assert.deepEqual((await s.items.query({ locale: ['fr-CA'] })).items.map((i) => i.id), ['i3']);
  assert.deepEqual((await s.items.query({ finding: 'claim.' })).items.map((i) => i.id), ['i4']);
  assert.deepEqual((await s.items.query({ finding: 'claim' })).items.map((i) => i.id), ['i4'], 'a bare prefix matches its codes');
  assert.deepEqual((await s.items.query({ minScore: 0.25, maxScore: 0.45 })).items.map((i) => i.id), ['i3', 'i4']);
  assert.deepEqual((await s.items.query({ sku: 'I1*' })).items.map((i) => i.id), ['i1']);
  const counts = await s.items.countByStatus();
  assert.equal(counts.in_review, 7);
  assert.equal(counts.published, 0);
  const scanned: string[] = [];
  for await (const i of s.items.scan({}, 2)) scanned.push(i.id);
  assert.equal(scanned.length, 7);
  assert.equal(decodeCursor(encodeCursor(42)), 42);
  assert.throws(() => decodeCursor('bm9wZQ'), /invalid cursor/);
});

test('matchesFilter handles text, dates and the variant default', () => {
  const i = reviewable('t1', 0.5);
  i.draft = 'A Soft Throw';
  assert.ok(matchesFilter(i, { text: 'soft throw' }));
  assert.ok(matchesFilter(i, { variant: 'control' }), 'items without a variant count as control');
  assert.ok(!matchesFilter(i, { createdAfter: '2026-03-03T00:00:00.000Z' }));
  assert.ok(matchesFilter(i, { createdBefore: '2026-03-03T00:00:00.000Z' }));
});

test('stuck items and outbox claiming', async () => {
  const s = new MemoryStore();
  const g = newItem('g', 'b1', brief('G'), T0);
  transition(g, 'generating', 'worker', T0);
  await s.items.insertMany([g, newItem('q', 'b1', brief('Q'), T0)]);
  assert.deepEqual((await s.items.stuck('generating', '2026-03-02T10:00:00.000Z')).map((i) => i.id), ['g']);
  assert.deepEqual(await s.items.stuck('generating', '2026-03-02T08:00:00.000Z'), []);

  const msg = (id: string, due: string): OutboxMessage => ({
    id,
    event: 'item.published',
    target: 'https://pim.example.com/hook',
    payload: {},
    createdAt: due,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: due,
    lastError: null,
    lastStatus: null,
    deliveredAt: null,
    lockedUntil: null,
  });
  await s.outbox.enqueue([msg('m1', '2026-03-02T09:00:00.000Z'), msg('m2', '2026-03-02T11:00:00.000Z')]);
  const first = await s.outbox.claimDue(T0, 10, 120_000);
  assert.deepEqual(first.map((m) => m.id), ['m1']);
  assert.deepEqual(await s.outbox.claimDue(T0, 10, 120_000), [], 'a locked message is not claimed twice');
  assert.deepEqual((await s.outbox.claimDue(new Date('2026-03-02T11:00:00.000Z'), 10, 120_000)).map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(await s.outbox.counts(), { pending: 2, delivered: 0, dead: 0 });
});

test('comments and glossary stores', async () => {
  const s = new MemoryStore();
  await s.comments.add({ id: 'c1', itemId: 'a', author: 'rita', body: 'hi', at: '2026-01-01T00:00:00Z', start: null, end: null, resolved: false });
  await s.comments.add({ id: 'c2', itemId: 'a', author: 'raj', body: 'ok', at: '2026-01-01T00:01:00Z', start: 0, end: 3, resolved: true });
  assert.deepEqual(await s.comments.countOpen(['a', 'b']), { a: 1 });
  assert.deepEqual((await s.comments.list('a')).map((c) => c.id), ['c1', 'c2']);
  await s.glossary.add({ id: 'g1', locale: '*', term: 'x', kind: 'forbidden', replacement: null, note: null, caseSensitive: false, createdBy: 'a', createdAt: 'z' });
  await s.glossary.add({ id: 'g2', locale: 'fr-CA', term: 'email', kind: 'preferred', replacement: 'courriel', note: null, caseSensitive: false, createdBy: 'a', createdAt: 'z' });
  assert.deepEqual((await s.glossary.list('en-US')).map((t) => t.id), ['g1']);
  assert.deepEqual((await s.glossary.list('fr-CA')).map((t) => t.id), ['g1', 'g2']);
  assert.equal(await s.glossary.remove('g2'), true);
  assert.equal(await s.glossary.remove('g2'), false);
});
