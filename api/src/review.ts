import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runChecks } from './checks';
import { addMs, Clock } from './clock';
import type { AppConfig } from './config';
import { Brief, Finding, Item, leaseActive, normalizeItem, reviewReasons, reviewSpan } from './domain';
import { ConflictError, ForbiddenError, NotFoundError, StaleWriteError, ValidationError } from './errors';
import { EventBus } from './events';
import { GlossaryService } from './glossary.service';
import { PolicyService } from './policy';
import { Comment, ItemFilter, Store, STORE } from './repository';
import { diffWords, DiffOp, editStats, EditStats } from './text/diff';
import { fixTypography } from './text/typography';
import { CLOCK, CONFIG } from './tokens';

export interface QueueEntry {
  item: Item;
  reasons: string[];
  openComments: number;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  /** Waiting longer than the review SLA. */
  overdue: boolean;
  /** When the draft entered review. */
  enteredAt: string | null;
}

export interface ItemView {
  item: Item;
  reasons: string[];
  comments: Comment[];
  /** Diff from the model's draft to the final text, when a reviewer edited it. */
  diff: DiffOp[] | null;
  edits: EditStats | null;
  /** Diff between the last two model drafts, for revisions. */
  revisionDiff: DiffOp[] | null;
}

/**
 * Reviewer workflow: leasing items so two reviewers never work on the same draft, the queue view with
 * the reasons each draft is there, comments anchored to spans of the draft, and linting edited text.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly events: EventBus,
    private readonly policies: PolicyService,
    private readonly glossary: GlossaryService,
  ) {}

  /** Lease the next item (worst score first). A reviewer who reloads gets their own leased item back. */
  async claim(reviewer: string, filter: ItemFilter = {}): Promise<Item | null> {
    const now = this.clock.now();
    const item = await this.store.items.claimNext(reviewer, now, this.config.leaseMs, filter);
    if (item?.lease) this.events.publish({ type: 'item.leased', itemId: item.id, reviewer, expiresAt: item.lease.expiresAt, at: now.toISOString() });
    return item;
  }

  /** Keep a lease alive while the reviewer is still editing. */
  async heartbeat(id: string, reviewer: string): Promise<Item> {
    return this.updateLease(id, reviewer, (item, now) => {
      if (!item.lease || item.lease.reviewer !== reviewer) throw new ConflictError('you do not hold this item');
      item.lease = { reviewer, expiresAt: addMs(now, this.config.leaseMs).toISOString() };
    });
  }

  async release(id: string, reviewer: string): Promise<Item> {
    const now = this.clock.now();
    const saved = await this.updateLease(id, reviewer, (item) => {
      if (!item.lease) return;
      if (item.lease.reviewer !== reviewer && leaseActive(item, now)) throw new ForbiddenError(`item is leased by ${item.lease.reviewer}`);
      item.lease = null;
    });
    this.events.publish({ type: 'item.released', itemId: id, reviewer, at: now.toISOString() });
    return saved;
  }

  private async updateLease(id: string, reviewer: string, mutate: (i: Item, now: Date) => void): Promise<Item> {
    for (let n = 0; n < 3; n++) {
      const item = await this.store.items.get(id);
      if (!item) throw new NotFoundError(`item ${id} not found`);
      if (item.status !== 'in_review') throw new ConflictError(`item is ${item.status}`);
      const working = normalizeItem(item);
      mutate(working, this.clock.now());
      try {
        return await this.store.items.save(working);
      } catch (e) {
        if (!(e instanceof StaleWriteError)) throw e;
      }
    }
    throw new ConflictError('item is changing too fast; try again');
  }

  async queue(filter: ItemFilter = {}, limit = 100): Promise<QueueEntry[]> {
    const page = await this.store.items.query({ ...filter, status: ['in_review'], sort: 'score_asc', limit });
    const open = await this.store.comments.countOpen(page.items.map((i) => i.id));
    const now = this.clock.now();
    return page.items.map((item) => {
      const leased = leaseActive(item, now);
      const enteredAt = reviewSpan(item)?.enteredAt ?? null;
      return {
        item,
        reasons: item.routing?.reasons ?? reviewReasons(item, this.policies.current),
        openComments: open[item.id] ?? 0,
        leasedBy: leased ? item.lease!.reviewer : null,
        leaseExpiresAt: leased ? item.lease!.expiresAt : null,
        overdue: !!enteredAt && now.getTime() - Date.parse(enteredAt) > this.config.reviewSlaMs,
        enteredAt,
      };
    });
  }

  async view(id: string): Promise<ItemView> {
    const item = await this.store.items.get(id);
    if (!item) throw new NotFoundError(`item ${id} not found`);
    const comments = await this.store.comments.list(id);
    const edited = !!item.draft && !!item.finalText && item.finalText.trim() !== item.draft.trim();
    const modelDrafts = (item.revisions ?? []).filter((r) => r.source === 'model');
    const prev = modelDrafts.length >= 2 ? modelDrafts[modelDrafts.length - 2] : null;
    const last = modelDrafts.length >= 1 ? modelDrafts[modelDrafts.length - 1] : null;
    return {
      item,
      reasons: item.routing?.reasons ?? (item.score ? reviewReasons(item, this.policies.current) : []),
      comments,
      diff: edited ? diffWords(item.draft!, item.finalText!) : null,
      edits: edited ? editStats(item.draft!, item.finalText!) : null,
      revisionDiff: prev && last ? diffWords(prev.text, last.text) : null,
    };
  }

  async addComment(itemId: string, author: string, body: string, anchor?: { start: number; end: number }): Promise<Comment> {
    const item = await this.store.items.get(itemId);
    if (!item) throw new NotFoundError(`item ${itemId} not found`);
    const text = body?.trim() ?? '';
    if (!text) throw new ValidationError('comment is empty');
    if (text.length > 2000) throw new ValidationError('comment is longer than 2000 characters');
    if (anchor) {
      const len = item.draft?.length ?? 0;
      if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end > len || anchor.start > anchor.end) {
        throw new ValidationError(`anchor must be within the draft (0-${len})`);
      }
    }
    const c: Comment = {
      id: randomUUID(),
      itemId,
      author,
      body: text,
      at: this.clock.now().toISOString(),
      start: anchor?.start ?? null,
      end: anchor?.end ?? null,
      resolved: false,
    };
    await this.store.comments.add(c);
    this.events.publish({ type: 'item.comment', itemId, commentId: c.id, author, at: c.at });
    return c;
  }

  async resolveComment(id: string, by: string, resolved = true): Promise<Comment> {
    const c = await this.store.comments.get(id);
    if (!c) throw new NotFoundError(`comment ${id} not found`);
    if (c.resolved === resolved) return c;
    c.resolved = resolved;
    await this.store.comments.save(c);
    this.events.publish({ type: 'item.comment', itemId: c.itemId, commentId: c.id, author: by, at: this.clock.now().toISOString() });
    return c;
  }

  comments(itemId: string): Promise<Comment[]> {
    return this.store.comments.list(itemId);
  }

  /**
   * Run the deterministic checks on text a reviewer is about to approve, so edits don't introduce the
   * problems the pipeline exists to catch. Also returns the text with safe typography fixes applied.
   */
  async lint(brief: Brief, text: string): Promise<{ findings: Finding[]; fixed: string; blocking: number }> {
    if (!text?.trim()) throw new ValidationError('text is empty');
    const terms = await this.glossary.forLocale(brief.locale);
    const { findings } = runChecks({ brief, draft: text, glossary: terms });
    return { findings, fixed: fixTypography(text, brief.locale), blocking: findings.filter((f) => f.severity === 'block').length };
  }

  async lintItem(id: string, text: string) {
    const item = await this.store.items.get(id);
    if (!item) throw new NotFoundError(`item ${id} not found`);
    return this.lint(item.brief, text);
  }
}
