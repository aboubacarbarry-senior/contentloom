import { Locale, STATUSES, Status } from './domain';
import { isLocale } from './locales';
import type { ItemQuery, ItemSort } from './repository';

/**
 * The review app's search box: a small query language over items.
 *
 *   status:in_review category:baby,electrical score<0.7 locale:fr-CA sku:SAGE-* "pre-washed"
 *   finding:claim. variant:benefit_led sampled:yes created>2026-01-01 sort:score_asc
 *
 * Bare words and quoted phrases search the SKU, draft and final text. A leading `-` negates a status
 * filter (`-status:published`). Unknown keys are errors rather than silently ignored.
 */

export class QueryError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = 'QueryError';
  }
}

export interface Token {
  negated: boolean;
  key: string | null;
  op: ':' | '<' | '>' | '<=' | '>=' | '=' | null;
  value: string;
  position: number;
}

export function lex(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;
    const start = i;
    let negated = false;
    if (input[i] === '-' && i + 1 < n && /[a-z"]/i.test(input[i + 1])) {
      negated = true;
      i++;
    }
    // key?
    const keyMatch = /^([a-z_]+)(<=|>=|:|<|>|=)/i.exec(input.slice(i));
    let key: string | null = null;
    let op: Token['op'] = null;
    if (keyMatch) {
      key = keyMatch[1].toLowerCase();
      op = keyMatch[2] as Token['op'];
      i += keyMatch[0].length;
    }
    let value = '';
    if (input[i] === '"') {
      const close = input.indexOf('"', i + 1);
      if (close === -1) throw new QueryError('unterminated quote', i);
      value = input.slice(i + 1, close);
      i = close + 1;
    } else {
      const m = /^[^\s]*/.exec(input.slice(i))!;
      value = m[0];
      i += value.length;
    }
    if (key && !value) throw new QueryError(`"${key}${op}" needs a value`, start);
    out.push({ negated, key, op, value, position: start });
  }
  return out;
}

const SORTS: ItemSort[] = ['score_asc', 'score_desc', 'created_asc', 'created_desc', 'updated_desc', 'sku_asc'];
const YES = new Set(['yes', 'true', '1', 'y']);
const NO = new Set(['no', 'false', '0', 'n']);

function list(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDate(v: string, pos: number): string {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(t)) throw new QueryError(`"${v}" is not a date`, pos);
  return new Date(t).toISOString();
}

function parseScore(v: string, pos: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new QueryError(`score must be between 0 and 1, got "${v}"`, pos);
  return n;
}

export function parseQuery(input: string): ItemQuery {
  const q: ItemQuery = {};
  const text: string[] = [];
  const include = new Set<Status>();
  const exclude = new Set<Status>();
  for (const t of lex(input)) {
    if (!t.key) {
      if (t.negated) throw new QueryError('negation only works on status:', t.position);
      text.push(t.value);
      continue;
    }
    if (t.negated && t.key !== 'status') throw new QueryError('negation only works on status:', t.position);
    const v = t.value;
    switch (t.key) {
      case 'status':
      case 'is': {
        for (const s of list(v)) {
          if (!(STATUSES as string[]).includes(s)) throw new QueryError(`unknown status "${s}"`, t.position);
          (t.negated ? exclude : include).add(s as Status);
        }
        break;
      }
      case 'category':
      case 'cat':
        q.category = [...(q.category ?? []), ...list(v)];
        break;
      case 'locale':
      case 'lang': {
        const ls = list(v);
        for (const l of ls) if (!isLocale(l)) throw new QueryError(`unknown locale "${l}"`, t.position);
        q.locale = [...(q.locale ?? []), ...(ls as Locale[])];
        break;
      }
      case 'sku':
        q.sku = v;
        break;
      case 'batch':
        q.batchId = v;
        break;
      case 'reviewer':
      case 'by':
        q.reviewer = v;
        break;
      case 'score': {
        const n = parseScore(v, t.position);
        if (t.op === '<' || t.op === '<=') q.maxScore = t.op === '<' ? n - 1e-9 : n;
        else if (t.op === '>' || t.op === '>=') q.minScore = t.op === '>' ? n + 1e-9 : n;
        else {
          q.minScore = n;
          q.maxScore = n;
        }
        break;
      }
      case 'finding':
      case 'has':
        q.finding = v;
        break;
      case 'variant':
        q.variant = v;
        break;
      case 'sampled': {
        const s = v.toLowerCase();
        if (YES.has(s)) q.sampled = true;
        else if (NO.has(s)) q.sampled = false;
        else throw new QueryError(`sampled takes yes or no, got "${v}"`, t.position);
        break;
      }
      case 'created': {
        const d = parseDate(v, t.position);
        if (t.op === '<' || t.op === '<=') q.createdBefore = d;
        else if (t.op === '>' || t.op === '>=') q.createdAfter = d;
        else {
          q.createdAfter = d;
          q.createdBefore = new Date(Date.parse(d) + 86_400_000).toISOString();
        }
        break;
      }
      case 'sort': {
        if (!(SORTS as string[]).includes(v)) throw new QueryError(`sort must be one of ${SORTS.join(', ')}`, t.position);
        q.sort = v as ItemSort;
        break;
      }
      default:
        throw new QueryError(`unknown filter "${t.key}"`, t.position);
    }
  }
  if (include.size || exclude.size) {
    const base = include.size ? [...include] : [...STATUSES];
    q.status = base.filter((s) => !exclude.has(s));
    if (!q.status.length) throw new QueryError('the status filters exclude every status', 0);
  }
  if (text.length) q.text = text.join(' ');
  if (q.minScore !== undefined && q.maxScore !== undefined && q.minScore > q.maxScore) {
    throw new QueryError('score range is empty', 0);
  }
  return q;
}

/** Render a query back to text (the inverse of parseQuery for the fields it sets). */
export function formatQuery(q: ItemQuery): string {
  const parts: string[] = [];
  if (q.status?.length) parts.push(`status:${q.status.join(',')}`);
  if (q.category?.length) parts.push(`category:${q.category.join(',')}`);
  if (q.locale?.length) parts.push(`locale:${q.locale.join(',')}`);
  if (q.sku) parts.push(`sku:${q.sku}`);
  if (q.batchId) parts.push(`batch:${q.batchId}`);
  if (q.reviewer) parts.push(`reviewer:${q.reviewer}`);
  if (q.minScore !== undefined) parts.push(`score>=${q.minScore}`);
  if (q.maxScore !== undefined) parts.push(`score<=${q.maxScore}`);
  if (q.finding) parts.push(`finding:${q.finding}`);
  if (q.variant) parts.push(`variant:${q.variant}`);
  if (q.sampled !== undefined) parts.push(`sampled:${q.sampled ? 'yes' : 'no'}`);
  if (q.createdAfter) parts.push(`created>=${q.createdAfter.slice(0, 10)}`);
  if (q.createdBefore) parts.push(`created<${q.createdBefore.slice(0, 10)}`);
  if (q.sort) parts.push(`sort:${q.sort}`);
  if (q.text) parts.push(/\s/.test(q.text) ? `"${q.text}"` : q.text);
  return parts.join(' ');
}
