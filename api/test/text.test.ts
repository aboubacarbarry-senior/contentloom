import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsPhrase, findPhrase, preview, sentences, tokenize, wordCount, wordShingles } from '../src/text/tokenize';
import { readability, syllablesEn, syllablesEs, syllablesFr } from '../src/text/readability';
import { checkMeasurements, convert, findMeasurements, formatAs, sameQuantity, unitById } from '../src/text/units';
import { formatLocaleNumber, parseLocaleNumber } from '../src/locales';

test('tokenize keeps offsets and word shapes', () => {
  const s = 'Pre-washed cotton, 50 x 60 in.';
  const toks = tokenize(s);
  for (const t of toks) assert.equal(s.slice(t.start, t.end), t.text);
  assert.deepEqual(
    toks.filter((t) => t.kind === 'word').map((t) => t.text),
    ['Pre-washed', 'cotton', 'x', 'in'],
  );
  assert.deepEqual(
    toks.filter((t) => t.kind === 'number').map((t) => t.text),
    ['50', '60'],
  );
  assert.equal(tokenize('algodón').length, 1, 'accented letters stay in one word');
});

test('sentences ignore decimals, abbreviations and units before lower-case text', () => {
  assert.deepEqual(
    sentences('It measures 2.5 cm across. Care is easy! Is it soft? Yes.').map((s) => s.text),
    ['It measures 2.5 cm across.', 'Care is easy!', 'Is it soft?', 'Yes.'],
  );
  assert.deepEqual(
    sentences('Measuring 50 x 60 in. It is warm.').map((s) => s.text),
    ['Measuring 50 x 60 in.', 'It is warm.'],
  );
  assert.equal(sentences('Holds approx. two liters of water.').length, 1);
  const s = sentences('  Leading space. Second one.');
  assert.equal(s[0].start, 2);
});

test('findPhrase respects Unicode word boundaries', () => {
  assert.equal(findPhrase('Hecho de algodón suave.', 'algodón').length, 1);
  assert.equal(findPhrase('algodónes', 'algodón').length, 0);
  assert.equal(findPhrase('Fully WATERPROOF shell', 'waterproof').length, 1);
  assert.equal(findPhrase('waterproofing', 'waterproof').length, 0);
  assert.ok(containsPhrase('machine   wash cold', 'machine wash'), 'whitespace in phrases is flexible');
});

test('word counts, shingles and previews', () => {
  assert.equal(wordCount('  one two\nthree  '), 3);
  assert.deepEqual(wordShingles('a b c d', 3), ['a b c', 'b c d']);
  assert.deepEqual(wordShingles('a b', 3), ['a b']);
  assert.equal(preview('short'), 'short');
  const p = preview('word '.repeat(50), 40);
  assert.ok(p.length <= 40 && p.endsWith('…'));
});

test('syllable counters', () => {
  assert.equal(syllablesEn('cat'), 1);
  assert.equal(syllablesEn('table'), 2);
  assert.equal(syllablesEn('practical'), 3);
  assert.equal(syllablesEn('machine'), 2);
  assert.equal(syllablesEs('día'), 2, 'accented weak vowel breaks the diphthong');
  assert.equal(syllablesEs('ciudad'), 2);
  assert.equal(syllablesEs('aéreo'), 4);
  assert.equal(syllablesEs('queso'), 2, 'silent u in que');
  assert.equal(syllablesFr('table'), 1, 'mute final e');
  assert.equal(syllablesFr('couverture'), 3);
});

test('readability scores by locale', () => {
  const easy = readability('The cat sat. The dog ran. We ate.', 'en-US')!;
  const hard = readability('Notwithstanding considerable organizational difficulties, the interdepartmental committee nevertheless recommended comprehensive standardization.', 'en-US')!;
  assert.equal(easy.formula, 'flesch');
  assert.ok(easy.score > 90, `easy text scored ${easy.score}`);
  assert.ok(hard.score < 30, `hard text scored ${hard.score}`);
  assert.equal(hard.band, 'very difficult');
  assert.ok(easy.grade !== null && easy.grade < hard.grade!);
  assert.equal(readability('Una manta suave de algodón. Lávela en frío.', 'es-US')!.formula, 'fernandez-huerta');
  assert.equal(readability('Une couverture douce. Lavez-la à froid.', 'fr-CA')!.formula, 'kandel-moles');
  assert.equal(readability('   ', 'en-US'), null);
});

test('locale numbers parse and format both ways', () => {
  assert.equal(parseLocaleNumber('2,5', 'fr-CA'), 2.5);
  assert.equal(parseLocaleNumber('2.5', 'fr-CA'), 2.5, 'writers copy facts verbatim');
  assert.equal(parseLocaleNumber('1,250', 'en-US'), 1250);
  assert.equal(parseLocaleNumber('1 250', 'fr-CA'), 1250);
  assert.equal(parseLocaleNumber('1.250,75', 'es-US'), 1250.75);
  assert.equal(parseLocaleNumber('1 1/2', 'en-US'), 1.5);
  assert.equal(parseLocaleNumber('3/0', 'en-US'), null);
  assert.equal(parseLocaleNumber('abc', 'en-US'), null);
  assert.equal(formatLocaleNumber(2.5, 'fr-CA'), '2,5');
  assert.equal(formatLocaleNumber(12500, 'en-US'), '12,500');
  assert.equal(formatLocaleNumber(12500, 'fr-CA'), '12 500');
  assert.equal(formatLocaleNumber(1250, 'en-US'), '1250', 'four-digit numbers are not grouped');
});

