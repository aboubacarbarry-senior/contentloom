import 'reflect-metadata';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { verifySignature } from '../src/outbox';
import { SchedulerService } from '../src/scheduler';
import { EventBus, AppEvent } from '../src/events';
import { transition } from '../src/domain';
import { ADMIN, bootApp, brief, EDITOR, PUBLISHER, REVIEWER, REVIEWER2, TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function batchOf(app: TestApp, briefs: unknown[], headers = EDITOR) {
  const r = await request(app.http).post('/batches').set(headers).send({ briefs });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { batchId: string; itemIds: string[]; warnings: { message: string }[]; estimatedCostUsd: number };
}

test('CSV import builds briefs, reports bad rows and warns about thin briefs', async () => {
  t = await bootApp();
  const csv = [
    'sku;locale;category;must_mention;banned;name;material;size;care',
    'T-1;en-US;Textiles;cotton|50 x 60 in;waterproof;Sage Throw;cotton;50 x 60 in;machine wash cold',
    'T-1;fr-CA;textiles;coton;;Jeté Sage;coton;127 x 152 cm;lavable',
  ].join('\n');
  const ok = await request(t.http).post('/batches/csv').set(EDITOR).send({ csv, name: 'Spring throws' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.itemIds.length, 2);
  const item = await t.svc.get(ok.body.itemIds[0]);
  assert.equal(item.brief.category, 'textiles', 'categories are normalised');
  assert.deepEqual(item.brief.mustMention, ['cotton', '50 x 60 in']);
  assert.equal(item.brief.facts.material, 'cotton');
  const summary = await request(t.http).get(`/batches/${ok.body.batchId}`).set(EDITOR);
  assert.equal(summary.body.batch.name, 'Spring throws');
  assert.equal(summary.body.batch.source, 'csv');

  const bad = await request(t.http).post('/batches/csv').set(EDITOR).send({ csv: 'sku,locale,category,name\nX,de-DE,rugs,Rug\n,en-US,rugs,Rug' });
  assert.equal(bad.status, 400);
  assert.deepEqual(
    bad.body.details.errors.map((e: { row: number }) => e.row),
    [2, 3],
  );
  const missingCol = await request(t.http).post('/batches/csv').set(EDITOR).send({ csv: 'sku,name\nX,Rug' });
  assert.match(missingCol.body.message, /missing column "locale"/);

  const warned = await batchOf(t, [brief('W1', 'baby')]);
  assert.ok(warned.warnings.some((w) => /age range/.test(w.message)));
  const dup = await request(t.http).post('/batches').set(EDITOR).send({ briefs: [brief('D1'), brief('d1 ')] });
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /repeats/);
});

test('batch progress, completion event and cancellation', async () => {
  t = await bootApp();
  const events: AppEvent[] = [];
  t.app.get(EventBus).stream().subscribe((e) => events.push(e));
  const b = await batchOf(t, [brief('B1'), brief('B2'), brief('B3')]);
  let s = (await request(t.http).get(`/batches/${b.batchId}`).set(REVIEWER)).body;
  assert.equal(s.counts.queued, 3);
  assert.equal(s.done, false);
  await t.queue.drain();
  s = (await request(t.http).get(`/batches/${b.batchId}`).set(REVIEWER)).body;
  assert.equal(s.generated, 1);
  assert.equal(s.counts.auto_approved, 3);
  assert.ok(s.costUsd > 0, 'usage from the model calls is costed');
  const pub = await request(t.http).post(`/batches/${b.batchId}/publish`).set(PUBLISHER);
  assert.equal(pub.body.published.length, 3);
  assert.ok(events.some((e) => e.type === 'batch.completed' && e.batchId === b.batchId));
  assert.equal((await request(t.http).get(`/batches/${b.batchId}`).set(REVIEWER)).body.done, true);

  const c = await batchOf(t, [brief('C1'), brief('C2')]);
  const cancel = await request(t.http).post(`/batches/${c.batchId}/cancel`).set(EDITOR);
  assert.deepEqual(cancel.body, { cancelled: 2 });
  await t.queue.drain();
  assert.equal((await t.svc.get(c.itemIds[0])).status, 'cancelled');
  assert.equal(t.fake.calls.length, 6, 'cancelled items never reach the model');
  assert.equal((await request(t.http).post(`/batches/${c.batchId}/cancel`).set(EDITOR)).status, 409);
  const list = await request(t.http).get('/batches?limit=1').set(EDITOR);
  assert.equal(list.body.items.length, 1);
  assert.ok(list.body.nextCursor);
  assert.equal((await request(t.http).get('/batches/not-a-uuid').set(EDITOR)).status, 400);
});

test('reviewers lease items so two people never review the same draft', async () => {
  t = await bootApp({ leaseMs: 10 * 60_000 });
  t.fake.state.judge = { accuracy: 3, usefulness: 3, tone: 3 };
  const b = await batchOf(t, [brief('L1'), brief('L2')]);
  await t.queue.drain();
  const first = await request(t.http).post('/review/claim').set(REVIEWER).send({});
  assert.equal(first.status, 200);
  const second = await request(t.http).post('/review/claim').set(REVIEWER2).send({});
  assert.notEqual(second.body.id, first.body.id);
  const blocked = await request(t.http).post(`/items/${first.body.id}/review`).set(REVIEWER2).send({ decision: 'approve' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /being reviewed by rita/);
  assert.equal((await request(t.http).post(`/items/${first.body.id}/heartbeat`).set(REVIEWER)).status, 200);
  assert.equal((await request(t.http).post(`/items/${first.body.id}/heartbeat`).set(REVIEWER2)).status, 409);
  assert.equal((await request(t.http).post(`/items/${first.body.id}/release`).set(REVIEWER2)).status, 403);
  await request(t.http).post(`/items/${first.body.id}/release`).set(REVIEWER);
  assert.equal((await request(t.http).post(`/items/${first.body.id}/review`).set(REVIEWER2).send({ decision: 'approve' })).status, 201);
  // Leases expire: after 11 minutes anyone can take the other item.
  t.clock.advanceMinutes(11);
  const swept = await t.app.get(SchedulerService).expireLeases();
  assert.equal(swept, 1);
  const third = await request(t.http).post('/review/claim').set(REVIEWER).send({});
  assert.equal(third.body.id, second.body.id);
  await request(t.http).post(`/items/${third.body.id}/review`).set(REVIEWER).send({ decision: 'reject', note: 'too generic' });
  assert.equal((await request(t.http).post('/review/claim').set(REVIEWER).send({})).status, 204);
  const queue = await request(t.http).get('/review/queue').set(REVIEWER);
  assert.deepEqual(queue.body, []);
  assert.ok(b.itemIds.includes(first.body.id));
});

test('the detailed queue explains why each draft is waiting and filters by query', async () => {
  t = await bootApp();
  t.fake.state.generatorAddsClaim = 'It is fully waterproof. ';
  await batchOf(t, [brief('Q1'), { ...brief('Q2'), locale: 'es-US' }]);
  await t.queue.drain();
  const q = await request(t.http).get('/review/queue').query({ q: 'locale:es-US' }).set(REVIEWER);
  assert.equal(q.body.length, 1);
  assert.equal(q.body[0].item.brief.sku, 'Q2');
  assert.ok(q.body[0].reasons.includes('banned claim present'));
  const en = await request(t.http).get('/review/queue').query({ q: 'locale:en-US' }).set(REVIEWER);
  assert.ok(en.body[0].reasons.some((r: string) => r.startsWith('claim.waterproof')), 'English copy also trips the claim check');
  assert.equal((await request(t.http).get('/review/queue').query({ q: 'colour:red' }).set(REVIEWER)).status, 400);
});

test('comments anchor to the draft and can be resolved', async () => {
  t = await bootApp();
  t.fake.state.judge = { accuracy: 3, usefulness: 3, tone: 3 };
  const b = await batchOf(t, [brief('K1')]);
  await t.queue.drain();
  const id = b.itemIds[0];
  const c = await request(t.http).post(`/items/${id}/comments`).set(REVIEWER).send({ body: 'Size reads oddly', start: 0, end: 4 });
  assert.equal(c.status, 201);
  assert.equal((await request(t.http).post(`/items/${id}/comments`).set(REVIEWER).send({ body: 'x', start: 0, end: 100000 })).status, 400);
  assert.equal((await request(t.http).post(`/items/${id}/comments`).set(REVIEWER).send({ body: 'x', start: 1 })).status, 400);
  const queue = await request(t.http).get('/review/queue').set(REVIEWER);
  assert.equal(queue.body[0].openComments, 1);
  const r = await request(t.http).patch(`/comments/${c.body.id}`).set(REVIEWER).send({ resolved: true });
  assert.equal(r.body.resolved, true);
  const view = await request(t.http).get(`/items/${id}/view`).set(REVIEWER);
  assert.equal(view.body.comments.length, 1);
  assert.equal(view.body.diff, null);
});

test('approving with edits records a revision and a diff; lint checks edited text', async () => {
  t = await bootApp();
  t.fake.state.judge = { accuracy: 3, usefulness: 3, tone: 3 };
  const b = await batchOf(t, [brief('E1')]);
  await t.queue.drain();
  const id = b.itemIds[0];
  const lint = await request(t.http).post(`/items/${id}/lint`).set(REVIEWER).send({ text: 'A waterproof cotton throw, 50 x 70 in!' });
  assert.equal(lint.status, 200);
  assert.ok(lint.body.blocking >= 2);
  assert.ok(lint.body.findings.some((f: { code: string }) => f.code === 'units.mismatch'));
  const draft = (await t.svc.get(id)).draft!;
  const edited = draft.replace('easy to live with', 'easy to love');
  await request(t.http).post(`/items/${id}/review`).set(REVIEWER).send({ decision: 'approve', editedText: edited });
  const view = (await request(t.http).get(`/items/${id}/view`).set(PUBLISHER)).body;
  assert.equal(view.item.revisions.length, 2);
  assert.equal(view.item.revisions[1].source, 'reviewer');
  assert.ok(view.diff.some((o: { op: string; text: string }) => o.op === 'insert' && o.text.includes('love')));
  assert.ok(view.edits.editRatio > 0);
  assert.equal(view.item.history.at(-1).note, 'approved with edits');
});

test('publishing sends signed webhooks; failures retry, then go dead and can be retried', async () => {
  t = await bootApp({ webhooks: { urls: ['https://pim.example.com/hook', 'https://cms.example.com/hook'], secret: 'whsec', maxAttempts: 3 } });
  const b = await batchOf(t, [brief('P1')]);
  await t.queue.drain();
  await request(t.http).post(`/items/${b.itemIds[0]}/publish`).set(PUBLISHER);
  t.webhookStatus.push(200, 503);
  const sched = t.app.get(SchedulerService);
  const first = await sched.sweep();
  assert.deepEqual(first.outbox, { claimed: 2, delivered: 1, retried: 1, dead: 0 });
  const call = t.webhookCalls[0];
  assert.equal(call.headers['x-contentloom-event'], 'item.published');
  assert.ok(verifySignature('whsec', call.headers['x-contentloom-signature'], call.body, Math.floor(t.clock.now().getTime() / 1000)));
  const payload = JSON.parse(call.body);
  assert.equal(payload.data.sku, 'P1');
  assert.match(payload.data.text, /Sage Throw P1/);
  assert.equal(JSON.parse(t.webhookCalls[1].body).id, payload.id, 'both endpoints get the same event id');

  assert.deepEqual((await sched.sweep()).outbox.claimed, 0, 'the retry waits for its backoff');
  t.clock.advanceMinutes(1);
  t.webhookStatus.push(400);
  assert.deepEqual((await sched.sweep()).outbox, { claimed: 1, delivered: 0, retried: 0, dead: 1 });
  const box = await request(t.http).get('/outbox?status=dead').set(ADMIN);
  assert.equal(box.body.counts.dead, 1);
  const dead = box.body.items[0];
  assert.match(dead.lastError, /HTTP 400/);
  const retried = await request(t.http).post(`/outbox/${dead.id}/retry`).set(ADMIN);
  assert.equal(retried.body.status, 'pending');
  assert.deepEqual((await sched.sweep()).outbox.delivered, 1);
  assert.equal((await request(t.http).get('/outbox').set(PUBLISHER)).status, 401);
  const audit = await request(t.http).get('/audit?action=outbox.retry').set(ADMIN);
  assert.equal(audit.body.items.length, 1);
});

test('withdraw, regenerate and reopen', async () => {
  t = await bootApp();
  const b = await batchOf(t, [brief('W1'), brief('W2')]);
  await t.queue.drain();
  const [a, c] = b.itemIds;
  await request(t.http).post(`/items/${a}/publish`).set(PUBLISHER);
  assert.equal((await request(t.http).post(`/items/${a}/withdraw`).set(PUBLISHER).send({ reason: 'bad' })).status, 400);
  const w = await request(t.http).post(`/items/${a}/withdraw`).set(PUBLISHER).send({ reason: 'supplier changed the size' });
  assert.equal(w.body.status, 'withdrawn');
  const r = await request(t.http).post(`/items/${a}/regenerate`).set(EDITOR).send({ note: 'Use the new size' });
  assert.equal(r.body.status, 'queued');
  await t.queue.drain();
  const regenerated = await t.svc.get(a);
  assert.equal(regenerated.status, 'auto_approved');
  assert.match(t.fake.calls.filter((x) => !x.output_config.format).at(-1).messages[0].content, /Use the new size/);
  const reopened = await request(t.http).post(`/items/${c}/reopen`).set(PUBLISHER).send({ reason: 'tone is off for this brand' });
  assert.equal(reopened.body.status, 'in_review');
  assert.equal(reopened.body.finalText, null);
  assert.equal((await request(t.http).post(`/items/${c}/regenerate`).set(EDITOR).send({})).status, 409);
});

test('glossary terms steer generation and block forbidden words', async () => {
  t = await bootApp();
  const add = await request(t.http).post('/glossary').set(ADMIN).send({ locale: 'en-US', term: 'rooms', kind: 'forbidden', replacement: 'spaces' });
  assert.equal(add.status, 201);
  assert.equal((await request(t.http).post('/glossary').set(ADMIN).send({ locale: 'en-US', term: 'Rooms', kind: 'forbidden' })).status, 409);
  assert.equal((await request(t.http).post('/glossary').set(EDITOR).send({ locale: 'en-US', term: 'x', kind: 'forbidden' })).status, 401);
  const b = await batchOf(t, [brief('G1')]);
  await t.queue.drain();
  const item = await t.svc.get(b.itemIds[0]);
  assert.equal(item.status, 'in_review', 'the fake writer uses the forbidden word "rooms"');
  assert.ok(item.score!.findings!.some((f) => f.code === 'glossary.forbidden'));
  assert.match(t.fake.calls[0].system[0].text, /Never use "rooms" \(use "spaces"\)/);
  const preview = await request(t.http).post('/glossary/preview').set(EDITOR).send({ brief: brief('G2'), text: 'Fits most rooms.' });
  assert.equal(preview.body.findings[0].code, 'glossary.forbidden');
  const imp = await request(t.http).post('/glossary/import').set(ADMIN).send({ terms: [{ locale: 'fr-CA', term: 'email', kind: 'preferred', replacement: 'courriel' }, { locale: 'en-US', term: 'rooms', kind: 'forbidden' }, { locale: 'fr-CA', term: 'x', kind: 'preferred' }] });
  assert.deepEqual(imp.body, { added: 1, skipped: 1, errors: [{ row: 3, message: 'a preferred term needs a replacement' }] });
  assert.equal((await request(t.http).delete(`/glossary/${add.body.id}`).set(ADMIN)).status, 204);
  assert.equal((await request(t.http).get('/glossary?locale=en-US').set(EDITOR)).body.length, 0);
});

test('admins tune the routing policy at runtime, and the change is audited', async () => {
  t = await bootApp();
  t.fake.state.judge = { accuracy: 4, usefulness: 4, tone: 4 }; // judge 0.75 → total 0.9
  const before = await batchOf(t, [brief('R1')]);
  await t.queue.drain();
  assert.equal((await t.svc.get(before.itemIds[0])).status, 'auto_approved');
  const patch = await request(t.http).patch('/policy').set(ADMIN).send({ categoryThresholds: { textiles: 0.95, unicorns: 0.5 } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.warnings.length, 1);
  const after = await batchOf(t, [brief('R2')]);
  await t.queue.drain();
  const item = await t.svc.get(after.itemIds[0]);
  assert.equal(item.status, 'in_review');
  assert.deepEqual(item.routing!.reasons, ['score 0.900 below 0.95']);
  assert.equal((await request(t.http).patch('/policy').set(ADMIN).send({ sampleRate: 2 })).status, 400);
  assert.equal((await request(t.http).patch('/policy').set(REVIEWER).send({ sampleRate: 0.2 })).status, 401);
  const audit = await request(t.http).get('/audit?subject=policy').set(ADMIN);
  assert.equal(audit.body.items[0].detail.after.categoryThresholds.textiles, 0.95);
  const pol = await request(t.http).get('/policy').set(REVIEWER);
  assert.equal(pol.body.effectiveThresholds.textiles, 0.95);
  assert.equal(pol.body.effectiveThresholds.rugs, 0.85);
});

test('exports and search', async () => {
  t = await bootApp();
  const b = await batchOf(t, [brief('X1'), { ...brief('X2'), locale: 'es-US', facts: { name: 'Manta "Sage"', material: 'algodón', size: '50 x 60 in', care: 'lavar en frío' }, mustMention: ['algodón'] }]);
  await t.queue.drain();
  for (const id of b.itemIds) await request(t.http).post(`/items/${id}/publish`).set(PUBLISHER);
  const csv = await request(t.http).get('/exports/published?locale=es-US').set(PUBLISHER);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.headers['x-row-count'], '1');
  assert.ok(csv.text.startsWith('﻿sku,locale,category,text'));
  assert.match(csv.text, /"Meet the Manta ""Sage"", made from algodón/);
  const jsonl = await request(t.http).get('/exports/published?format=jsonl').set(PUBLISHER);
  assert.equal(jsonl.text.trim().split('\n').length, 2);
  assert.equal((await request(t.http).get('/exports/published?format=xml').set(PUBLISHER)).status, 400);
  assert.equal((await request(t.http).get('/exports/published').set(REVIEWER)).status, 401);
  const found = await request(t.http).get('/items').query({ q: 'status:published locale:en-US' }).set(REVIEWER);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.query, 'status:published locale:en-US');
  const text = await request(t.http).get('/items').query({ q: '"manta"' }).set(REVIEWER);
  assert.equal(text.body.items[0].brief.sku, 'X2');
  assert.equal((await request(t.http).get('/items').query({ q: 'status:bogus' }).set(REVIEWER)).status, 400);
});

test('the daily budget defers generation to the next UTC day instead of failing it', async () => {
  t = await bootApp({ dailyBudgetUsd: 0.01 });
  // Each item costs two calls at 1000 in / 200 out tokens: $0.008 + $0.008.
  const events: AppEvent[] = [];
  t.app.get(EventBus).stream(['budget.exceeded']).subscribe((e) => events.push(e));
  const b = await batchOf(t, [brief('M1'), brief('M2')]);
  await t.queue.drain();
  assert.equal((await t.svc.get(b.itemIds[0])).status, 'auto_approved');
  assert.equal((await t.svc.get(b.itemIds[1])).status, 'queued', 'over budget: waits');
  assert.equal(events.length, 1);
  assert.deepEqual(await t.queue.stats(), { waiting: 0, delayed: 1, active: 0, failed: 0 });
  const health = await request(t.http).get('/health');
  assert.equal(health.body.budget.remainingUsd, 0);
  t.clock.set('2026-03-03T00:00:01.000Z');
  await t.queue.drain();
  assert.equal((await t.svc.get(b.itemIds[1])).status, 'auto_approved');
  const daily = await request(t.http).get('/metrics/daily?days=2').set(EDITOR);
  assert.deepEqual(
    daily.body.map((d: { day: string; costUsd: number }) => [d.day, d.costUsd]),
    [
      ['2026-03-02', 0.016],
      ['2026-03-03', 0.016],
    ],
  );
});

test('refusals fail at once; the scheduler rescues items stuck in generating', async () => {
  t = await bootApp();
  t.fake.state.refuseNext = true;
  const b = await batchOf(t, [brief('F1')]);
  await t.queue.drain();
  const failed = await t.svc.get(b.itemIds[0]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1, 'a refusal is not retried');
  assert.match(failed.lastError!, /declined \(cyber\)/);
  const retry = await request(t.http).post(`/batches/${b.batchId}/retry-failed`).set(EDITOR);
  assert.deepEqual(retry.body, { requeued: 1 });
  await t.queue.drain();
  assert.equal((await t.svc.get(b.itemIds[0])).status, 'auto_approved');

  // Simulate a worker that died after claiming an item.
  const s = await batchOf(t, [brief('S1')]);
  const stuck = await t.store.items.get(s.itemIds[0]);
  transition(stuck!, 'generating', 'worker', t.clock.now());
  await t.store.items.save(stuck!);
  const sched = t.app.get(SchedulerService);
  assert.deepEqual(await sched.recoverStuck(), { requeued: 0, failed: 0 }, 'not stuck yet');
  t.clock.advanceMinutes(30);
  assert.deepEqual(await sched.recoverStuck(), { requeued: 1, failed: 0 });
  await t.queue.drain();
  assert.equal((await t.svc.get(s.itemIds[0])).status, 'auto_approved');
});

test('metrics: overview, calibration and reference data', async () => {
  t = await bootApp();
  t.rolls.push(0.01);
  const b = await batchOf(t, [brief('N1'), brief('N2', 'baby')]);
  await t.queue.drain();
  await request(t.http).post(`/items/${b.itemIds[0]}/review`).set(REVIEWER).send({ decision: 'approve' });
  t.clock.advanceMinutes(12);
  await request(t.http).post(`/items/${b.itemIds[1]}/review`).set(REVIEWER).send({ decision: 'revise', note: 'Add the age range please' });
  const m = (await request(t.http).get('/metrics')).body;
  assert.equal(m.autoApprovePrecision, 1);
  assert.deepEqual(m.qaSample, { sampled: 1, decided: 1, approved: 1 });
  assert.equal(m.review.decided, 2);
  assert.equal(m.review.revised, 1);
  assert.equal(m.review.medianMinutesInReview, 6);
  assert.equal(m.reviewers[0].reviewer, 'rita');
  assert.ok(m.byCategory.some((g: { key: string }) => g.key === 'baby'));
  assert.ok(m.findings.some((f: { code: string }) => f.code === 'brief.incomplete'));
  const cal = await request(t.http).get('/metrics/calibration').set(REVIEWER);
  assert.equal(cal.body.current, 0.85);
  assert.equal(cal.body.recommendation.threshold, null);
  const meta = (await request(t.http).get('/meta')).body;
  assert.ok(meta.categories.some((c: { id: string; regulated: boolean }) => c.id === 'supplements' && c.regulated));
  assert.equal(meta.locales.length, 3);
  assert.ok(meta.checks.length >= 10);
  const exp = await request(t.http).get('/metrics/experiments').set(EDITOR);
  assert.equal(exp.body.experimentId, null);
});
