import 'reflect-metadata';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { compareVersions, representative } from '../src/consistency';
import { demoBriefs, flawFor, simulateDraft, simulateVerdict, SimulatedClient } from '../src/demo';
import { parseArgs, run, table } from '../src/cli';
import { sign } from '../src/outbox';
import { newItem, transition, Item } from '../src/domain';
import { runChecks } from '../src/checks';
import { AppModule } from '../src/app.module';
import { MemoryQueue } from '../src/queue';
import { MemoryStore } from '../src/memory';
import { defaultConfig } from '../src/config';
import { ContentService } from '../src/service';
import { bootApp, brief, EDITOR, REVIEWER, TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function itemFor(locale: 'en-US' | 'es-US' | 'fr-CA', size: string, text: string | null, status: 'published' | 'in_review' = 'in_review'): Item {
  const i = newItem(`${locale}-${Math.random()}`, 'b', { ...brief('C1'), locale, facts: { ...brief('C1').facts, size } }, new Date());
  i.draft = text;
  for (const s of ['generating', 'scored', 'in_review'] as const) transition(i, s, 'x');
  if (status === 'published') {
    transition(i, 'approved', 'rita');
    transition(i, 'published', 'pat');
    i.finalText = text;
  }
  return i;
}

test('cross-locale consistency compares sizes after unit conversion', () => {
  const ok = compareVersions([itemFor('en-US', '50 x 60 in', 'It measures 50 x 60 in.'), itemFor('fr-CA', '127 x 152 cm', 'Il mesure 127 x 152 cm.')]);
  assert.deepEqual(
    ok.map((i) => i.kind),
    ['missing-locale'],
  );
  const bad = compareVersions([itemFor('en-US', '50 x 60 in', 'It measures 50 x 60 in.'), itemFor('fr-CA', '127 x 180 cm', 'Il mesure 127 x 180 cm.')]);
  assert.deepEqual(
    bad.map((i) => [i.kind, i.severity]),
    [
      ['fact-measurement', 'block'],
      ['copy-measurement', 'block'],
      ['missing-locale', 'info'],
    ],
  );
  assert.match(bad[1].message, /en-US copy says 50 x 60 in but fr-CA copy says 127 x 180 cm/);
  const gap = compareVersions([itemFor('en-US', '50 x 60 in', 'x', 'published'), itemFor('es-US', '50 x 60 in', 'x')]);
  assert.ok(gap.some((i) => i.kind === 'status-gap' && i.locales[0] === 'es-US'));
  const pub = itemFor('en-US', '50 x 60 in', 'a', 'published');
  const newer = itemFor('en-US', '50 x 60 in', 'b');
  newer.updatedAt = '2099-01-01T00:00:00.000Z';
  assert.equal(representative([newer, pub]), pub, 'published copy represents the locale');
});

test('SKU endpoints group locales and surface disagreements', async () => {
  t = await bootApp();
  const r = await request(t.http)
    .post('/batches')
    .set(EDITOR)
    .send({
      briefs: [
        brief('SKU-1'),
        { ...brief('SKU-1'), locale: 'fr-CA', facts: { name: 'Jeté', material: 'coton', size: '127 x 190 cm', care: 'lavable' }, mustMention: ['coton'] },
        brief('SKU-2'),
      ],
    });
  assert.equal(r.status, 201);
  await t.queue.drain();
  const one = await request(t.http).get('/skus/sku-1').set(REVIEWER);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.versions.map((v: { locale: string }) => v.locale),
    ['en-US', 'fr-CA'],
  );
  assert.ok(one.body.issues.some((i: { kind: string }) => i.kind === 'fact-measurement'));
  const list = await request(t.http).get('/skus?prefix=SKU-').set(REVIEWER);
  assert.deepEqual(
    list.body.map((s: { sku: string; blocking: number }) => [s.sku, s.blocking > 0]),
    [
      ['SKU-1', true],
      ['SKU-2', false],
    ],
  );
  assert.equal((await request(t.http).get('/skus/NOPE').set(REVIEWER)).status, 404);
});