test('findMeasurements reads dimensions, symbols and hyphenated units', () => {
  const ms = findMeasurements('A 50 x 60 in throw, a 12-inch pillow, 3.5 kg, 750 ml and 40 W.', 'en-US');
  assert.deepEqual(
    ms.map((m) => [m.values, m.unit.id]),
    [
      [[50, 60], 'in'],
      [[12], 'in'],
      [[3.5], 'kg'],
      [[750], 'ml'],
      [[40], 'W'],
    ],
  );
  assert.deepEqual(findMeasurements('50" x 60"', 'en-US')[0].values, [50, 60]);
  assert.deepEqual(findMeasurements('Mide 76 x 142 cm.', 'es-US')[0].values, [76, 142]);
  assert.equal(findMeasurements('Fits 2 in a drawer', 'en-US').length, 0, '"in" the preposition is not inches');
  assert.equal(findMeasurements('It is 2 in wide', 'en-US').length, 1);
  assert.equal(findMeasurements('Model 5 series', 'en-US').length, 0);
  assert.equal(findMeasurements('Lavez à 40 °C', 'fr-CA')[0].unit.id, 'C');
  assert.equal(findMeasurements('Set of 4 pieces', 'en-US')[0].unit.id, 'pcs');
});

test('unit conversion and matching tolerate rounding', () => {
  assert.equal(convert(1, unitById('in'), unitById('cm')), 2.54);
  assert.ok(Math.abs(convert(212, unitById('F'), unitById('C')) - 100) < 1e-9);
  const [fact] = findMeasurements('50 x 60 in', 'en-US');
  const [same] = findMeasurements('60 x 50 in', 'en-US');
  const [metric] = findMeasurements('127 x 152 cm', 'en-US');
  const [side] = findMeasurements('60 in long', 'en-US');
  const [wrong] = findMeasurements('50 x 70 in', 'en-US');
  assert.equal(sameQuantity(same, fact), 'exact');
  assert.equal(sameQuantity(metric, fact), 'converted');
  assert.equal(sameQuantity(side, fact), 'exact');
  assert.equal(sameQuantity(wrong, fact), false);
  assert.equal(formatAs(fact, unitById('cm')), '127 x 152.4 cm');
});

test('same-unit values must match exactly; converted values may round to their written precision', () => {
  const m = (s: string, l: 'en-US' | 'fr-CA' = 'en-US') => findMeasurements(s, l)[0];
  assert.equal(sameQuantity(m('50 x 61 in'), m('50 x 60 in')), false, 'off by one inch is a different size');
  assert.equal(sameQuantity(m('128 x 152 cm'), m('50 x 60 in')), false, '128 cm is not 50 in');
  assert.equal(sameQuantity(m('1,3 cm', 'fr-CA'), m('0.5 in')), 'converted', '0.5 in = 1.27 cm, written to one decimal');
  assert.equal(sameQuantity(m('2,3 kg', 'fr-CA'), m('5 lb')), 'converted');
  assert.equal(sameQuantity(m('36 cm'), m('14 in')), 'converted', '35.56 cm rounds to 36');
  assert.equal(sameQuantity(m('35 cm'), m('14 in')), false);
  assert.equal(sameQuantity(m('0.5 in'), m('1,3 cm', 'fr-CA')), 'converted', '1.3 cm = 0.51 in');
  assert.equal(sameQuantity(m('0.6 in'), m('1,3 cm', 'fr-CA')), false);
});

test('checkMeasurements blocks invented and wrong measurements', () => {
  const facts = { size: '50 x 60 in', weight: '2 lb' };
  assert.deepEqual(checkMeasurements(facts, 'It measures 50 x 60 in and weighs 2 lb.', 'en-US'), []);
  const wrong = checkMeasurements(facts, 'It measures 50 x 70 in.', 'en-US');
  assert.equal(wrong[0].code, 'units.mismatch');
  assert.equal(wrong[0].severity, 'block');
  assert.equal(wrong[0].suggestion, '50 x 60 in');
  const invented = checkMeasurements(facts, 'It holds 2 liters.', 'en-US');
  assert.equal(invented[0].code, 'units.unsupported');
  const converted = checkMeasurements(facts, 'It measures 127 x 152 cm.', 'en-US');
  assert.equal(converted[0].code, 'units.converted');
  assert.equal(converted[0].severity, 'warn', 'en-US copy should keep imperial units');
  assert.equal(checkMeasurements(facts, 'Mide 127 x 152 cm.', 'es-US')[0].severity, 'info', 'es-US accepts both systems');
});
