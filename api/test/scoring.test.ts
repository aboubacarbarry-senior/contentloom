import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, deterministicScore, judgeScore, mentionKey, missingMentions, runChecks, sortFindings } from '../src/checks';
import { categoryRule, effectiveBanned, missingRequiredFacts, normalizeFactKey } from '../src/categories';
import { decideRoute, Item, newItem, reviewOutcome, reviewReasons, reviewSpan, transition, wasSampled } from '../src/domain';
import { applyPreferred, checkGlossary, glossaryConflicts, glossaryInstructions, GlossaryTerm, validateTerm } from '../src/glossary';
import { buildGeneration, buildJudge, cleanDraft, VARIANTS } from '../src/prompts';
import { generateDraft, judgeDraft, ModelRefusalError, scoreDraft } from '../src/llm';
import { brief, fakeClient } from './helpers';

const GOOD =
  'Meet the Sage Throw G1, made from cotton and measuring 50 x 60 in. It is easy to live with and suits most rooms, bringing quiet texture ' +
  'to everyday spaces without demanding attention. Care is simple: machine wash cold. A practical choice for daily use that should look ' +
  'good for years with very little effort from you.';

const term = (t: Partial<GlossaryTerm>): GlossaryTerm => ({
  id: t.id ?? Math.random().toString(36).slice(2),
  locale: 'en-US',
  term: 'x',
  kind: 'forbidden',
  replacement: null,
  note: null,
  caseSensitive: false,
  createdBy: 'ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...t,
});

test('a clean draft has no blocking findings and the original components', () => {
  const d = deterministicScore(brief('G1'), GOOD);
  assert.deepEqual([d.facts, d.claims, d.length], [1, 1, 1]);
  assert.deepEqual(d.findings.filter((f) => f.severity === 'block'), []);
  assert.ok(d.readability !== null && d.readability > 50);
  assert.equal(combine(d, 1), 1);
  assert.equal(combine(d, null), 0, 'no verdict means no auto-approval');
});

test('must-mention matching ignores case, accents, spacing and the multiplication sign', () => {
  assert.equal(mentionKey('50 × 60 IN'), mentionKey('50x60 in'));
  assert.deepEqual(missingMentions({ ...brief('M1'), mustMention: ['Algodón', '50 x 60 in'] }, 'algodon throw, 50×60 in'), []);
  assert.deepEqual(missingMentions(brief('M2'), 'cotton only'), ['50 x 60 in']);
});

test('category rules add banned claims and required facts', () => {
  assert.deepEqual(effectiveBanned('rugs', ['Waterproof', 'non-slip']), ['Waterproof', 'non-slip', 'stain-proof', 'pet-proof']);
  assert.deepEqual(missingRequiredFacts('furniture', { Name: 'Alder', Materials: 'oak', Size: '18 x 18 in' }), [], 'size satisfies dimensions; keys match loosely');
  assert.deepEqual(missingRequiredFacts('baby', { name: 'Crib sheet', material: 'cotton' }), ['age range']);
  assert.equal(normalizeFactKey(' Care_Instructions '), 'care instruction');
  assert.equal(categoryRule('unknown-thing').label, 'General merchandise');
  assert.equal(categoryRule('supplements').regulated, true);
  const d = deterministicScore(brief('R1', 'rugs'), GOOD.replace('A practical', 'A non-slip, practical'));
  assert.equal(d.claims, 0, 'category banned claims count against the claims component');
});

test('runChecks combines every check and sorts blocking first', () => {
  const draft = 'Here is a description: an AMAZING hypoallergenic throw!! It measures 50 x 70 in.';
  const { findings } = runChecks({ brief: brief('X1'), draft, glossary: [] });
  const c = findings.map((f) => f.code);
  for (const code of ['units.mismatch', 'claim.hypoallergenic', 'style.hype', 'style.exclamation', 'style.caps', 'fact.missing', 'length']) {
    assert.ok(c.includes(code), `expected ${code} in ${c.join(', ')}`);
  }
  const sorted = sortFindings(findings);
  assert.deepEqual(sorted, findings, 'runChecks already returns findings sorted');
  const firstNonBlock = sorted.findIndex((f) => f.severity !== 'block');
  assert.ok(sorted.slice(firstNonBlock).every((f) => f.severity !== 'block'));
});

