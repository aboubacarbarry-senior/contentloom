// Content item lifecycle:
//   queued → generating → scored → (auto_approved | in_review) → approved/rejected → published → withdrawn
// Low-risk, high-scoring drafts skip review; everything else waits for a human.
// Cancelling a batch moves every item that has not been published to `cancelled`.

export type Status =
  | 'queued'
  | 'generating'
  | 'scored'
  | 'in_review'
  | 'auto_approved'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'withdrawn'
  | 'failed'
  | 'cancelled';

export const STATUSES: readonly Status[] = [
  'queued',
  'generating',
  'scored',
  'in_review',
  'auto_approved',
  'approved',
  'rejected',
  'published',
  'withdrawn',
  'failed',
  'cancelled',
];

/** Statuses an item never leaves on its own; the batch counts as done once every item is in one of them. */
export const SETTLED: ReadonlySet<Status> = new Set<Status>(['published', 'rejected', 'failed', 'cancelled', 'withdrawn']);

export type Locale = 'en-US' | 'es-US' | 'fr-CA';
export const LOCALES: readonly Locale[] = ['en-US', 'es-US', 'fr-CA'];

export interface Brief {
  sku: string;
  locale: Locale;
  facts: Record<string, string>;
  mustMention: string[];
  banned: string[];
  category: string;
  /** Optional product title shown to the writer as the name to use. */
  title?: string;
  brand?: string;
  /** Search keywords the copy should work in naturally (never stuffed). */
  keywords?: string[];
}

export type Severity = 'block' | 'warn' | 'info';

/** One result of a deterministic check. `block` findings always send a draft to a human. */
export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Character offsets into the draft, for highlighting in the review app. */
  start?: number;
  end?: number;
  suggestion?: string;
}

export interface Verdict {
  rationale: string;
  accuracy: number;
  usefulness: number;
  tone: number;
}

