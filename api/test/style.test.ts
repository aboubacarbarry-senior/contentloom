import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaims, checkEmphasis, checkHype, conceptSupported, CLAIM_CONCEPTS } from '../src/text/claims';
import { checkTypography, fixTypography } from '../src/text/typography';
import { applySide, diffWords, editStats, levenshtein, myers, renderDiff } from '../src/text/diff';
import { candidateProbability, DuplicateIndex, estimateJaccard, fnv1a, jaccard, MinHasher } from '../src/text/similarity';
import { detectDelimiter, parseCsv, parseCsvObjects, toCsv } from '../src/text/csv';

const facts = { name: 'Sage Throw', material: 'cotton', size: '50 x 60 in' };
const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

test('unsupported claims block, supported ones pass', () => {
  assert.deepEqual(codes(checkClaims(facts, 'A hypoallergenic, eco-friendly throw.', 'en-US')), ['claim.hypoallergenic', 'claim.eco']);
  assert.deepEqual(checkClaims({ ...facts, certification: 'OEKO-TEX, hypoallergenic' }, 'A hypoallergenic throw.', 'en-US'), []);
  assert.deepEqual(checkClaims({ ...facts, material: 'GOTS certified cotton' }, 'Made of organic cotton.', 'en-US'), [], 'a certification supports the claim');
  // Facts in English support Spanish and French wording of the same concept.
  assert.deepEqual(checkClaims({ ...facts, material: 'organic cotton' }, 'Hecha de algodón orgánico.', 'es-US'), []);
  assert.equal(checkClaims(facts, 'Une couverture biologique.', 'fr-CA')[0].code, 'claim.organic');
  const [f] = checkClaims(facts, 'Free shipping on this throw.', 'en-US');
  assert.equal(f.code, 'claim.promo');
  assert.equal(f.severity, 'block');
  assert.equal(checkClaims(facts, 'Now 20% off.', 'en-US')[0].code, 'claim.promo');
  assert.equal(checkClaims(facts, 'Softer than other throws.', 'en-US')[0].severity, 'warn');
});

test('promotional claims are blocked even when the facts mention them', () => {
  assert.equal(checkClaims({ ...facts, note: 'on sale this week' }, 'On sale this week.', 'en-US')[0].code, 'claim.promo');
});

test('every claim concept has wording in all three languages', () => {
  for (const c of CLAIM_CONCEPTS) {
    for (const lang of ['en', 'es', 'fr'] as const) assert.ok(c.phrases[lang].length > 0, `${c.id} has no ${lang} phrases`);
  }
  assert.ok(conceptSupported(CLAIM_CONCEPTS.find((c) => c.id === 'waterproof')!, { rating: 'IPX7' }));
});

test('hype, superlatives, exclamations and capitals warn', () => {
  assert.deepEqual(codes(checkHype(facts, 'An amazing throw, the best you can buy.', 'en-US')), ['style.hype', 'style.superlative']);
  assert.deepEqual(checkHype({ ...facts, award: 'Best throw 2025, Home Magazine' }, 'Voted best throw.', 'en-US'), [], 'facts back the superlative');
  assert.equal(checkHype(facts, 'Una manta increíble.', 'es-US')[0].code, 'style.hype');
  const em = checkEmphasis('So SOFT! Really soft! BPA and LED are fine.', 'ACME');
  assert.deepEqual(codes(em), ['style.exclamation', 'style.caps']);
  assert.match(em[0].message, /2 exclamation marks/);
  assert.deepEqual(checkEmphasis('From ACME HOME.', 'ACME HOME'), []);
});

test('typography rules per locale', () => {
  assert.ok(codes(checkTypography('Soft  and warm .', 'en-US')).includes('typography.double-space'));
  assert.ok(codes(checkTypography('Soft and warm .', 'en-US')).includes('typography.space-before-punct'));
  assert.ok(codes(checkTypography('Douce: et chaude.', 'fr-CA')).includes('typography.fr-high-punct'));
  assert.ok(!codes(checkTypography('Douce : et chaude.', 'fr-CA')).includes('typography.fr-high-punct'));
  assert.ok(!codes(checkTypography('Ouvert de 10:30 à 18 h.', 'fr-CA')).includes('typography.fr-high-punct'), 'times are fine');
  assert.ok(codes(checkTypography('Es suave? Sí.', 'es-US')).includes('typography.es-inverted'));
  assert.ok(!codes(checkTypography('¿Es suave? Sí.', 'es-US')).includes('typography.es-inverted'));
  assert.ok(codes(checkTypography('Mesure 2.5 cm.', 'fr-CA')).includes('typography.decimal'));
  assert.ok(codes(checkTypography('A soft throw', 'en-US')).includes('typography.trailing'));
  const md = checkTypography('**Soft** throw.', 'en-US').find((f) => f.code === 'typography.markup');
  assert.equal(md?.severity, 'block');
  assert.equal(checkTypography("Here's a description: soft throw.", 'en-US').find((f) => f.code === 'typography.preamble')?.severity, 'block');
});

test('fixTypography is idempotent and applies safe fixes', () => {
  assert.equal(fixTypography('Soft  and "warm" .', 'en-US'), 'Soft and “warm”.');
  const fr = fixTypography('Mesure 2.5 cm: lavable!', 'fr-CA');
  assert.equal(fr, 'Mesure 2,5 cm : lavable !');
  assert.equal(fixTypography(fr, 'fr-CA'), fr);
  assert.equal(fixTypography('Wait...', 'en-US'), 'Wait…');
});

