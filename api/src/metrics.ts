import { Inject, Injectable } from '@nestjs/common';
import { Clock, daysBetween, DAY, elapsedMs, utcDay } from './clock';
import type { AppConfig } from './config';
import { Item, reviewOutcome, reviewSpan, RoutingPolicy, Status, STATUSES, thresholdFor, wasSampled } from './domain';
import { experimentReport, ExperimentReport } from './experiments';
import { PolicyService } from './policy';
import { emptyStatusCounts, ItemFilter, Store, STORE } from './repository';
import { editStats } from './text/diff';
import { BUDGET, CLOCK, CONFIG } from './tokens';
import { BudgetGuard } from './usage';

/* ------------------------------------------------------------------ statistics */

/** Wilson score interval for a binomial proportion; better than the normal interval at small n. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { low: r(Math.max(0, centre - half)), high: r(Math.min(1, centre + half)) };
}

/** Linear-interpolated percentile of an unsorted list; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const round = (x: number | null, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/* ------------------------------------------------------------------ calibration */

export interface CalibrationRow {
  threshold: number;
  /** Reviewed drafts at or above the threshold (whose only reason for review was score or the QA sample). */
  n: number;
  approved: number;
  precision: number | null;
  ci: { low: number; high: number } | null;
  /** Share of eligible drafts that would auto-approve at this threshold. */
  coverage: number | null;
}

/**
 * Would a different threshold be safe? Uses drafts a reviewer decided whose only review reason was the
 * score or the QA sample — drafts with blocking findings would go to review at any threshold, so they
 * say nothing about it.
 */
export function calibration(items: Item[], policy: RoutingPolicy, thresholds: number[] = range(0.7, 0.98, 0.02)): CalibrationRow[] {
  const eligible = items.filter((i) => {
    if (!i.score || i.score.judge === null) return false;
    const reasons = i.routing?.reasons;
    if (reasons) return reasons.every((r) => r.startsWith('score ') || r === 'QA sample');
    return wasSampled(i, policy);
  });
  const decided = eligible
    .map((i) => ({ score: i.score!.total, outcome: reviewOutcome(i) }))
    .filter((x): x is { score: number; outcome: 'approved' | 'rejected' | 'revised' } => x.outcome !== null);
  const scoredEligible = items.filter((i) => i.score && i.score.judge !== null && i.score.facts === 1 && i.score.claims === 1 && !(i.score.findings ?? []).some((f) => f.severity === 'block'));
  return thresholds.map((t) => {
    const above = decided.filter((d) => d.score >= t);
    const approved = above.filter((d) => d.outcome === 'approved').length;
    return {
      threshold: round(t, 2)!,
      n: above.length,
      approved,
      precision: above.length ? round(approved / above.length) : null,
      ci: wilsonInterval(approved, above.length),
      coverage: scoredEligible.length ? round(scoredEligible.filter((i) => i.score!.total >= t).length / scoredEligible.length) : null,
    };
  });
}

/**
 * The lowest threshold whose precision lower bound (95% Wilson) clears the target, with enough evidence.
 * Lower thresholds auto-approve more, so the lowest safe one saves the most review time.
 */
export function recommendThreshold(rows: CalibrationRow[], target = 0.95, minN = 30): { threshold: number | null; reason: string } {
  const ok = rows.filter((r) => r.n >= minN && r.ci && r.ci.low >= target).sort((a, b) => a.threshold - b.threshold);
  if (ok.length) return { threshold: ok[0].threshold, reason: `lowest threshold with ≥${minN} reviewed drafts and a 95% lower bound ≥ ${target}` };
  const evidence = Math.max(0, ...rows.map((r) => r.n));
  return { threshold: null, reason: evidence < minN ? `not enough reviewed drafts yet (best has ${evidence}, need ${minN})` : `no threshold reaches ${target} with confidence` };
}

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 100) / 100);
  return out;
}

/* ------------------------------------------------------------------ aggregates */

export interface GroupStats {
  key: string;
  items: number;
  inReview: number;
  autoApproved: number;
  published: number;
  failed: number;
  meanScore: number | null;
  /** Approvals over reviewer decisions. */
  approvalRate: number | null;
}

export function groupStats(items: Item[], keyOf: (i: Item) => string): GroupStats[] {
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const k = keyOf(i);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  return [...groups.entries()]
    .map(([key, is]) => {
      const outcomes = is.map(reviewOutcome).filter((o) => o !== null);
      const scores = is.filter((i) => i.score).map((i) => i.score!.total);
      return {
        key,
        items: is.length,
        inReview: is.filter((i) => i.status === 'in_review').length,
        autoApproved: is.filter((i) => i.history.some((h) => h.to === 'auto_approved')).length,
        published: is.filter((i) => i.status === 'published').length,
        failed: is.filter((i) => i.status === 'failed').length,
        meanScore: round(mean(scores)),
        approvalRate: outcomes.length ? round(outcomes.filter((o) => o === 'approved').length / outcomes.length) : null,
      };
    })
    .sort((a, b) => b.items - a.items || a.key.localeCompare(b.key));
}

