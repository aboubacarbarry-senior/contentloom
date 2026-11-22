import 'reflect-metadata';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { TokenBucket, RateLimiter } from '../src/ratelimit';
import { ManualClock } from '../src/clock';
import { SchedulerService } from '../src/scheduler';
import { AppEvent, EventBus } from '../src/events';
import { bootApp, brief, EDITOR, REVIEWER, TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

test('token buckets refill at the configured rate', () => {
  const b = new TokenBucket(2, 2 / 60_000, 0);
  assert.equal(b.take(0), 0);
  assert.equal(b.take(0), 0);
  assert.equal(b.take(0), 30_000, 'empty: the next token comes in 30 s');
  assert.equal(b.take(30_000), 0);
  assert.ok(!b.idle(30_000));
  assert.ok(b.idle(120_000));
  const clock = new ManualClock();
  const off = new RateLimiter(0, clock);
  for (let i = 0; i < 100; i++) assert.equal(off.check('x'), 0, 'a limit of 0 disables the limiter');
});

test('batch creation is rate-limited per user with a Retry-After header', async () => {
  t = await bootApp({ batchRatePerMinute: 2 });
  const send = (headers: Record<string, string>, sku: string) => request(t!.http).post('/batches').set(headers).send({ briefs: [brief(sku)] });
  assert.equal((await send(EDITOR, 'R1')).status, 201);
  assert.equal((await send(EDITOR, 'R2')).status, 201);
  const limited = await send(EDITOR, 'R3');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '30');
  assert.match(limited.body.message, /too many batches/);
  assert.equal((await send({ 'x-user': 'other-editor', 'x-roles': 'editor' }, 'R4')).status, 201, 'limits are per user');
  assert.equal((await send(REVIEWER, 'R5')).status, 401, 'role checks come first and do not use up tokens');
  t.clock.advance(30_000);
  assert.equal((await send(EDITOR, 'R6')).status, 201);
  const csv = await request(t.http).post('/batches/csv').set(EDITOR).send({ csv: 'sku,locale,category,name\nZ1,en-US,decor,Vase' });
  assert.equal(csv.status, 429, 'CSV imports count against the same limit');
});

test('a draft that disagrees with its other locales goes to review', async () => {
  t = await bootApp();
  // English first, with the right size.
  const en = await request(t.http).post('/batches').set(EDITOR).send({ briefs: [brief('LOC-1')] });
  await t.queue.drain();
  assert.equal((await t.svc.get(en.body.itemIds[0])).status, 'auto_approved');
  // The French brief carries a different size: the French draft is fine against its own facts…
  const fr = await request(t.http)
    .post('/batches')
    .set(EDITOR)
    .send({ briefs: [{ ...brief('LOC-1'), locale: 'fr-CA', facts: { name: 'Jeté Sage', material: 'coton', size: '127 x 180 cm', care: 'lavable à froid' }, mustMention: ['coton'] }] });
  await t.queue.drain();
  const item = await t.svc.get(fr.body.itemIds[0]);
  // …but not against the English copy, so a person sees it.
  assert.equal(item.status, 'in_review');
  const f = item.score!.findings!.find((x) => x.code === 'locale.mismatch')!;
  assert.equal(f.severity, 'block');
  assert.match(f.message, /says 127 x 180 cm but the en-US copy says 50 x 60 in/);
  // A consistent Spanish version is not flagged.
  const es = await request(t.http).post('/batches').set(EDITOR).send({ briefs: [{ ...brief('LOC-1'), locale: 'es-US' }] });
  await t.queue.drain();
  assert.equal((await t.svc.get(es.body.itemIds[0])).status, 'auto_approved');
});

