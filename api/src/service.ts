import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { AuditService } from './audit';
import { BatchService } from './batches';
import { sortFindings } from './checks';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import { addUsage, Brief, decideRoute, EMPTY_USAGE, Finding, Item, leaseActive, normalizeItem, RoutingPolicy, Status, transition } from './domain';
import { BudgetExceededError, ConflictError, describeError, isRetryable, NotFoundError, StaleWriteError, ValidationError } from './errors';
import { EventBus } from './events';
import { GlossaryService } from './glossary.service';
import { generateDraft, scoreDraft } from './llm';
import { OutboxService } from './outbox';
import { PolicyService } from './policy';
import { JobOutcome, JobQueue, MAX_ATTEMPTS } from './queue';
import { Store, STORE } from './repository';
import { unmatched } from './consistency';
import { DuplicateIndex } from './text/similarity';
import { findMeasurements } from './text/units';
import { BUDGET, CLOCK, CONFIG, JOB_QUEUE, LLM_CLIENT, RANDOM } from './tokens';
import { BudgetGuard, UsageMeter } from './usage';

export { JOB_QUEUE, LLM_CLIENT, POLICY, RANDOM } from './tokens';

export type ReviewDecision = 'approve' | 'reject' | 'revise';

export type BulkAction = 'publish' | 'regenerate' | 'reopen' | 'withdraw';
export const BULK_ACTIONS: readonly BulkAction[] = ['publish', 'regenerate', 'reopen', 'withdraw'];
export const MAX_BULK = 200;

export interface BulkResult {
  action: BulkAction;
  done: { id: string; status: Status }[];
  failed: { id: string; error: string }[];
}

/** Similarity above which two drafts in one batch count as near-duplicates. */
export const DUPLICATE_THRESHOLD = 0.8;

/**
 * The content pipeline: the queue worker (generate → score → route) and the item-level actions that
 * move drafts through review and publishing. Items live in the Store (Postgres in production); every
 * write is a compare-and-set on the item's version, so a reviewer and a worker never overwrite each
 * other silently.
 */
