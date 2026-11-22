import { Inject, Injectable } from '@nestjs/common';
import type { Item, Locale, Status } from './domain';
import { ItemFilter, Store, STORE } from './repository';
import { toCsv } from './text/csv';

/**
 * Exports for the PIM team and for audits: published copy as CSV or JSON Lines, and a review log with
 * the model draft next to what the reviewer approved.
 */
export type ExportFormat = 'csv' | 'jsonl';

export interface ExportOptions {
  locale?: Locale[];
  batchId?: string;
  category?: string[];
  /** ISO timestamp: only items published at or after it. */
  since?: string;
  format?: ExportFormat;
}

export const PUBLISHED_COLUMNS = ['sku', 'locale', 'category', 'text', 'published_at', 'batch_id', 'item_id'] as const;
export const REVIEW_COLUMNS = ['sku', 'locale', 'category', 'status', 'score', 'reviewer', 'decision', 'draft', 'final_text', 'note', 'decided_at', 'item_id'] as const;

export function publishedRow(i: Item): Record<(typeof PUBLISHED_COLUMNS)[number], string> {
  return {
    sku: i.brief.sku,
    locale: i.brief.locale,
    category: i.brief.category,
    text: i.finalText ?? '',
    published_at: i.publishedAt ?? i.history.find((h) => h.to === 'published')?.at ?? '',
    batch_id: i.batchId,
    item_id: i.id,
  };
}

export function reviewRow(i: Item): Record<(typeof REVIEW_COLUMNS)[number], string> {
  const decision = [...i.history].reverse().find((h) => h.from === 'in_review');
  return {
    sku: i.brief.sku,
    locale: i.brief.locale,
    category: i.brief.category,
    status: i.status,
    score: i.score ? i.score.total.toFixed(3) : '',
    reviewer: i.reviewer ?? '',
    decision: decision ? (decision.to === 'queued' ? 'revise' : decision.to) : '',
    draft: i.draft ?? '',
    final_text: i.finalText ?? '',
    note: i.reviewNote ?? '',
    decided_at: decision?.at ?? '',
    item_id: i.id,
  };
}

@Injectable()
export class ExportService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  private filter(opts: ExportOptions, status: Status[]): ItemFilter {
    return { status, locale: opts.locale, batchId: opts.batchId, category: opts.category };
  }

  async published(opts: ExportOptions = {}): Promise<{ contentType: string; body: string; count: number }> {
    const rows: Record<string, string>[] = [];
    for await (const i of this.store.items.scan(this.filter(opts, ['published']))) {
      const row = publishedRow(i);
      if (opts.since && row.published_at < opts.since) continue;
      rows.push(row);
    }
    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.locale.localeCompare(b.locale));
    return this.render(rows, [...PUBLISHED_COLUMNS], opts.format ?? 'csv');
  }

  async reviewLog(opts: ExportOptions = {}): Promise<{ contentType: string; body: string; count: number }> {
    const rows: Record<string, string>[] = [];
    const statuses: Status[] = ['approved', 'rejected', 'published', 'queued', 'withdrawn', 'cancelled'];
    for await (const i of this.store.items.scan(this.filter(opts, statuses))) {
      const row = reviewRow(i);
      if (!row.decision) continue;
      if (opts.since && row.decided_at < opts.since) continue;
      rows.push(row);
    }
    rows.sort((a, b) => a.decided_at.localeCompare(b.decided_at));
    return this.render(rows, [...REVIEW_COLUMNS], opts.format ?? 'csv');
  }

  private render(rows: Record<string, string>[], columns: string[], format: ExportFormat) {
    if (format === 'jsonl') {
      return { contentType: 'application/x-ndjson; charset=utf-8', body: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), count: rows.length };
    }
    // BOM so Excel opens accented copy (es-US, fr-CA) as UTF-8.
    return { contentType: 'text/csv; charset=utf-8', body: `﻿${toCsv(columns, rows)}`, count: rows.length };
  }
}