test('demo catalogue: three locales per SKU, consistent sizes except the planted one', () => {
  const briefs = demoBriefs(25);
  assert.equal(briefs.length, 75);
  const bySku = new Map<string, typeof briefs>();
  for (const b of briefs) bySku.set(b.sku, [...(bySku.get(b.sku) ?? []), b]);
  assert.equal(bySku.size, 25);
  let disagreeing = 0;
  for (const group of bySku.values()) {
    const items = group.map((b) => {
      const i = newItem(b.sku + b.locale, 'b', b, new Date());
      return i;
    });
    if (compareVersions(items).some((x) => x.kind === 'fact-measurement')) disagreeing++;
  }
  assert.equal(disagreeing, 1, 'exactly one SKU has a French size that disagrees');
  assert.deepEqual(demoBriefs(5), demoBriefs(5), 'the catalogue is deterministic');
});

test('the simulated writer produces clean copy unless it plants a flaw', () => {
  const facts = { name: 'Harbor Throw', material: 'cotton', size: '50 x 60 in', care: 'machine wash cold' };
  const clean = simulateDraft('en-US', 'textiles', facts, true);
  const b = { ...brief('D'), facts, mustMention: ['cotton', '50 x 60 in'] };
  const blocking = runChecks({ brief: b, draft: clean, glossary: [] }).findings.filter((f) => f.severity === 'block');
  assert.deepEqual(blocking, [], clean);
  assert.equal(simulateVerdict('en-US', facts, clean).accuracy, 5);
  const fr = simulateDraft('fr-CA', 'kitchen', { name: 'Poêle Harbor', material: 'fonte', diameter: '25 cm', care: 'laver à la main' }, true);
  assert.match(fr, /^La Poêle Harbor est faite de fonte\. Elle mesure 25 cm\./);
  // Find a name the writer flaws with a wrong size, and check the judge and checks notice.
  const name = Array.from({ length: 500 }, (_, i) => `Product ${i}`).find((n) => flawFor(n, false) === 'size')!;
  const wrong = simulateDraft('en-US', 'textiles', { ...facts, name }, false);
  assert.ok(runChecks({ brief: { ...b, facts: { ...facts, name } }, draft: wrong, glossary: [] }).findings.some((f) => f.code === 'units.mismatch'));
  assert.equal(simulateVerdict('en-US', facts, wrong).accuracy, 2);
});

test('demo pipeline end to end: simulated model, cache hits, realistic review reasons', async () => {
  const client = new SimulatedClient(0);
  const queue = new MemoryQueue();
  const config = defaultConfig({ promptCache: true });
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot({ client, queue, store: new MemoryStore(), config, policy: config.policy, random: () => 0.99 })] }).compile();
  const app = mod.createNestApplication();
  await app.init();
  try {
    const briefs = demoBriefs(30);
    const r = await request(app.getHttpServer()).post('/batches').set(EDITOR).send({ briefs });
    assert.equal(r.status, 201);
    await queue.drain();
    const svc = app.get(ContentService);
    const items = await Promise.all(r.body.itemIds.map((id: string) => svc.get(id)));
    const statuses = new Map<string, number>();
    for (const i of items) statuses.set(i.status, (statuses.get(i.status) ?? 0) + 1);
    assert.ok((statuses.get('auto_approved') ?? 0) > 20, JSON.stringify([...statuses]));
    assert.ok((statuses.get('in_review') ?? 0) > 10, JSON.stringify([...statuses]));
    assert.equal(statuses.get('failed') ?? 0, 0);
    assert.ok(items.every((i) => i.brief.category !== 'baby' || i.status === 'in_review'), 'regulated categories always reach a person');
    assert.ok(items.some((i) => i.usage!.cacheReadTokens > 0), 'repeated system prompts are served from cache');
    const m = (await request(app.getHttpServer()).get('/metrics')).body;
    assert.ok(m.cost.totalUsd > 0);
    assert.ok(m.findings.some((f: { code: string }) => f.code.startsWith('claim.') || f.code === 'units.mismatch' || f.code === 'style.hype'));
  } finally {
    await app.close();
  }
});