export interface ReviewerStats {
  reviewer: string;
  decided: number;
  approved: number;
  approvedWithEdits: number;
  rejected: number;
  revised: number;
  meanEditRatio: number | null;
  medianMinutesInReview: number | null;
}

export function reviewerStats(items: Item[]): ReviewerStats[] {
  const by = new Map<string, Item[]>();
  for (const i of items) {
    // The reviewer of the last decision is the one who made it.
    const last = [...i.history].reverse().find((h) => h.from === 'in_review' && h.by !== 'worker' && h.by !== 'router');
    if (!last) continue;
    by.set(last.by, [...(by.get(last.by) ?? []), i]);
  }
  return [...by.entries()]
    .map(([reviewer, is]) => {
      const outcomes = is.map(reviewOutcome);
      const edits = is.filter((i) => reviewOutcome(i) === 'approved' && i.draft && i.finalText && i.draft.trim() !== i.finalText.trim());
      const minutes = is
        .map(reviewSpan)
        .map((s) => (s ? elapsedMs(s.enteredAt, s.decidedAt) : null))
        .filter((x): x is number => x !== null)
        .map((ms) => ms / 60_000);
      return {
        reviewer,
        decided: outcomes.filter(Boolean).length,
        approved: outcomes.filter((o) => o === 'approved').length,
        approvedWithEdits: edits.length,
        rejected: outcomes.filter((o) => o === 'rejected').length,
        revised: outcomes.filter((o) => o === 'revised').length,
        meanEditRatio: round(mean(edits.map((i) => editStats(i.draft!, i.finalText!).editRatio))),
        medianMinutesInReview: round(percentile(minutes, 0.5), 1),
      };
    })
    .sort((a, b) => b.decided - a.decided || a.reviewer.localeCompare(b.reviewer));
}

