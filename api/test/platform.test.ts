import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuery, lex, parseQuery, QueryError } from '../src/search';
import { loadConfig, parseExperiment } from '../src/config';
import { armStats, assignVariant, bucket, experimentReport, normalCdf, twoProportionTest, validateExperiment } from '../src/experiments';
import { calibration, percentile, range, recommendThreshold, wilsonInterval } from '../src/metrics';
import { applyPolicyPatch } from '../src/policy';
import { backoffMs, retryableStatus, sign, verifySignature } from '../src/outbox';
import { buildItemWhere, likeEscape, orderBy } from '../src/postgres';
import { checksum, loadMigrations } from '../src/migrate';
import { BudgetGuard, costUsd, estimateBatchCost, MemoryLedger, nextUtcMidnight, priceFor, usageFromResponse } from '../src/usage';
import { ManualClock } from '../src/clock';
import { BudgetExceededError, describeError, isRetryable } from '../src/errors';
import { Item, newItem, transition } from '../src/domain';
import { redact } from '../src/audit';
import { principalFrom } from '../src/auth';
import { brief } from './helpers';

test('search language: filters, ranges, negation and text', () => {
  const q = parseQuery('status:in_review category:baby,electrical score<0.7 locale:fr-CA sku:SAGE-* "pre-washed cotton" sort:score_asc');
  assert.deepEqual(q.status, ['in_review']);
  assert.deepEqual(q.category, ['baby', 'electrical']);
  assert.ok(q.maxScore! < 0.7 && q.maxScore! > 0.699);
  assert.deepEqual(q.locale, ['fr-CA']);
  assert.equal(q.sku, 'SAGE-*');
  assert.equal(q.text, 'pre-washed cotton');
  assert.equal(q.sort, 'score_asc');
  const neg = parseQuery('-status:published,cancelled');
  assert.ok(!neg.status!.includes('published') && neg.status!.includes('in_review'));
  assert.deepEqual(parseQuery('created:2026-03-01'), { createdAfter: '2026-03-01T00:00:00.000Z', createdBefore: '2026-03-02T00:00:00.000Z' });
  assert.deepEqual(parseQuery('sampled:yes finding:claim. variant:concise'), { sampled: true, finding: 'claim.', variant: 'concise' });
  assert.deepEqual(parseQuery(''), {});
});

test('search language errors point at the problem', () => {
  assert.throws(() => parseQuery('status:nope'), QueryError);
  assert.throws(() => parseQuery('colour:red'), /unknown filter "colour"/);
  assert.throws(() => parseQuery('score>2'), /between 0 and 1/);
  assert.throws(() => parseQuery('"open quote'), /unterminated/);
  assert.throws(() => parseQuery('-cotton'), /negation only works on status/);
  assert.throws(() => parseQuery('score>0.9 score<0.5'), /score range is empty/);
  try {
    parseQuery('status:in_review locale:de-DE');
    assert.fail('should throw');
  } catch (e) {
    assert.equal((e as QueryError).position, 17);
  }
  assert.deepEqual(lex('a:"b c" d').map((t) => [t.key, t.value]), [
    ['a', 'b c'],
    [null, 'd'],
  ]);
});

test('formatQuery round-trips', () => {
  const s = 'status:in_review,failed category:rugs locale:es-US sku:A1 score>=0.5 score<=0.9 finding:units sampled:no sort:created_desc "red rug"';
  assert.deepEqual(parseQuery(formatQuery(parseQuery(s))), parseQuery(s));
});

