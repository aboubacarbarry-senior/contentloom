// Unit tests for the browser-side libraries. Run with `npm test` (Node's built-in TypeScript support).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedWords, diff, findingSpans, parseCsv, previewCsv, SAMPLE_CSV, tokens, worstSeverity } from '../lib/text.ts';
import { ago, classes, minutes, pct, plural, score, scoreTone, statusTone, subjectLabel, truncate, usd, wordCount } from '../lib/format.ts';

test('word diff rebuilds both sides', () => {
  const before = 'A soft red throw for the sofa.';
  const after = 'A soft blue throw for the bed.';
  const ops = diff(before, after);
  assert.equal(ops.filter((o) => o.op !== 'insert').map((o) => o.text).join(''), before);
  assert.equal(ops.filter((o) => o.op !== 'delete').map((o) => o.text).join(''), after);
  assert.equal(changedWords(ops), 4);
  assert.deepEqual(diff('same', 'same'), [{ op: 'equal', text: 'same' }]);
  assert.deepEqual(tokens('pre-washed, 50 cm'), ['pre-washed', ',', ' ', '50', ' ', 'cm']);
});

test('finding spans split overlaps and merge neighbours', () => {
  const block = { code: 'claim.x', severity: 'block' as const, message: 'b', start: 2, end: 8 };
  const warn = { code: 'style.x', severity: 'warn' as const, message: 'w', start: 5, end: 12 };
  const spans = findingSpans([block, warn, { code: 'no-range', severity: 'info', message: 'i' }], 20);
  assert.deepEqual(
    spans.map((s) => [s.start, s.end, s.findings.length]),
    [
      [2, 5, 1],
      [5, 8, 2],
      [8, 12, 1],
    ],
  );
  assert.equal(worstSeverity(spans[1].findings), 'block');
  assert.deepEqual(findingSpans([{ ...block, start: 30, end: 40 }], 20), [], 'ranges past the text are ignored');
});

test('CSV preview mirrors the API mapping', () => {
  const p = previewCsv(SAMPLE_CSV);
  assert.equal(p.fileError, null);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows[0].brief?.mustMention, ['cotton', '50 x 60 in']);
  assert.equal(p.rows[2].brief?.facts.size, '127 x 152 cm');
  const bad = previewCsv('sku;locale;category;name\n;de-DE;rugs;Rug\nA;en-US;rugs;');
  assert.deepEqual(bad.rows.map((r) => r.errors.length), [2, 1]);
  assert.match(previewCsv('sku,name\nA,B').fileError!, /missing column "locale"/);
  assert.deepEqual(parseCsv('a,"b ""c"""\n'), [['a', 'b "c"']]);
  assert.throws(() => parseCsv('"open'), /unterminated/);
});

test('formatting helpers', () => {
  assert.equal(pct(0.957, 1), '95.7%');
  assert.equal(pct(null), '—');
  assert.equal(score(0.8), '0.80');
  assert.equal(scoreTone(0.9), 'ok');
  assert.equal(scoreTone(0.75), 'wait');
  assert.equal(scoreTone(0.2), 'bad');
  assert.equal(statusTone('in_review'), 'wait');
  assert.equal(statusTone('published'), 'ok');
  assert.equal(usd(1234.5), '$1,234.50');
  assert.equal(usd(0.0016), '$0.0016');
  assert.equal(minutes(0.5), '30 s');
  assert.equal(minutes(125), '2.1 h');
  assert.equal(plural(1, 'item'), '1 item');
  assert.equal(plural(3, 'batch', 'batches'), '3 batches');
  assert.equal(truncate('a '.repeat(100), 10).length, 10);
  assert.equal(wordCount(' one  two '), 2);
  assert.deepEqual(subjectLabel('item:1234'), { kind: 'item', id: '1234' });
  assert.deepEqual(subjectLabel('policy'), { kind: 'policy', id: null });
  assert.equal(classes('a', false, null, 'b'), 'a b');
  const now = Date.parse('2026-03-02T12:00:00Z');
  assert.equal(ago('2026-03-02T11:57:00Z', now), '3 minutes ago');
  assert.equal(ago('2026-03-03T12:00:00Z', now), 'tomorrow');
  assert.equal(ago(null, now), '—');
});