export function findingCounts(items: Item[], limit = 15): { code: string; count: number; blocking: number }[] {
  const counts = new Map<string, { count: number; blocking: number }>();
  for (const i of items) {
    const seen = new Set<string>();
    for (const f of i.score?.findings ?? []) {
      if (seen.has(f.code)) continue;
      seen.add(f.code);
      const c = counts.get(f.code) ?? { count: 0, blocking: 0 };
      c.count++;
      if (f.severity === 'block') c.blocking++;
      counts.set(f.code, c);
    }
  }
  return [...counts.entries()]
    .map(([code, c]) => ({ code, ...c }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ service */

export interface MetricsOverview {
  total: number;
  published: number;
  inReview: number;
  autoApproved: number;
  failed: number;
  counts: Record<Status, number>;
  autoApprovePrecision: number | null;
  autoApprovePrecisionCi: { low: number; high: number } | null;
  qaSample: { sampled: number; decided: number; approved: number };
  review: {
    decided: number;
    approved: number;
    approvedWithEdits: number;
    rejected: number;
    revised: number;
    meanEditRatio: number | null;
    medianMinutesInReview: number | null;
    p90MinutesInReview: number | null;
    /** Drafts in review for longer than the SLA right now. */
    overdue: number;
    slaHours: number;
  };
  byCategory: GroupStats[];
  byLocale: GroupStats[];
  reviewers: ReviewerStats[];
  findings: { code: string; count: number; blocking: number }[];
  cost: { totalUsd: number; perPublishedUsd: number | null; today: Awaited<ReturnType<BudgetGuard['status']>> };
  policy: RoutingPolicy;
}

@Injectable()
export class MetricsService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BUDGET) private readonly budget: BudgetGuard,
    private readonly policies: PolicyService,
  ) {}

  /** Loads matching items into memory. Fine for the review team's scale; move to SQL aggregates past ~200k items. */
  private async load(filter: ItemFilter = {}): Promise<Item[]> {
    const out: Item[] = [];
    for await (const i of this.store.items.scan(filter)) out.push(i);
    return out;
  }

  async overview(filter: ItemFilter = {}): Promise<MetricsOverview> {
    const items = await this.load(filter);
    const policy = this.policies.current;
    const counts = emptyStatusCounts();
    for (const i of items) counts[i.status]++;

    // The QA sample: drafts that would have auto-approved but went to a reviewer instead.
    const sampled = items.filter((i) => wasSampled(i, policy));
    const sampledDecided = sampled.filter((i) => ['approved', 'rejected', 'published', 'queued', 'withdrawn'].includes(i.status) && reviewOutcome(i) !== null);
    const sampleApproved = sampledDecided.filter((i) => reviewOutcome(i) === 'approved').length;

    const outcomes = items.map((i) => ({ i, o: reviewOutcome(i) })).filter((x) => x.o !== null);
    const approvedItems = outcomes.filter((x) => x.o === 'approved').map((x) => x.i);
    const edited = approvedItems.filter((i) => i.draft && i.finalText && i.draft.trim() !== i.finalText.trim());
    const minutes = items
      .map(reviewSpan)
      .map((s) => (s ? elapsedMs(s.enteredAt, s.decidedAt) : null))
      .filter((x): x is number => x !== null)
      .map((ms) => ms / 60_000);
    const totalCost = items.reduce((a, i) => a + (i.usage?.costUsd ?? 0), 0);

    return {
      total: items.length,
      published: counts.published,
      inReview: counts.in_review,
      autoApproved: counts.auto_approved,
      failed: counts.failed,
      counts,
      autoApprovePrecision: sampledDecided.length ? sampleApproved / sampledDecided.length : null,
      autoApprovePrecisionCi: wilsonInterval(sampleApproved, sampledDecided.length),
      qaSample: { sampled: sampled.length, decided: sampledDecided.length, approved: sampleApproved },
      review: {
        decided: outcomes.length,
        approved: approvedItems.length,
        approvedWithEdits: edited.length,
        rejected: outcomes.filter((x) => x.o === 'rejected').length,
        revised: outcomes.filter((x) => x.o === 'revised').length,
        meanEditRatio: round(mean(edited.map((i) => editStats(i.draft!, i.finalText!).editRatio))),
        medianMinutesInReview: round(percentile(minutes, 0.5), 1),
        p90MinutesInReview: round(percentile(minutes, 0.9), 1),
        overdue: items.filter((i) => {
          if (i.status !== 'in_review') return false;
          const s = reviewSpan(i);
          return !!s && this.clock.now().getTime() - Date.parse(s.enteredAt) > this.config.reviewSlaMs;
        }).length,
        slaHours: Math.round((this.config.reviewSlaMs / 3_600_000) * 10) / 10,
      },
      byCategory: groupStats(items, (i) => i.brief.category),
      byLocale: groupStats(items, (i) => i.brief.locale),
      reviewers: reviewerStats(items),
      findings: findingCounts(items),
      cost: {
        totalUsd: Math.round(totalCost * 1e4) / 1e4,
        perPublishedUsd: counts.published ? Math.round((totalCost / counts.published) * 1e4) / 1e4 : null,
        today: await this.budget.status(),
      },
      policy,
    };
  }

  async calibration(target = 0.95, filter: ItemFilter = {}): Promise<{ current: number; rows: CalibrationRow[]; recommendation: { threshold: number | null; reason: string } }> {
    const items = await this.load(filter);
    const policy = this.policies.current;
    const rows = calibration(items, policy);
    return { current: policy.autoApproveAt, rows, recommendation: recommendThreshold(rows, target) };
  }

  /** Per-category thresholds currently in force, for the policy screen. */
  thresholds(categories: string[]): Record<string, number> {
    const policy = this.policies.current;
    return Object.fromEntries(categories.map((c) => [c, thresholdFor(policy, c)]));
  }

  async daily(days = 14): Promise<{ day: string; created: number; published: number; decided: number; costUsd: number }[]> {
    const n = Math.max(1, Math.min(90, Math.floor(days)));
    const today = utcDay(this.clock.now());
    const first = utcDay(new Date(this.clock.now().getTime() - (n - 1) * DAY));
    const rows = new Map(daysBetween(first, today).map((d) => [d, { day: d, created: 0, published: 0, decided: 0, costUsd: 0 }]));
    const items = await this.load({ createdAfter: `${first}T00:00:00.000Z` });
    for (const i of items) {
      const created = rows.get((i.createdAt ?? i.history[0].at).slice(0, 10));
      if (created) created.created++;
      for (const h of i.history) {
        const row = rows.get(h.at.slice(0, 10));
        if (!row) continue;
        if (h.to === 'published') row.published++;
        if (h.from === 'in_review' && (h.to === 'approved' || h.to === 'rejected' || h.to === 'queued')) row.decided++;
      }
    }
    for (const { day, usage } of await this.store.ledger.range(first, today)) {
      const row = rows.get(day);
      if (row) row.costUsd = usage.costUsd;
    }
    return [...rows.values()];
  }

  async experiments(): Promise<ExperimentReport> {
    return experimentReport(this.config.experiment, await this.load());
  }

  statuses(): readonly Status[] {
    return STATUSES;
  }
}