test('configuration parsing and validation', () => {
  const c = loadConfig({ AUTO_APPROVE_AT: '0.9', CATEGORY_THRESHOLDS: 'furniture=0.92, rugs=0.88', DAILY_BUDGET_USD: '25', SCHEDULER_ENABLED: 'yes' });
  assert.equal(c.policy.autoApproveAt, 0.9);
  assert.deepEqual(c.policy.categoryThresholds, { furniture: 0.92, rugs: 0.88 });
  assert.equal(c.dailyBudgetUsd, 25);
  assert.equal(c.scheduler.enabled, true);
  assert.equal(c.databaseUrl, null);
  assert.throws(() => loadConfig({ AUTO_APPROVE_AT: '1.5' }), /between 0 and 1/);
  assert.throws(() => loadConfig({ PORT: 'eighty' }), /PORT: not a number/);
  assert.throws(() => loadConfig({ WEBHOOK_URLS: 'https://pim.example.com/hook' }), /WEBHOOK_SECRET is required/);
  assert.throws(() => loadConfig({ WEBHOOK_URLS: 'http://pim.example.com/hook', WEBHOOK_SECRET: 's' }), /https/);
  assert.equal(loadConfig({ WEBHOOK_URLS: 'http://localhost:9000/x', WEBHOOK_SECRET: 's' }).webhooks.urls.length, 1);
  assert.deepEqual(parseExperiment('copy-test:control=50,benefit_led=50'), { id: 'copy-test', arms: [{ variant: 'control', share: 50 }, { variant: 'benefit_led', share: 50 }] });
  assert.throws(() => parseExperiment('x:control=50,concise=40'), /add up to 90/);
  assert.equal(parseExperiment(''), null);
});

test('experiments: stable assignment, z-test, arm stats', () => {
  const exp = { id: 'copy-test', arms: [{ variant: 'control', share: 50 }, { variant: 'concise', share: 50 }] };
  assert.equal(assignVariant(exp, 'SKU-1'), assignVariant(exp, ' sku-1 '), 'assignment ignores case and spaces');
  assert.equal(assignVariant(null, 'SKU-1'), 'control');
  const counts = { control: 0, concise: 0 } as Record<string, number>;
  for (let i = 0; i < 2000; i++) counts[assignVariant(exp, `SKU-${i}`)]++;
  assert.ok(counts.control > 900 && counts.concise > 900, JSON.stringify(counts));
  assert.ok(bucket('a', 'b') >= 0 && bucket('a', 'b') < 100);
  assert.deepEqual(validateExperiment({ id: 'x', arms: [{ variant: 'nope', share: 100 }] }), ['unknown variant "nope"', 'an experiment needs a control arm']);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  const t = twoProportionTest(50, 100, 70, 100)!;
  assert.ok(t.z > 2.8 && t.z < 2.9, `z=${t.z}`);
  assert.ok(t.p < 0.01);
  assert.equal(twoProportionTest(0, 0, 1, 1), null);

  const decided = (variant: string, edited: boolean): Item => {
    const i = newItem(`${variant}-${Math.random()}`, 'b', brief('E'), new Date(), variant);
    i.draft = 'one two three';
    for (const s of ['generating', 'scored', 'in_review'] as const) transition(i, s, 'x');
    transition(i, 'approved', 'rita');
    i.finalText = edited ? 'one four three' : 'one two three';
    return i;
  };
  const stats = armStats('control', [decided('control', false), decided('control', true)]);
  assert.equal(stats.approvedClean, 1);
  assert.equal(stats.approvedEdited, 1);
  assert.equal(stats.cleanApprovalRate, 0.5);
  assert.ok(stats.meanEditRatio! > 0);
  const report = experimentReport(exp, [decided('control', false), decided('concise', true)]);
  assert.equal(report.comparisons[0].variant, 'concise');
  assert.equal(report.comparisons[0].lift, -1);
  assert.match(report.note, /Fewer than 100/);
});

