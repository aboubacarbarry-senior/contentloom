import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from './audit';
import { categoryRule, isKnownCategory, missingRequiredFacts } from './categories';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import { Batch, Brief, Item, Locale, LOCALES, newItem, normalizeItem, reviewOutcome, SETTLED, Status, transition } from './domain';
import { editStats } from './text/diff';
import { ConflictError, NotFoundError, StaleWriteError, ValidationError } from './errors';
import { EventBus } from './events';
import { assignVariant } from './experiments';
import { isLocale } from './locales';
import { JobQueue } from './queue';
import { Page, Store, STORE } from './repository';
import { CsvError, parseCsvObjects } from './text/csv';
import { BUDGET, CLOCK, CONFIG, JOB_QUEUE } from './tokens';
import { BudgetGuard, estimateBatchCost } from './usage';

export const MAX_BATCH = 500;

/** Statuses in which an item still needs the pipeline or a person. */
const ACTIVE: Status[] = ['queued', 'generating', 'scored', 'in_review', 'auto_approved', 'approved'];

export interface BatchWarning {
  index: number;
  sku: string;
  locale: string;
  message: string;
}

export interface CreateBatchResult {
  batchId: string;
  itemIds: string[];
  warnings: BatchWarning[];
  estimatedCostUsd: number;
}

export interface BatchSummary {
  batch: Batch;
  counts: Record<Status, number>;
  total: number;
  /** Share of items the model has finished with (anything past generating). */
  generated: number;
  /** Share of items that need nothing more (published, rejected, failed, cancelled, withdrawn). */
  settled: number;
  done: boolean;
  costUsd: number;
  meanScore: number | null;
  locales: Partial<Record<Locale, number>>;
  categories: Record<string, number>;
}

export interface BatchReport {
  batchId: string;
  findings: { code: string; items: number; blocking: number }[];
  reasons: { reason: string; items: number }[];
  locales: { locale: string; items: number; autoApproved: number; reviewed: number; approved: number; published: number; failed: number }[];
  edits: { approved: number; edited: number; meanEditRatio: number | null };
  errors: { message: string; items: number }[];
}

export interface CsvRowError {
  row: number;
  message: string;
}

const RESERVED = new Set(['sku', 'locale', 'category', 'title', 'brand', 'must_mention', 'mustmention', 'banned', 'keywords']);

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Turn spreadsheet rows into briefs. Any column that is not a reserved one becomes a fact. */
export function briefsFromCsv(text: string): { briefs: Brief[]; errors: CsvRowError[] } {
  let parsed: { headers: string[]; records: Record<string, string>[] };
  try {
    parsed = parseCsvObjects(text);
  } catch (e) {
    if (e instanceof CsvError) return { briefs: [], errors: [{ row: e.line, message: e.message }] };
    throw e;
  }
  const lower = new Map(parsed.headers.map((h) => [h.toLowerCase().replace(/\s+/g, '_'), h]));
  for (const required of ['sku', 'locale', 'category']) {
    if (!lower.has(required)) return { briefs: [], errors: [{ row: 1, message: `missing column "${required}"` }] };
  }
  const col = (r: Record<string, string>, name: string) => {
    const h = lower.get(name);
    return h ? r[h] : undefined;
  };
  const briefs: Brief[] = [];
  const errors: CsvRowError[] = [];
  parsed.records.forEach((r, idx) => {
    const row = idx + 2;
    const sku = col(r, 'sku')?.trim() ?? '';
    const locale = col(r, 'locale')?.trim() ?? '';
    const category = col(r, 'category')?.trim().toLowerCase() ?? '';
    if (!sku) return errors.push({ row, message: 'sku is empty' });
    if (sku.length > 64) return errors.push({ row, message: 'sku is longer than 64 characters' });
    if (!isLocale(locale)) return errors.push({ row, message: `locale "${locale}" is not one of ${LOCALES.join(', ')}` });
    if (!category) return errors.push({ row, message: 'category is empty' });
    const facts: Record<string, string> = {};
    for (const h of parsed.headers) {
      const key = h.toLowerCase().replace(/\s+/g, '_');
      if (RESERVED.has(key)) continue;
      const v = r[h]?.trim();
      if (!v) continue;
      facts[h.replace(/^fact[:.]\s*/i, '').trim()] = v;
    }
    if (!Object.keys(facts).length) return errors.push({ row, message: 'no fact columns have a value' });
    const brief: Brief = {
      sku,
      locale,
      category,
      facts,
      mustMention: splitList(col(r, 'must_mention') ?? col(r, 'mustmention')),
      banned: splitList(col(r, 'banned')),
    };
    const title = col(r, 'title')?.trim();
    const brand = col(r, 'brand')?.trim();
    const keywords = splitList(col(r, 'keywords'));
    if (title) brief.title = title;
    if (brand) brief.brand = brand;
    if (keywords.length) brief.keywords = keywords;
    briefs.push(brief);
  });
  return { briefs, errors };
}