export interface Score {
  facts: number;
  claims: number;
  length: number;
  judge: number | null;
  total: number;
  notes: string[];
  findings?: Finding[];
  readability?: number | null;
  verdict?: Verdict | null;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: Usage = Object.freeze({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

export interface HistoryEntry {
  at: string;
  from: Status | null;
  to: Status;
  by: string;
  note?: string;
}

export interface Revision {
  at: string;
  text: string;
  source: 'model' | 'reviewer';
  note: string | null;
}

export interface Lease {
  reviewer: string;
  expiresAt: string;
}

export interface RoutingRecord {
  decision: 'auto_approved' | 'in_review';
  reasons: string[];
  /** True when the draft would have auto-approved but landed in the QA sample. */
  sampled: boolean;
  threshold: number;
}

export interface Item {
  id: string;
  batchId: string;
  brief: Brief;
  status: Status;
  draft: string | null;
  finalText: string | null;
  score: Score | null;
  attempts: number;
  reviewer: string | null;
  reviewNote: string | null;
  history: HistoryEntry[];
  createdAt?: string;
  updatedAt?: string;
  /** Optimistic-concurrency counter, bumped on every save. */
  version?: number;
  /** Prompt variant (experiment arm) the draft was generated with. */
  variant?: string | null;
  usage?: Usage;
  lease?: Lease | null;
  routing?: RoutingRecord | null;
  revisions?: Revision[];
  publishedAt?: string | null;
  lastError?: string | null;
}

export interface Batch {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  itemCount: number;
  source: 'api' | 'csv';
  cancelledAt: string | null;
  cancelledBy: string | null;
}

const NEXT: Record<Status, Status[]> = {
  queued: ['generating', 'failed', 'cancelled'],
  generating: ['scored', 'queued', 'failed', 'cancelled'],
  scored: ['auto_approved', 'in_review'],
  in_review: ['approved', 'rejected', 'queued', 'cancelled'],
  auto_approved: ['published', 'in_review', 'cancelled'],
  approved: ['published', 'in_review', 'cancelled'],
  rejected: ['queued', 'cancelled'],
  published: ['withdrawn'],
  withdrawn: ['queued'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export function nextStatuses(from: Status): readonly Status[] {
  return NEXT[from];
}

export function transition(item: Item, to: Status, by: string, now = new Date(), note?: string): Item {
  if (!NEXT[item.status].includes(to)) throw new Error(`${item.id}: ${item.status} → ${to} not allowed`);
  const entry: HistoryEntry = { at: now.toISOString(), from: item.status, to, by };
  if (note) entry.note = note;
  item.history.push(entry);
  item.status = to;
  item.updatedAt = entry.at;
  return item;
}

/** Categories where a human always reviews (regulated or high-return-rate). */
export const ALWAYS_REVIEW = new Set(['baby', 'supplements', 'electrical']);

export interface RoutingPolicy {
  autoApproveAt: number;
  sampleRate: number;
  /** Per-category overrides of the auto-approve threshold, e.g. `{ furniture: 0.9 }`. */
  categoryThresholds?: Record<string, number>;
  /** Extra categories that always go to review, on top of ALWAYS_REVIEW. */
  alwaysReview?: string[];
}

export function thresholdFor(policy: RoutingPolicy, category: string): number {
  return policy.categoryThresholds?.[category] ?? policy.autoApproveAt;
}

/**
 * Explain a routing decision. The reasons list is empty when the draft is eligible for auto-approval;
 * the QA sample is decided separately so callers can record it.
 */
export function reviewReasons(item: Item, policy: RoutingPolicy): string[] {
  const s = item.score;
  if (!s) return ['not scored'];
  const reasons: string[] = [];
  const category = item.brief.category;
  if (ALWAYS_REVIEW.has(category) || policy.alwaysReview?.includes(category)) reasons.push(`regulated category "${category}"`);
  if (s.facts < 1) reasons.push('required facts missing');
  if (s.claims < 1) reasons.push('banned claim present');
  if (s.judge === null) reasons.push('judge gave no verdict');
  const threshold = thresholdFor(policy, category);
  if (s.total < threshold) reasons.push(`score ${s.total.toFixed(3)} below ${threshold}`);
  // Missing facts and banned claims are already covered by the score components above.
  for (const f of s.findings ?? []) {
    if (f.severity === 'block' && f.code !== 'fact.missing' && f.code !== 'claim.banned') reasons.push(`${f.code}: ${f.message}`);
  }
  return reasons;
}

/**
 * Route a scored draft. `rand` makes the QA sample deterministic in tests: a fraction of auto-approvable
 * drafts still goes to review, so reviewers keep measuring the auto-approve precision.
 */
export function route(item: Item, policy: RoutingPolicy, rand: () => number): 'auto_approved' | 'in_review' {
  return decideRoute(item, policy, rand).decision;
}

export function decideRoute(item: Item, policy: RoutingPolicy, rand: () => number): RoutingRecord {
  const reasons = reviewReasons(item, policy);
  const threshold = thresholdFor(policy, item.brief.category);
  if (reasons.length) return { decision: 'in_review', reasons, sampled: false, threshold };
  if (rand() < policy.sampleRate) return { decision: 'in_review', reasons: ['QA sample'], sampled: true, threshold };
  return { decision: 'auto_approved', reasons: [], sampled: false, threshold };
}

/** Was this item sent to review only because of the QA sample? Falls back to history for older records. */
export function wasSampled(item: Item, policy: RoutingPolicy): boolean {
  if (item.routing) return item.routing.sampled;
  const s = item.score;
  return (
    !!s &&
    item.history.some((h) => h.by === 'router' && h.to === 'in_review') &&
    s.total >= thresholdFor(policy, item.brief.category) &&
    s.claims === 1 &&
    s.facts === 1
  );
}

/** The reviewer's final call on an item, if any, read from its history. */
export function reviewOutcome(item: Item): 'approved' | 'rejected' | 'revised' | null {
  for (let i = item.history.length - 1; i >= 0; i--) {
    const h = item.history[i];
    if (h.from !== 'in_review') continue;
    if (h.to === 'approved') return 'approved';
    if (h.to === 'rejected') return 'rejected';
    if (h.to === 'queued') return 'revised';
  }
  return null;
}

/** When the item last entered review, and when a reviewer decided. Used for time-in-review metrics. */
export function reviewSpan(item: Item): { enteredAt: string; decidedAt: string | null } | null {
  let entered: string | null = null;
  let decided: string | null = null;
  for (const h of item.history) {
    if (h.to === 'in_review') {
      entered = h.at;
      decided = null;
    } else if (h.from === 'in_review' && entered) {
      decided = h.at;
    }
  }
  return entered ? { enteredAt: entered, decidedAt: decided } : null;
}

export function newItem(id: string, batchId: string, brief: Brief, now: Date, variant: string | null = null): Item {
  const at = now.toISOString();
  return {
    id,
    batchId,
    brief,
    status: 'queued',
    draft: null,
    finalText: null,
    score: null,
    attempts: 0,
    reviewer: null,
    reviewNote: null,
    history: [{ at, from: null, to: 'queued', by: 'system' }],
    createdAt: at,
    updatedAt: at,
    version: 0,
    variant,
    usage: { ...EMPTY_USAGE },
    lease: null,
    routing: null,
    revisions: [],
    publishedAt: null,
    lastError: null,
  };
}

/** Fill fields that older stored items may lack, so the rest of the code can rely on them. */
export function normalizeItem(item: Item): Required<Item> {
  const createdAt = item.createdAt ?? item.history[0]?.at ?? new Date(0).toISOString();
  return {
    ...item,
    createdAt,
    updatedAt: item.updatedAt ?? item.history.at(-1)?.at ?? createdAt,
    version: item.version ?? 0,
    variant: item.variant ?? null,
    usage: item.usage ?? { ...EMPTY_USAGE },
    lease: item.lease ?? null,
    routing: item.routing ?? null,
    revisions: item.revisions ?? [],
    publishedAt: item.publishedAt ?? null,
    lastError: item.lastError ?? null,
  };
}

export function leaseActive(item: Item, now: Date): boolean {
  return !!item.lease && Date.parse(item.lease.expiresAt) > now.getTime();
}