test('statistics: Wilson interval, percentiles, calibration', () => {
  assert.equal(wilsonInterval(0, 0), null);
  const w = wilsonInterval(95, 100)!;
  assert.ok(w.low > 0.88 && w.low < 0.9 && w.high > 0.97 && w.high < 0.99, JSON.stringify(w));
  assert.deepEqual(wilsonInterval(10, 10), { low: 0.722, high: 1 });
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(range(0.7, 0.76, 0.02), [0.7, 0.72, 0.74, 0.76]);

  // 40 drafts scored 0.9 (all approved) and 40 scored 0.8 (half rejected), reviewed only for their score.
  const items: Item[] = [];
  for (let n = 0; n < 80; n++) {
    const hi = n < 40;
    const i = newItem(`c${n}`, 'b', brief('C'), new Date());
    i.score = { facts: 1, claims: 1, length: 1, judge: 1, total: hi ? 0.9 : 0.8, notes: [], findings: [] };
    i.routing = { decision: 'in_review', reasons: [hi ? 'QA sample' : 'score 0.800 below 0.85'], sampled: hi, threshold: 0.85 };
    for (const s of ['generating', 'scored', 'in_review'] as const) transition(i, s, 'x');
    transition(i, hi || n % 2 ? 'approved' : 'rejected', 'rita');
    items.push(i);
  }
  const rows = calibration(items, { autoApproveAt: 0.85, sampleRate: 0.1 }, [0.8, 0.9]);
  assert.deepEqual(
    rows.map((r) => [r.threshold, r.n, r.approved, r.precision]),
    [
      [0.8, 80, 60, 0.75],
      [0.9, 40, 40, 1],
    ],
  );
  assert.equal(rows[0].coverage, 1);
  assert.equal(rows[1].coverage, 0.5);
  assert.equal(recommendThreshold(rows, 0.9).threshold, 0.9);
  assert.equal(recommendThreshold(rows, 0.99).threshold, null);
  assert.match(recommendThreshold(rows, 0.9, 500).reason, /not enough/);
});

test('policy patches validate and audit-friendly copies', () => {
  const base = { autoApproveAt: 0.85, sampleRate: 0.1, categoryThresholds: { rugs: 0.9 } };
  const next = applyPolicyPatch(base, { autoApproveAt: 0.88, categoryThresholds: { rugs: null, furniture: 0.92 }, alwaysReview: ['toys', 'toys'] });
  assert.deepEqual(next, { autoApproveAt: 0.88, sampleRate: 0.1, categoryThresholds: { furniture: 0.92 }, alwaysReview: ['toys'] });
  assert.deepEqual(base.categoryThresholds, { rugs: 0.9 }, 'the old policy is not mutated');
  assert.throws(() => applyPolicyPatch(base, { sampleRate: 0 }), /leaves auto-approval unmeasured/);
  assert.throws(() => applyPolicyPatch(base, { categoryThresholds: { 'Bad Cat': 0.5 } }), /bad category id/);
});

test('webhook signatures and retry schedule', () => {
  const body = JSON.stringify({ id: 'e1', type: 'item.published' });
  const header = sign('s3cret', 1_700_000_000, body);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.ok(verifySignature('s3cret', header, body, 1_700_000_100));
  assert.ok(!verifySignature('s3cret', header, body, 1_700_000_400), 'too old: replay protection');
  assert.ok(!verifySignature('other', header, body, 1_700_000_000));
  assert.ok(!verifySignature('s3cret', header, `${body} `, 1_700_000_000));
  assert.ok(!verifySignature('s3cret', 'garbage', body, 1_700_000_000));
  assert.equal(backoffMs(1, () => 0.5), 30_000);
  assert.equal(backoffMs(3, () => 0.5), 120_000);
  assert.equal(backoffMs(30, () => 0.5), 6 * 3_600_000, 'capped at six hours');
  assert.equal(backoffMs(1, () => 0), 24_000);
  assert.ok(retryableStatus(503) && retryableStatus(429) && !retryableStatus(400) && !retryableStatus(410));
});

