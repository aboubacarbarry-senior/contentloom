import type { Brief, DiffOp, Finding, Locale } from './types';

/**
 * Client-side text helpers: a live word diff while a reviewer edits (the API diffs saved items), CSV
 * parsing for the upload preview, and span merging for highlights.
 */

const TOKEN = /\s+|[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*|./gu;

export function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** LCS word diff. Copy is short (under ~150 words), so the O(n·m) table is fine in the browser. */
export function diff(before: string, after: string): DiffOp[] {
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out: DiffOp[] = [];
  const push = (op: DiffOp['op'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('delete', a[i++]);
    else push('insert', b[j++]);
  }
  while (i < n) push('delete', a[i++]);
  while (j < m) push('insert', b[j++]);
  return out;
}

export function changedWords(ops: DiffOp[]): number {
  return ops.filter((o) => o.op !== 'equal').reduce((n, o) => n + (o.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
}

export interface Span {
  start: number;
  end: number;
  findings: Finding[];
}

/** Turn possibly overlapping finding ranges into non-overlapping spans for highlighting. */
export function findingSpans(findings: Finding[], textLength: number): Span[] {
  const ranged = findings.filter((f) => f.start !== undefined && f.end !== undefined && f.end! > f.start! && f.start! < textLength);
  if (!ranged.length) return [];
  const cuts = new Set<number>([0, textLength]);
  for (const f of ranged) {
    cuts.add(Math.max(0, f.start!));
    cuts.add(Math.min(textLength, f.end!));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const spans: Span[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const start = points[k];
    const end = points[k + 1];
    const covering = ranged.filter((f) => f.start! <= start && f.end! >= end);
    if (!covering.length) continue;
    const prev = spans[spans.length - 1];
    if (prev && prev.end === start && sameSet(prev.findings, covering)) prev.end = end;
    else spans.push({ start, end, findings: covering });
  }
  return spans;
}

function sameSet(a: Finding[], b: Finding[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function worstSeverity(fs: Finding[]): Finding['severity'] {
  if (fs.some((f) => f.severity === 'block')) return 'block';
  if (fs.some((f) => f.severity === 'warn')) return 'warn';
  return 'info';
}

/* ---------------- CSV upload preview ---------------- */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
      started = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new Error('the file has an unterminated quoted field');
  if (field || started || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const RESERVED = new Set(['sku', 'locale', 'category', 'title', 'brand', 'must_mention', 'mustmention', 'banned', 'keywords']);
const LOCALES: Locale[] = ['en-US', 'es-US', 'fr-CA'];

export interface PreviewRow {
  row: number;
  brief: Brief | null;
  errors: string[];
}

/** Mirror of the API's CSV mapping, so editors see problems before uploading. The API re-validates. */
export function previewCsv(text: string): { headers: string[]; rows: PreviewRow[]; fileError: string | null } {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return { headers: [], rows: [], fileError: (e as Error).message };
  }
  if (!table.length) return { headers: [], rows: [], fileError: 'the file is empty' };
  const headers = table[0].map((h) => h.trim());
  const norm = headers.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  for (const req of ['sku', 'locale', 'category']) {
    if (!norm.includes(req)) return { headers, rows: [], fileError: `missing column "${req}"` };
  }
  const col = (r: string[], name: string) => {
    const i = norm.indexOf(name);
    return i === -1 ? '' : (r[i] ?? '').trim();
  };
  const list = (s: string) =>
    s
      .split(/[;|]/)
      .map((x) => x.trim())
      .filter(Boolean);
  const rows = table.slice(1).map((r, idx): PreviewRow => {
    const errors: string[] = [];
    const sku = col(r, 'sku');
    const locale = col(r, 'locale') as Locale;
    const category = col(r, 'category').toLowerCase();
    if (!sku) errors.push('sku is empty');
    if (!LOCALES.includes(locale)) errors.push(`locale "${locale}" is not one of ${LOCALES.join(', ')}`);
    if (!category) errors.push('category is empty');
    const facts: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (RESERVED.has(norm[i])) return;
      const v = (r[i] ?? '').trim();
      if (v) facts[h.replace(/^fact[:.]\s*/i, '')] = v;
    });
    if (!Object.keys(facts).length) errors.push('no fact columns have a value');
    if (errors.length) return { row: idx + 2, brief: null, errors };
    const brief: Brief = { sku, locale, category, facts, mustMention: list(col(r, 'must_mention') || col(r, 'mustmention')), banned: list(col(r, 'banned')) };
    if (col(r, 'title')) brief.title = col(r, 'title');
    if (col(r, 'brand')) brief.brand = col(r, 'brand');
    if (col(r, 'keywords')) brief.keywords = list(col(r, 'keywords'));
    return { row: idx + 2, brief, errors };
  });
  return { headers, rows, fileError: null };
}

export const SAMPLE_CSV = [
  'sku,locale,category,name,material,size,care,must_mention,banned',
  'THR-SAGE-01,en-US,textiles,Sage Throw,cotton,50 x 60 in,machine wash cold,cotton;50 x 60 in,waterproof',
  'THR-SAGE-01,es-US,textiles,Manta Sage,algodón,50 x 60 in,lavar a máquina en frío,algodón;50 x 60 in,impermeable',
  'THR-SAGE-01,fr-CA,textiles,Jeté Sage,coton,127 x 152 cm,lavable à la machine à froid,coton;127 x 152 cm,imperméable',
].join('\n');