/** Problems that make a batch unusable (400) and problems worth telling the editor about (warnings). */
export function validateBriefs(briefs: Brief[]): { errors: string[]; warnings: BatchWarning[] } {
  const errors: string[] = [];
  const warnings: BatchWarning[] = [];
  if (!briefs.length || briefs.length > MAX_BATCH) errors.push(`1-${MAX_BATCH} briefs per batch`);
  const seen = new Map<string, number>();
  briefs.forEach((b, i) => {
    const key = `${b.sku.trim().toLowerCase()}|${b.locale}`;
    const first = seen.get(key);
    if (first !== undefined) errors.push(`brief ${i + 1} repeats ${b.sku} (${b.locale}) from brief ${first + 1}`);
    else seen.set(key, i);
    for (const m of b.mustMention) {
      if (!m.trim()) errors.push(`brief ${i + 1}: empty "must mention" entry`);
    }
    const factText = Object.values(b.facts).join(' ').toLowerCase();
    for (const m of b.mustMention) {
      if (m.trim() && !factText.includes(m.trim().toLowerCase())) {
        warnings.push({ index: i, sku: b.sku, locale: b.locale, message: `"${m}" must be mentioned but is not in the facts` });
      }
    }
    for (const k of missingRequiredFacts(b.category, b.facts)) {
      warnings.push({ index: i, sku: b.sku, locale: b.locale, message: `no "${k}" fact (${categoryRule(b.category).label} copy needs it)` });
    }
    if (!isKnownCategory(b.category)) warnings.push({ index: i, sku: b.sku, locale: b.locale, message: `unknown category "${b.category}"; using general guidance` });
  });
  return { errors, warnings };
}