test('CLI argument parsing and tables', () => {
  assert.deepEqual(parseArgs(['import', 'a.csv', '--name', 'Spring', '--wait', '--limit=5']), {
    command: 'import',
    positional: ['a.csv'],
    flags: { name: 'Spring', wait: true, limit: '5' },
  });
  assert.deepEqual(parseArgs([]).command, null);
  assert.equal(table([['a', 1], ['bbb', 22]], ['k', 'v']), 'k    v\n---  --\na     1\nbbb  22');
});

test('CLI commands against a fake API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contentloom-cli-'));
  const csvFile = join(dir, 'spring.csv');
  writeFileSync(csvFile, 'sku,locale,category,name\nA1,en-US,decor,Vase\n');
  const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/batches/csv')) return json(201, { batchId: 'b-1', itemIds: ['i-1'], warnings: [{ sku: 'A1', locale: 'en-US', message: 'no "material" fact' }], estimatedCostUsd: 0.02 });
    if (url.endsWith('/batches/b-1'))
      return json(200, { batch: { id: 'b-1', name: 'spring', cancelledAt: null }, counts: { auto_approved: 1, failed: 0 }, total: 1, generated: 1, done: false, costUsd: 0.016, meanScore: 1 });
    if (url.includes('/exports/published')) return new Response('sku,locale\r\nA1,en-US\r\n', { status: 200, headers: { 'x-row-count': '1' } });
    if (url.includes('/review/queue')) return json(200, []);
    if (url.endsWith('/batches/missing')) return json(404, { message: 'batch missing not found' });
    return json(404, { message: 'no route' });
  }) as typeof fetch;
  const lines: string[] = [];
  const env = { CONTENTLOOM_API: 'http://api.test/', CONTENTLOOM_USER: 'svc-import', CONTENTLOOM_ROLES: 'editor' };
  assert.equal(await run(['import', csvFile, '--wait'], env, (s) => lines.push(s), fake), 0);
  assert.equal(seen[0].url, 'http://api.test/batches/csv');
  assert.equal(seen[0].headers['x-user'], 'svc-import');
  assert.deepEqual(seen[0].body, { csv: 'sku,locale,category,name\nA1,en-US,decor,Vase\n', name: 'spring' });
  assert.match(lines.join('\n'), /batch b-1: 1 items queued, estimated \$0\.02/);
  assert.match(lines.join('\n'), /warning A1 en-US: no "material" fact/);
  assert.match(lines.join('\n'), /auto_approved\s+1/);

  const outFile = join(dir, 'out.csv');
  assert.equal(await run(['export', '--locale', 'en-US', '--out', outFile], env, (s) => lines.push(s), fake), 0);
  assert.equal(readFileSync(outFile, 'utf8'), 'sku,locale\r\nA1,en-US\r\n');
  assert.match(seen.at(-1)!.url, /exports\/published\?locale=en-US$/);

  lines.length = 0;
  assert.equal(await run(['queue'], env, (s) => lines.push(s), fake), 0);
  assert.deepEqual(lines, ['the review queue is empty']);
  await assert.rejects(run(['status', 'missing'], env, () => undefined, fake), /404: batch missing not found/);
  await assert.rejects(run(['frobnicate'], env, () => undefined, fake), /unknown command/);

  const body = '{"id":"e1"}';
  const bodyFile = join(dir, 'payload.json');
  writeFileSync(bodyFile, body);
  const header = sign('whsec', 1_700_000_000, body);
  lines.length = 0;
  assert.equal(await run(['verify', '--secret', 'whsec', '--header', header, '--body', bodyFile, '--now', '1700000010'], {}, (s) => lines.push(s), fake), 0);
  assert.deepEqual(lines, ['signature ok']);
  assert.equal(await run(['verify', '--secret', 'nope', '--header', header, '--body', bodyFile, '--now', '1700000010'], {}, () => undefined, fake), 1);
});