test('keyword checks: missing keywords are info, stuffing warns', () => {
  const b = { ...brief('K1'), keywords: ['cotton throw', 'blanket'] };
  const stuffed = GOOD + ' A cotton throw. Another cotton throw. Yet another cotton throw.';
  const c = runChecks({ brief: b, draft: stuffed, glossary: [] }).findings.filter((f) => f.code.startsWith('seo.'));
  assert.deepEqual(
    c.map((f) => [f.code, f.severity]),
    [
      ['seo.keyword-stuffing', 'warn'],
      ['seo.keyword-missing', 'info'],
    ],
  );
});

test('routing explains itself and records the QA sample', () => {
  const item = newItem('i1', 'b1', brief('Q1'), new Date('2026-01-01T00:00:00Z'));
  item.score = { facts: 1, claims: 1, length: 1, judge: 1, total: 1, notes: [], findings: [] };
  const policy = { autoApproveAt: 0.85, sampleRate: 0.1 };
  assert.deepEqual(decideRoute(item, policy, () => 0.5), { decision: 'auto_approved', reasons: [], sampled: false, threshold: 0.85 });
  const sampled = decideRoute(item, policy, () => 0.05);
  assert.equal(sampled.decision, 'in_review');
  assert.equal(sampled.sampled, true);
  item.score = { ...item.score, total: 0.8, findings: [{ code: 'units.mismatch', severity: 'block', message: 'wrong size' }] };
  assert.deepEqual(reviewReasons(item, policy), ['score 0.800 below 0.85', 'units.mismatch: wrong size']);
  assert.deepEqual(reviewReasons(item, { ...policy, categoryThresholds: { textiles: 0.75 } }), ['units.mismatch: wrong size']);
  item.score = { ...item.score, total: 1, findings: [] };
  assert.deepEqual(reviewReasons(item, { ...policy, alwaysReview: ['textiles'] }), ['regulated category "textiles"']);
});

test('history helpers: outcome, review span, legacy sampling', () => {
  const t0 = new Date('2026-01-01T10:00:00Z');
  const item: Item = newItem('i2', 'b1', brief('H1'), t0);
  transition(item, 'generating', 'worker', t0);
  transition(item, 'scored', 'worker', t0);
  transition(item, 'in_review', 'router', new Date('2026-01-01T10:01:00Z'));
  assert.equal(reviewOutcome(item), null);
  transition(item, 'approved', 'rita', new Date('2026-01-01T10:31:00Z'));
  assert.equal(reviewOutcome(item), 'approved');
  assert.deepEqual(reviewSpan(item), { enteredAt: '2026-01-01T10:01:00.000Z', decidedAt: '2026-01-01T10:31:00.000Z' });
  item.score = { facts: 1, claims: 1, length: 1, judge: 1, total: 0.95, notes: [] };
  assert.equal(wasSampled(item, { autoApproveAt: 0.85, sampleRate: 0.1 }), true, 'old records without routing infer it from history');
  assert.throws(() => transition(item, 'queued', 'x'), /approved → queued not allowed/);
});