test('myers diff finds a shortest edit script', () => {
  const ops = myers('abcabba'.split(''), 'cbabac'.split(''));
  const edits = ops.filter((o) => o.op !== 'equal').length;
  assert.equal(edits, 5, 'the classic example needs five edits');
  assert.deepEqual(myers([], ['x']).map((o) => o.op), ['insert']);
  assert.deepEqual(myers(['x'], []).map((o) => o.op), ['delete']);
  assert.deepEqual(myers(['a'], ['a']).map((o) => o.op), ['equal']);
});

test('word diffs rebuild both sides and read naturally', () => {
  const before = 'A soft red throw for the sofa.';
  const after = 'A soft blue throw for the bed.';
  const ops = diffWords(before, after);
  assert.equal(applySide(ops, 'before'), before);
  assert.equal(applySide(ops, 'after'), after);
  assert.equal(renderDiff(ops), 'A soft [-red-]{+blue+} throw for the [-sofa-]{+bed+}.');
  const multi = diffWords('one two three four', 'one five six four');
  assert.equal(renderDiff(multi), 'one [-two three-]{+five six+} four', 'a space between two changes joins them');
});

test('edit statistics', () => {
  assert.deepEqual(editStats('same text here', 'same text here'), { wordsBefore: 3, wordsAfter: 3, wordsInserted: 0, wordsDeleted: 0, editRatio: 0 });
  const s = editStats('a b c d', 'a x c d');
  assert.equal(s.wordsInserted, 1);
  assert.equal(s.wordsDeleted, 1);
  assert.equal(s.editRatio, 0.5);
  assert.equal(editStats('', 'new').editRatio, 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', 'abcdef', 1), 2, 'stops early past max');
});

test('similarity: hashing, jaccard and LSH index', () => {
  assert.equal(fnv1a('contentloom'), fnv1a('contentloom'));
  assert.notEqual(fnv1a('a'), fnv1a('b'));
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  const h = new MinHasher(128);
  const a = h.signature(['the quick brown', 'quick brown fox', 'brown fox jumps']);
  const b = h.signature(['the quick brown', 'quick brown fox', 'brown fox naps']);
  assert.ok(Math.abs(estimateJaccard(a, b) - 0.5) < 0.2);
  assert.ok(candidateProbability(0.8, 16, 4) > 0.99);
  assert.ok(candidateProbability(0.3, 16, 4) < 0.15);

  const idx = new DuplicateIndex();
  const base =
    'Meet the Sage Throw, made from cotton and measuring 50 x 60 in. It is easy to live with and suits most rooms, ' +
    'bringing quiet texture to everyday spaces without demanding attention. Care is simple: machine wash cold. ' +
    'A practical choice for daily use that should look good for years with very little effort from you.';
  idx.add('A', base);
  idx.add('B', base.replace('Sage', 'Moss'));
  idx.add('C', 'A cast iron skillet that heats evenly and goes from stove to oven without fuss.');
  const hits = idx.query(base, 0.8, 'A');
  assert.deepEqual(hits.map((x) => x.key), ['B']);
  assert.ok(hits[0].similarity >= 0.8);
  assert.deepEqual(idx.pairs(0.8).map((p) => [p.a, p.b]), [['A', 'B']]);
  idx.remove('B');
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.query(base, 0.8, 'A'), []);
});

test('CSV parsing handles quotes, newlines, BOM and delimiters', () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, ""y"""\n'), [
    ['a', 'b'],
    ['1', 'x, "y"'],
  ]);
  assert.deepEqual(parseCsv('﻿a;b\r\n1;"multi\nline"\r\n'), [
    ['a', 'b'],
    ['1', 'multi\nline'],
  ]);
  assert.equal(detectDelimiter('sku;locale;category'), ';');
  assert.equal(detectDelimiter('sku\tlocale\tcategory'), '\t');
  assert.equal(detectDelimiter('"a;b",c'), ',');
  assert.throws(() => parseCsv('a,"open\n'), /line 1: unterminated/);
  const { headers, records } = parseCsvObjects('sku, name \nA1,Throw\n\nA2,Rug\n');
  assert.deepEqual(headers, ['sku', 'name']);
  assert.deepEqual(records, [
    { sku: 'A1', name: 'Throw' },
    { sku: 'A2', name: 'Rug' },
  ]);
  assert.throws(() => parseCsvObjects('a,A\n1,2'), /duplicate header/);
  assert.throws(() => parseCsvObjects('a\n1,2'), /2 fields but 1 headers/);
});

test('CSV writing quotes when needed and defuses formulas', () => {
  const out = toCsv(['sku', 'text'], [
    { sku: 'A1', text: 'plain' },
    { sku: 'A2', text: 'has, comma and "quotes"' },
    { sku: 'A3', text: '=HYPERLINK("x")' },
    { sku: 'A4', text: null },
  ]);
  assert.equal(out, 'sku,text\r\nA1,plain\r\nA2,"has, comma and ""quotes"""\r\nA3,"\'=HYPERLINK(""x"")"\r\nA4,\r\n');
  assert.deepEqual(parseCsv(out)[2], ['A2', 'has, comma and "quotes"']);
});