test('drafts waiting past the review SLA are flagged once', async () => {
  t = await bootApp({ reviewSlaMs: 2 * 3_600_000 });
  t.fake.state.judge = { accuracy: 3, usefulness: 3, tone: 3 };
  const events: AppEvent[] = [];
  t.app.get(EventBus).stream(['review.overdue']).subscribe((e) => events.push(e));
  const b = await request(t.http).post('/batches').set(EDITOR).send({ briefs: [brief('SLA-1'), brief('SLA-2')] });
  await t.queue.drain();
  const sched = t.app.get(SchedulerService);
  assert.equal(await sched.flagOverdue(), 0);
  let q = await request(t.http).get('/review/queue').set(REVIEWER);
  assert.deepEqual(q.body.map((e: { overdue: boolean }) => e.overdue), [false, false]);
  t.clock.advanceMinutes(121);
  await request(t.http).post(`/items/${b.body.itemIds[1]}/review`).set(REVIEWER).send({ decision: 'approve' });
  assert.equal(await sched.flagOverdue(), 1);
  assert.equal(await sched.flagOverdue(), 0, 'announced once');
  assert.equal(events.length, 1);
  assert.equal(events[0].type === 'review.overdue' && events[0].sku, 'SLA-1');
  q = await request(t.http).get('/review/queue').set(REVIEWER);
  assert.equal(q.body[0].overdue, true);
  assert.equal(q.body[0].enteredAt, '2026-03-02T09:00:00.000Z');
  const m = (await request(t.http).get('/metrics')).body;
  assert.equal(m.review.overdue, 1);
  assert.equal(m.review.slaHours, 2);
  const sweep = await sched.sweep();
  assert.equal(sweep.overdue, 0);
});

test('batch report: findings, reasons, outcomes per locale and errors', async () => {
  t = await bootApp();
  t.fake.state.generatorAddsClaim = 'It is fully waterproof. ';
  const b = await request(t.http)
    .post('/batches')
    .set(EDITOR)
    .send({ briefs: [brief('REP-1'), { ...brief('REP-1'), locale: 'es-US' }, brief('REP-2')] });
  await t.queue.drain();
  const [a, , c] = b.body.itemIds;
  await request(t.http).post(`/items/${a}/review`).set(REVIEWER).send({ decision: 'approve', editedText: 'A cotton throw, 50 x 60 in.' });
  await request(t.http).post(`/items/${c}/review`).set(REVIEWER).send({ decision: 'reject', note: 'bad claim' });
  const r = await request(t.http).get(`/batches/${b.body.batchId}/report`).set(EDITOR);
  assert.equal(r.status, 200);
  const banned = r.body.findings.find((f: { code: string }) => f.code === 'claim.banned');
  assert.deepEqual(banned, { code: 'claim.banned', items: 3, blocking: 3 });
  assert.equal(r.body.reasons[0].reason, 'banned claim present');
  assert.equal(r.body.reasons[0].items, 3);
  assert.deepEqual(
    r.body.locales.map((l: { locale: string; items: number; reviewed: number }) => [l.locale, l.items, l.reviewed]),
    [
      ['en-US', 2, 2],
      ['es-US', 1, 0],
    ],
  );
  assert.equal(r.body.edits.edited, 1);
  assert.ok(r.body.edits.meanEditRatio > 0.5);
  assert.equal((await request(t.http).get('/whoami').set(REVIEWER)).body.user, 'rita');
  assert.deepEqual((await request(t.http).get('/whoami')).body, { user: null, roles: [] });
});

test('bulk actions apply per item and report failures without stopping', async () => {
  t = await bootApp();
  const b = await request(t.http).post('/batches').set(EDITOR).send({ briefs: [brief('BULK-1'), brief('BULK-2'), brief('BULK-3')] });
  await t.queue.drain();
  const [a, c, d] = b.body.itemIds;
  await request(t.http).post(`/items/${d}/publish`).set({ 'x-user': 'pat', 'x-roles': 'publisher' });
  const PUB = { 'x-user': 'pat', 'x-roles': 'publisher' };
  const r = await request(t.http).post('/items/bulk').set(PUB).send({ action: 'publish', ids: [a, c, d] });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.done.map((x: { status: string }) => x.status),
    ['published', 'published'],
  );
  assert.deepEqual(r.body.failed, [{ id: d, error: 'item is published' }]);
  assert.equal((await request(t.http).post('/items/bulk').set(PUB).send({ action: 'withdraw', ids: [a] })).status, 400, 'withdraw needs a reason');
  const w = await request(t.http).post('/items/bulk').set(PUB).send({ action: 'withdraw', ids: [a, c], reason: 'supplier recall' });
  assert.equal(w.body.done.length, 2);
  assert.equal((await request(t.http).post('/items/bulk').set(PUB).send({ action: 'regenerate', ids: [a] })).status, 403, 'publishers cannot regenerate');
  const regen = await request(t.http).post('/items/bulk').set(EDITOR).send({ action: 'regenerate', ids: [a, c], reason: 'new supplier facts' });
  assert.equal(regen.body.done.length, 2);
  assert.equal((await request(t.http).post('/items/bulk').set(EDITOR).send({ action: 'publish', ids: ['not-a-uuid'] })).status, 400);
});