test('glossary validation, checks and fixes', () => {
  assert.throws(() => validateTerm({ locale: 'en-US', term: ' ', kind: 'forbidden' }), /term is required/);
  assert.throws(() => validateTerm({ locale: 'en-US', term: 'email', kind: 'preferred' }), /needs a replacement/);
  assert.throws(() => validateTerm({ locale: 'de-DE' as never, term: 'x', kind: 'keep' }), /unknown locale/);
  const terms = [
    term({ term: 'blankie', kind: 'forbidden', replacement: 'throw' }),
    term({ locale: 'fr-CA', term: 'email', kind: 'preferred', replacement: 'courriel' }),
    term({ locale: '*', term: 'Sage Throw', kind: 'keep', caseSensitive: true }),
  ];
  const b = brief('G2');
  const f = checkGlossary(terms, b, 'A sage throw, the best blankie.');
  assert.deepEqual(
    f.map((x) => [x.code, x.severity]),
    [
      ['glossary.forbidden', 'block'],
      ['glossary.keep-case', 'warn'],
    ],
  );
  assert.deepEqual(glossaryInstructions(terms, b), ['Never use "blankie" (use "throw").', 'Keep the name "Sage Throw" exactly as written; do not translate it.']);
  const fr = { ...b, locale: 'fr-CA' as const };
  assert.equal(checkGlossary(terms, fr, 'Écrivez-nous par email.').find((x) => x.code === 'glossary.preferred')?.suggestion, 'courriel');
  assert.equal(applyPreferred(terms, 'fr-CA', 'Email ou email.'), 'Courriel ou courriel.');
  assert.deepEqual(glossaryConflicts([term({ id: 'a', term: 'throw', kind: 'forbidden' }), ...terms]), ['"throw" is forbidden but is the replacement for "blankie" (en-US)']);
});

test('prompts put stable text in the cached system prompt and facts in the user turn', () => {
  const b = { ...brief('P1'), keywords: ['cotton throw'], title: 'Sage Throw' };
  const p = buildGeneration(b, { cache: true, variant: 'concise', feedback: 'Shorter please', previousDraft: 'Old draft.' });
  assert.equal(p.variant, 'concise');
  assert.equal(p.system.length, 1);
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.match(p.system[0].text, /Write 40-60 words/);
  assert.match(p.system[0].text, /Bedding & throws/);
  assert.doesNotMatch(p.system[0].text, /P1/, 'per-SKU text stays out of the cacheable prefix');
  assert.match(p.user, /^name: Sage Throw P1$/m);
  assert.match(p.user, /<previous_draft>\nOld draft\.\n<\/previous_draft>/);
  assert.match(p.user, /A reviewer asked for changes to the previous draft: Shorter please/);
  assert.equal(buildGeneration(b, {}).system[0].cache_control, undefined);
  assert.equal(buildGeneration(b, { variant: 'nope' }).variant, 'control');
  assert.ok(Object.keys(VARIANTS).includes('benefit_led'));
  assert.match(buildJudge(b, 'Draft text').user, /<description>\nDraft text\n<\/description>/);
});

test('cleanDraft strips wrappers models sometimes add', () => {
  assert.equal(cleanDraft('"A soft throw."'), 'A soft throw.');
  assert.equal(cleanDraft('Description: A soft throw.'), 'A soft throw.');
  assert.equal(cleanDraft('«Une couverture.»'), 'Une couverture.');
  assert.equal(cleanDraft('"Soft" and "warm".'), '"Soft" and "warm".', 'inner quotes stay');
});

test('model calls: usage, refusal and judge failures', async () => {
  const fake = fakeClient();
  const g = await generateDraft(fake.client as never, brief('L1'), undefined, { promptCache: true });
  assert.equal(g.usage.calls, 1);
  assert.equal(g.usage.inputTokens, 1000);
  assert.equal(g.usage.costUsd, (1000 * 4 + 200 * 20) / 1e6);
  assert.deepEqual(fake.calls[0].system[0].cache_control, { type: 'ephemeral' });
  fake.state.refuseNext = true;
  await assert.rejects(generateDraft(fake.client as never, brief('L1')), (e: unknown) => e instanceof ModelRefusalError && /cyber/.test((e as Error).message));
  fake.state.judge = null;
  const j = await judgeDraft(fake.client as never, brief('L1'), GOOD);
  assert.equal(j.verdict, null);
  assert.equal(j.usage.calls, 1, 'a failed judge call still costs money');
  const s = await scoreDraft(fake.client as never, brief('L1'), GOOD);
  assert.equal(s.score.total, 0);
  assert.match(s.score.notes.at(-1)!, /no verdict/);
  const skipped = await scoreDraft(fake.client as never, brief('L1'), 'waterproof', { skipJudgeWhenBlocked: true });
  assert.equal(skipped.usage.calls, 0);
  assert.match(skipped.score.notes.at(-1)!, /skipped/);
  assert.equal(judgeScore({ accuracy: 3, usefulness: 3, tone: 3 }), 0.5);
});