test('SQL filters are parameterised and escape LIKE wildcards', () => {
  const w = buildItemWhere({ status: ['in_review'], sku: '50%_OFF*', minScore: 0.5, text: 'a_b', finding: 'claim.', sampled: true }, 3);
  assert.equal(
    w.clause,
    "status = any($3::text[]) and lower(sku) like $4 and score_total >= $5 and lower(sku || ' ' || coalesce(doc ->> 'draft', '') || ' ' || coalesce(doc ->> 'finalText', '')) like $6 and exists (select 1 from jsonb_array_elements(coalesce(doc -> 'score' -> 'findings', '[]'::jsonb)) f where f ->> 'code' like $7) and sampled = $8",
  );
  assert.deepEqual(w.params, [['in_review'], '50\\%\\_off%', 0.5, '%a\\_b%', 'claim.%', true]);
  assert.deepEqual(buildItemWhere({}), { clause: 'true', params: [] });
  assert.equal(likeEscape('100%'), '100\\%');
  assert.equal(orderBy('score_asc'), 'score_total asc nulls first, created_at asc, id asc');
});

test('migrations load in order with stable checksums', () => {
  const ms = loadMigrations();
  assert.deepEqual(ms.map((m) => m.version), ['001', '002']);
  assert.equal(checksum('select 1;\r\n'), checksum('select 1;\n'), 'line endings do not change the checksum');
  assert.match(ms[0].sql, /create table if not exists items/);
});

test('usage, pricing and the daily budget guard', async () => {
  assert.equal(costUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, priceFor('claude-opus-5-5')), 4);
  assert.equal(priceFor('unknown-model').input, 4, 'unknown models fall back to the default price');
  const u = usageFromResponse({ model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: null } });
  assert.deepEqual(u, { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.0016 });
  assert.ok(estimateBatchCost(100) > 0);
  assert.equal(nextUtcMidnight(new Date('2026-03-02T23:59:00Z')).toISOString(), '2026-03-03T00:00:00.000Z');

  const clock = new ManualClock('2026-03-02T09:00:00Z');
  const ledger = new MemoryLedger();
  const guard = new BudgetGuard(ledger, clock, 1);
  await guard.assertAvailable();
  await guard.record({ ...u, costUsd: 1.2 });
  await assert.rejects(guard.assertAvailable(), (e: unknown) => e instanceof BudgetExceededError && e.resumeAt.toISOString() === '2026-03-03T00:00:00.000Z');
  assert.deepEqual(await guard.status(), { day: '2026-03-02', spentUsd: 1.2, limitUsd: 1, remainingUsd: 0 });
  clock.advance(15 * 3_600_000);
  await guard.assertAvailable();
  assert.equal((await ledger.range('2026-03-01', '2026-03-03')).length, 1);
  const off = new BudgetGuard(ledger, clock, 0);
  assert.equal(off.enabled, false);
  assert.equal((await off.status()).limitUsd, null);
});

test('errors: retryability and safe descriptions', () => {
  assert.equal(isRetryable(Object.assign(new Error('rate'), { status: 429 })), true);
  assert.equal(isRetryable(Object.assign(new Error('bad'), { status: 400 })), false);
  assert.equal(isRetryable(Object.assign(new Error('down'), { status: 503 })), true);
  assert.equal(isRetryable(new Error('socket hang up')), true);
  assert.equal(describeError(new TypeError('x\n  at stack')), 'TypeError: x at stack');
  assert.equal(describeError('a'.repeat(600)).length, 500);
});

test('audit redaction and gateway principals', () => {
  assert.deepEqual(redact({ webhookSecret: 'x', nested: { apiKey: 'k', ok: 1 }, list: [1] }), { webhookSecret: '[redacted]', nested: { apiKey: '[redacted]', ok: 1 }, list: [1] });
  const p = principalFrom({ 'x-user': 'rita', 'x-roles': 'Reviewer, publisher, wizard' })!;
  assert.deepEqual([...p.roles].sort(), ['publisher', 'reviewer']);
  assert.equal(principalFrom({ 'x-user': 'bad user!' }), null);
  assert.equal(principalFrom({}), null);
});