@Injectable()
export class ContentService {
  constructor(
    @Inject(LLM_CLIENT) private readonly client: any,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(RANDOM) private readonly rand: () => number,
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BUDGET) private readonly budget: BudgetGuard,
    private readonly policies: PolicyService,
    private readonly glossary: GlossaryService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(forwardRef(() => BatchService)) private readonly batches: BatchService,
  ) {
    queue.process((id, attempt) => this.work(id, attempt));
  }

  get policy(): RoutingPolicy {
    return this.policies.current;
  }

  /** Kept for callers of the original API; see BatchService for names, CSV import and estimates. */
  async createBatch(briefs: Brief[], by = 'system'): Promise<{ batchId: string; itemIds: string[] }> {
    const r = await this.batches.create(briefs, by);
    return { batchId: r.batchId, itemIds: r.itemIds };
  }

  /* ------------------------------------------------------------------ worker */

  /** Worker: generate → score → route. Idempotent: a redelivered job for a finished item does nothing. */
  async work(id: string, attempt: number): Promise<JobOutcome> {
    let item = await this.store.items.get(id);
    if (!item || (item.status !== 'queued' && item.status !== 'generating')) return;

    const batch = await this.store.batches.get(item.batchId);
    if (batch?.cancelledAt) {
      await this.tryCommit(item, (i) => transition(i, 'cancelled', 'worker', this.clock.now(), 'batch cancelled'));
      return;
    }

    try {
      await this.budget.assertAvailable();
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      this.events.publish({ type: 'budget.exceeded', spentUsd: e.spentUsd, limitUsd: e.limitUsd, at: this.clock.now().toISOString() });
      return { retryAt: e.resumeAt };
    }

    // Claim the item. Losing this race means another worker or a cancel got there first.
    const claimed = await this.tryCommit(item, (i) => {
      if (i.status === 'queued') transition(i, 'generating', 'worker', this.clock.now());
      i.attempts = attempt;
    });
    if (!claimed) return;
    item = claimed;

    const meter = new UsageMeter();
    let recorded = false;
    const record = async () => {
      if (recorded) return;
      recorded = true;
      await this.budget.record(meter.value);
    };

    try {
      const terms = await this.glossary.forLocale(item.brief.locale);
      const feedback = item.reviewNote ?? undefined;
      const gen = await generateDraft(this.client, item.brief, feedback, {
        variant: item.variant,
        glossary: terms,
        previousDraft: feedback ? item.draft : null,
        promptCache: this.config.promptCache,
      });
      meter.add(gen.usage);
      const scored = await scoreDraft(this.client, item.brief, gen.text, { glossary: terms, promptCache: this.config.promptCache });
      meter.add(scored.usage);
      await record();

      const extra = [...(await this.nearDuplicates(item, gen.text)), ...(await this.localeMismatches(item, gen.text))];
      const score = { ...scored.score };
      if (extra.length) {
        score.findings = sortFindings([...(score.findings ?? []), ...extra]);
        score.notes = [...score.notes, ...extra.map((d) => `${d.code}: ${d.message}`)];
      }

      const saved = await this.tryCommit(item, (i) => {
        if (i.status !== 'generating') throw new AbandonWork();
        const now = this.clock.now();
        i.draft = gen.text;
        i.score = score;
        i.variant = gen.variant;
        i.lastError = null;
        i.usage = addUsage(i.usage ?? EMPTY_USAGE, meter.value);
        i.revisions = [...(i.revisions ?? []), { at: now.toISOString(), text: gen.text, source: 'model', note: feedback ?? null }];
        transition(i, 'scored', 'worker', now);
        const routing = decideRoute(i, this.policy, this.rand);
        i.routing = routing;
        transition(i, routing.decision, 'router', now, routing.reasons.join('; ') || undefined);
        i.finalText = routing.decision === 'auto_approved' ? i.draft : null;
      });
      if (saved) await this.batches.checkCompletion(saved.batchId);
    } catch (e) {
      await record();
      if (e instanceof AbandonWork) return;
      const retry = isRetryable(e) && attempt < MAX_ATTEMPTS;
      const failed = await this.tryCommit(item, (i) => {
        if (i.status !== 'generating') throw new AbandonWork();
        i.attempts = attempt;
        i.lastError = describeError(e);
        i.usage = addUsage(i.usage ?? EMPTY_USAGE, meter.value);
        if (!retry) transition(i, 'failed', 'worker', this.clock.now(), i.lastError);
      }).catch((inner) => {
        if (inner instanceof AbandonWork) return null;
        throw inner;
      });
      if (!retry) {
        if (failed) await this.batches.checkCompletion(failed.batchId);
        return; // permanent: tell the queue not to retry
      }
      throw e; // let the queue retry with backoff
    }
  }

  /** Near-duplicate drafts for other SKUs in the same batch and locale. */
  private async nearDuplicates(item: Item, text: string): Promise<Finding[]> {
    const page = await this.store.items.query({ batchId: item.batchId, locale: [item.brief.locale], sort: 'updated_desc', limit: 300 });
    const others = page.items.filter((o) => o.id !== item.id && o.brief.sku !== item.brief.sku && o.draft);
    if (!others.length) return [];
    const index = new DuplicateIndex();
    for (const o of others) index.add(o.id, o.draft!);
    const bySku = new Map(others.map((o) => [o.id, o.brief.sku]));
    return index.query(text, DUPLICATE_THRESHOLD).slice(0, 3).map((m) => ({
      code: 'duplicate.near',
      severity: 'warn' as const,
      message: `${Math.round(m.similarity * 100)}% the same as the draft for ${bySku.get(m.key)}`,
    }));
  }

  /**
   * Measurements that disagree with the same SKU's copy in other locales. Each locale passes its own
   * checks against its own facts, so a French brief with the wrong size would otherwise auto-approve.
   * Siblings whose own sizes were already flagged are not trusted as a reference.
   */
  private async localeMismatches(item: Item, text: string): Promise<Finding[]> {
    const page = await this.store.items.query({ sku: item.brief.sku, limit: 20 });
    const live: Status[] = ['in_review', 'auto_approved', 'approved', 'published'];
    const siblings = page.items.filter(
      (o) =>
        o.id !== item.id &&
        o.brief.locale !== item.brief.locale &&
        live.includes(o.status) &&
        !!(o.finalText ?? o.draft) &&
        !(o.score?.findings ?? []).some((f) => f.code.startsWith('units.') || f.code === 'locale.mismatch'),
    );
    const mine = findMeasurements(text, item.brief.locale);
    const out: Finding[] = [];
    for (const s of siblings) {
      const theirs = findMeasurements((s.finalText ?? s.draft)!, s.brief.locale);
      const bad = unmatched(mine, theirs);
      if (!bad.length) continue;
      const counterpart = theirs.filter((t) => bad.some((b) => b.unit.dimension === t.unit.dimension));
      out.push({
        code: 'locale.mismatch',
        severity: 'block',
        message: `says ${bad.map((b) => b.text.trim()).join(', ')} but the ${s.brief.locale} copy says ${counterpart.map((c) => c.text.trim()).join(', ')}`,
        start: bad[0].start,
        end: bad[0].end,
      });
    }
    return out;
  }

  /**
   * Apply `mutate` to the latest version of an item and save it, retrying a few times when another
   * writer got in between. Returns null if the item disappeared. Emits status events for new history.
   */
  private async tryCommit(item: Item, mutate: (i: Item) => void, retries = 3): Promise<Item | null> {
    let current: Item | null = item;
    for (let n = 0; n <= retries && current; n++) {
      const working = normalizeItem(structuredClone(current));
      const mark = working.history.length;
      mutate(working);
      try {
        const saved = await this.store.items.save(working);
        this.emitHistory(saved, mark);
        return saved;
      } catch (e) {
        if (!(e instanceof StaleWriteError) || n === retries) throw e;
        current = await this.store.items.get(item.id);
      }
    }
    return null;
  }

  private emitHistory(item: Item, from: number) {
    for (const h of item.history.slice(from)) {
      this.events.publish({ type: 'item.status', itemId: item.id, batchId: item.batchId, from: h.from, to: h.to, by: h.by, at: h.at });
    }
  }

  /** Save a reviewer or publisher action on an item they just read. A lost race is a 409, not a retry. */
  private async commitAction(item: Item, mark: number): Promise<Item> {
    try {
      const saved = await this.store.items.save(item);
      this.emitHistory(saved, mark);
      return saved;
    } catch (e) {
      if (e instanceof StaleWriteError) throw new ConflictError('the item changed while you were working on it; reload and try again', { id: item.id });
      throw e;
    }
  }

  /* ------------------------------------------------------------------ reads */

  async get(id: string): Promise<Item> {
    const i = await this.store.items.get(id);
    if (!i) throw new NotFoundError(`item ${id} not found`);
    return i;
  }

  async reviewQueue(limit = 200): Promise<Item[]> {
    const page = await this.store.items.query({ status: ['in_review'], sort: 'score_asc', limit });
    return page.items; // worst first
  }

  /* ------------------------------------------------------------------ actions */

  async review(id: string, reviewer: string, decision: ReviewDecision, opts: { editedText?: string; note?: string }): Promise<Item> {
    const item = normalizeItem(await this.get(id));
    const now = this.clock.now();
    if (item.status !== 'in_review') throw new ConflictError(`item is ${item.status}`);
    if (leaseActive(item, now) && item.lease!.reviewer !== reviewer) throw new ConflictError(`item is being reviewed by ${item.lease!.reviewer}`);
    const mark = item.history.length;
    item.reviewer = reviewer;
    item.lease = null;
    if (decision === 'approve') {
      const edited = opts.editedText?.trim();
      item.finalText = edited || item.draft;
      if (edited && edited !== item.draft?.trim()) {
        item.revisions = [...item.revisions, { at: now.toISOString(), text: edited, source: 'reviewer', note: opts.note?.trim() || null }];
      }
      transition(item, 'approved', reviewer, now, edited && edited !== item.draft?.trim() ? 'approved with edits' : undefined);
    } else if (decision === 'reject') {
      item.reviewNote = opts.note?.trim() || null;
      transition(item, 'rejected', reviewer, now, item.reviewNote ?? undefined);
    } else {
      if (!opts.note || opts.note.trim().length < 5) throw new ValidationError('revision needs a note for the writer model');
      item.reviewNote = opts.note.trim();
      item.finalText = null;
      transition(item, 'queued', reviewer, now, item.reviewNote);
    }
    const saved = await this.commitAction(item, mark);
    if (decision === 'revise') await this.queue.add(saved.id, { priority: 1 });
    if (decision === 'reject') await this.batches.checkCompletion(saved.batchId);
    return saved;
  }

  async publish(id: string, by: string): Promise<Item> {
    const item = normalizeItem(await this.get(id));
    if (item.status !== 'approved' && item.status !== 'auto_approved') throw new ConflictError(`item is ${item.status}`);
    if (!item.finalText) throw new ConflictError('item has no final text');
    const now = this.clock.now();
    const mark = item.history.length;
    transition(item, 'published', by, now);
    item.publishedAt = now.toISOString();
    const saved = await this.commitAction(item, mark);
    await this.outbox.enqueue('item.published', {
      itemId: saved.id,
      batchId: saved.batchId,
      sku: saved.brief.sku,
      locale: saved.brief.locale,
      category: saved.brief.category,
      text: saved.finalText,
      publishedAt: saved.publishedAt,
      publishedBy: by,
    });
    await this.audit.record(by, 'item.publish', `item:${saved.id}`, { sku: saved.brief.sku, locale: saved.brief.locale });
    await this.batches.checkCompletion(saved.batchId);
    return saved;
  }

  /** Publish every approved or auto-approved item of a batch. Items that fail are reported, not thrown. */
  async publishBatch(batchId: string, by: string): Promise<{ published: string[]; skipped: { id: string; reason: string }[] }> {
    const published: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for await (const item of this.store.items.scan({ batchId, status: ['approved', 'auto_approved'] })) {
      try {
        await this.publish(item.id, by);
        published.push(item.id);
      } catch (e) {
        skipped.push({ id: item.id, reason: (e as Error).message });
      }
    }
    return { published, skipped };
  }

  /** Take published copy down (wrong product data, a recall). Downstream systems get an item.withdrawn event. */
  async withdraw(id: string, by: string, reason: string): Promise<Item> {
    if (!reason || reason.trim().length < 5) throw new ValidationError('withdrawing needs a reason');
    const item = normalizeItem(await this.get(id));
    if (item.status !== 'published') throw new ConflictError(`item is ${item.status}`);
    const mark = item.history.length;
    transition(item, 'withdrawn', by, this.clock.now(), reason.trim());
    const saved = await this.commitAction(item, mark);
    await this.outbox.enqueue('item.withdrawn', { itemId: saved.id, sku: saved.brief.sku, locale: saved.brief.locale, reason: reason.trim(), withdrawnBy: by });
    await this.audit.record(by, 'item.withdraw', `item:${saved.id}`, { reason: reason.trim() });
    return saved;
  }

  /** Generate again from scratch: failed, rejected or withdrawn items. */
  async regenerate(id: string, by: string, note?: string): Promise<Item> {
    const item = normalizeItem(await this.get(id));
    const allowed: Status[] = ['failed', 'rejected', 'withdrawn'];
    if (!allowed.includes(item.status)) throw new ConflictError(`item is ${item.status}; only ${allowed.join(', ')} items can be regenerated`);
    const batch = await this.store.batches.get(item.batchId);
    if (batch?.cancelledAt) throw new ConflictError('the batch was cancelled');
    const mark = item.history.length;
    item.reviewNote = note?.trim() || item.reviewNote;
    item.lastError = null;
    item.finalText = null;
    transition(item, 'queued', by, this.clock.now(), note?.trim() || 'regenerate');
    const saved = await this.commitAction(item, mark);
    await this.queue.add(saved.id, { priority: 5 });
    return saved;
  }

  /**
   * Apply one action to many items (from a search result). Each item succeeds or fails on its own; a
   * conflict on one item does not stop the rest.
   */
  async bulk(action: BulkAction, ids: string[], by: string, reason?: string): Promise<BulkResult> {
    if (!ids.length) throw new ValidationError('no items selected');
    if (ids.length > MAX_BULK) throw new ValidationError(`at most ${MAX_BULK} items at a time`);
    if ((action === 'withdraw' || action === 'reopen') && (!reason || reason.trim().length < 5)) throw new ValidationError(`${action} needs a reason`);
    const done: BulkResult['done'] = [];
    const failed: BulkResult['failed'] = [];
    for (const id of [...new Set(ids)]) {
      try {
        const item =
          action === 'publish'
            ? await this.publish(id, by)
            : action === 'regenerate'
              ? await this.regenerate(id, by, reason)
              : action === 'reopen'
                ? await this.reopen(id, by, reason!)
                : await this.withdraw(id, by, reason!);
        done.push({ id, status: item.status });
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    return { action, done, failed };
  }

  /** Send an approved or auto-approved draft back to review (a publisher spots a problem). */
  async reopen(id: string, by: string, reason: string): Promise<Item> {
    if (!reason || reason.trim().length < 5) throw new ValidationError('reopening needs a reason');
    const item = normalizeItem(await this.get(id));
    if (item.status !== 'approved' && item.status !== 'auto_approved') throw new ConflictError(`item is ${item.status}`);
    const mark = item.history.length;
    item.finalText = null;
    transition(item, 'in_review', by, this.clock.now(), reason.trim());
    return this.commitAction(item, mark);
  }
}

/** Thrown inside a commit when the item moved on (cancelled, re-queued) while the worker was busy. */
class AbandonWork extends Error {
  constructor() {
    super('item changed while generating; result discarded');
  }
}