@Injectable()
export class BatchService {
  /** Batches already announced as complete in this process, so the event fires once. */
  private readonly completed = new Set<string>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BUDGET) private readonly budget: BudgetGuard,
    private readonly events: EventBus,
    @Inject(forwardRef(() => AuditService)) private readonly audit: AuditService,
  ) {}

  async create(briefs: Brief[], by: string, opts: { name?: string; source?: Batch['source'] } = {}): Promise<CreateBatchResult> {
    const normalized = briefs.map((b) => ({ ...b, sku: b.sku.trim(), category: b.category.trim().toLowerCase() }));
    const { errors, warnings } = validateBriefs(normalized);
    if (errors.length) throw new ValidationError(errors[0], { errors });
    const now = this.clock.now();
    const batch: Batch = {
      id: randomUUID(),
      name: opts.name?.trim() || `Batch ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      createdBy: by,
      createdAt: now.toISOString(),
      itemCount: normalized.length,
      source: opts.source ?? 'api',
      cancelledAt: null,
      cancelledBy: null,
    };
    const items: Item[] = normalized.map((b) => newItem(randomUUID(), batch.id, b, now, assignVariant(this.config.experiment, b.sku)));
    const estimatedCostUsd = estimateBatchCost(items.length);
    const status = await this.budget.status();
    if (status.remainingUsd !== null && estimatedCostUsd > status.remainingUsd) {
      warnings.push({ index: -1, sku: '', locale: '', message: `estimated $${estimatedCostUsd.toFixed(2)} exceeds today's remaining budget ($${status.remainingUsd.toFixed(2)}); the rest will run tomorrow` });
    }
    await this.store.batches.insert(batch);
    await this.store.items.insertMany(items);
    for (const i of items) await this.queue.add(i.id);
    this.events.publish({ type: 'batch.created', batchId: batch.id, itemCount: items.length, by, at: now.toISOString() });
    await this.audit.record(by, 'batch.create', `batch:${batch.id}`, { name: batch.name, items: items.length, source: batch.source, estimatedCostUsd });
    return { batchId: batch.id, itemIds: items.map((i) => i.id), warnings, estimatedCostUsd };
  }

  async importCsv(text: string, by: string, name?: string): Promise<CreateBatchResult> {
    const { briefs, errors } = briefsFromCsv(text);
    if (errors.length) throw new ValidationError(`row ${errors[0].row}: ${errors[0].message}`, { errors });
    if (!briefs.length) throw new ValidationError('the file has no rows');
    return this.create(briefs, by, { name, source: 'csv' });
  }

  async get(id: string): Promise<Batch> {
    const b = await this.store.batches.get(id);
    if (!b) throw new NotFoundError(`batch ${id} not found`);
    return b;
  }

  async summary(id: string): Promise<BatchSummary> {
    const batch = await this.get(id);
    const counts = await this.store.items.countByStatus({ batchId: id });
    let cost = 0;
    let scoreSum = 0;
    let scored = 0;
    const locales: Partial<Record<Locale, number>> = {};
    const categories: Record<string, number> = {};
    for await (const i of this.store.items.scan({ batchId: id })) {
      cost += i.usage?.costUsd ?? 0;
      if (i.score) {
        scoreSum += i.score.total;
        scored++;
      }
      locales[i.brief.locale] = (locales[i.brief.locale] ?? 0) + 1;
      categories[i.brief.category] = (categories[i.brief.category] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const pending = counts.queued + counts.generating + counts.scored;
    const settled = [...SETTLED].reduce((n, s) => n + counts[s], 0);
    return {
      batch,
      counts,
      total,
      generated: total ? Math.round(((total - pending) / total) * 1000) / 1000 : 0,
      settled: total ? Math.round((settled / total) * 1000) / 1000 : 0,
      done: total > 0 && settled === total,
      costUsd: Math.round(cost * 1e4) / 1e4,
      meanScore: scored ? Math.round((scoreSum / scored) * 1000) / 1000 : null,
      locales,
      categories,
    };
  }

  async list(opts: { limit?: number; cursor?: string | null; createdBy?: string }): Promise<Page<BatchSummary>> {
    const page = await this.store.batches.list(opts);
    const items = await Promise.all(page.items.map((b) => this.summary(b.id)));
    return { ...page, items };
  }

  /**
   * What went wrong in a batch and where: findings by code, review reasons, outcomes per locale and
   * category, and how much reviewers had to change. The merchandising team reads this to fix briefs.
   */
  async report(id: string): Promise<BatchReport> {
    await this.get(id);
    const findings = new Map<string, { code: string; items: number; blocking: number }>();
    const reasons = new Map<string, number>();
    const byLocale = new Map<string, { locale: string; items: number; autoApproved: number; reviewed: number; approved: number; published: number; failed: number }>();
    const errors = new Map<string, number>();
    let edited = 0;
    let editSum = 0;
    let approvedTotal = 0;
    for await (const i of this.store.items.scan({ batchId: id })) {
      const seen = new Set<string>();
      for (const f of i.score?.findings ?? []) {
        if (seen.has(f.code)) continue;
        seen.add(f.code);
        const row = findings.get(f.code) ?? { code: f.code, items: 0, blocking: 0 };
        row.items++;
        if (f.severity === 'block') row.blocking++;
        findings.set(f.code, row);
      }
      for (const r of i.routing?.reasons ?? []) {
        const key = r.startsWith('score ') ? 'score below threshold' : r.split(':')[0];
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      const loc = byLocale.get(i.brief.locale) ?? { locale: i.brief.locale, items: 0, autoApproved: 0, reviewed: 0, approved: 0, published: 0, failed: 0 };
      loc.items++;
      if (i.history.some((h) => h.to === 'auto_approved')) loc.autoApproved++;
      const outcome = reviewOutcome(i);
      if (outcome) loc.reviewed++;
      if (outcome === 'approved') {
        loc.approved++;
        approvedTotal++;
        if (i.draft && i.finalText && i.draft.trim() !== i.finalText.trim()) {
          edited++;
          editSum += editStats(i.draft, i.finalText).editRatio;
        }
      }
      if (i.status === 'published') loc.published++;
      if (i.status === 'failed') {
        loc.failed++;
        const e = (i.lastError ?? 'unknown error').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '…').slice(0, 120);
        errors.set(e, (errors.get(e) ?? 0) + 1);
      }
      byLocale.set(i.brief.locale, loc);
    }
    const sortDesc = <T>(xs: T[], n: (x: T) => number) => xs.sort((a, b) => n(b) - n(a));
    return {
      batchId: id,
      findings: sortDesc([...findings.values()], (f) => f.items),
      reasons: sortDesc([...reasons.entries()].map(([reason, items]) => ({ reason, items })), (r) => r.items),
      locales: [...byLocale.values()].sort((a, b) => LOCALES.indexOf(a.locale as Locale) - LOCALES.indexOf(b.locale as Locale)),
      edits: { approved: approvedTotal, edited, meanEditRatio: edited ? Math.round((editSum / edited) * 1000) / 1000 : null },
      errors: sortDesc([...errors.entries()].map(([message, items]) => ({ message, items })), (e) => e.items),
    };
  }

  /** Cancel everything in a batch that is not published yet. Published copy stays live. */
  async cancel(id: string, by: string): Promise<{ cancelled: number }> {
    const batch = await this.get(id);
    if (batch.cancelledAt) throw new ConflictError('batch is already cancelled');
    const now = this.clock.now();
    batch.cancelledAt = now.toISOString();
    batch.cancelledBy = by;
    await this.store.batches.save(batch);
    let cancelled = 0;
    const cancellable: Status[] = ['queued', 'generating', 'in_review', 'auto_approved', 'approved', 'rejected', 'failed'];
    for await (const item of this.store.items.scan({ batchId: id, status: cancellable })) {
      if (await this.cancelItem(item, by, now)) cancelled++;
    }
    this.events.publish({ type: 'batch.cancelled', batchId: id, by, cancelled, at: now.toISOString() });
    await this.audit.record(by, 'batch.cancel', `batch:${id}`, { cancelled });
    return { cancelled };
  }

  private async cancelItem(item: Item, by: string, now: Date): Promise<boolean> {
    let current: Item | null = item;
    for (let n = 0; n < 3 && current; n++) {
      const working = normalizeItem(current);
      if (SETTLED.has(working.status) || working.status === 'scored') return false;
      transition(working, 'cancelled', by, now, 'batch cancelled');
      working.lease = null;
      try {
        await this.store.items.save(working);
        this.events.publish({ type: 'item.status', itemId: working.id, batchId: working.batchId, from: item.status, to: 'cancelled', by, at: now.toISOString() });
        return true;
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
        current = await this.store.items.get(item.id);
      }
    }
    return false;
  }

  /** Queue every failed item of a batch again. */
  async retryFailed(id: string, by: string): Promise<{ requeued: number }> {
    const batch = await this.get(id);
    if (batch.cancelledAt) throw new ConflictError('the batch was cancelled');
    const now = this.clock.now();
    let requeued = 0;
    for await (const item of this.store.items.scan({ batchId: id, status: ['failed'] })) {
      const working = normalizeItem(item);
      transition(working, 'queued', by, now, 'retry failed');
      working.lastError = null;
      try {
        await this.store.items.save(working);
      } catch (e) {
        if (e instanceof StaleWriteError) continue;
        throw e;
      }
      await this.queue.add(working.id, { priority: 5 });
      requeued++;
    }
    if (requeued) this.completed.delete(id);
    await this.audit.record(by, 'batch.retry_failed', `batch:${id}`, { requeued });
    return { requeued };
  }

  /** Announce a batch as complete once nothing in it needs the pipeline or a person any more. */
  async checkCompletion(id: string): Promise<boolean> {
    if (this.completed.has(id)) return true;
    const counts = await this.store.items.countByStatus({ batchId: id });
    if (ACTIVE.some((s) => counts[s] > 0)) return false;
    this.completed.add(id);
    this.events.publish({ type: 'batch.completed', batchId: id, at: this.clock.now().toISOString() });
    return true;
  }
}
