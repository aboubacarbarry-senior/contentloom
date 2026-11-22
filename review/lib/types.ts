/** Shapes returned by the ContentLoom API. Kept by hand in step with api/src (domain.ts, repository.ts). */

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

export type Locale = 'en-US' | 'es-US' | 'fr-CA';
export type Severity = 'block' | 'warn' | 'info';

export interface Brief {
  sku: string;
  locale: Locale;
  facts: Record<string, string>;
  mustMention: string[];
  banned: string[];
  category: string;
  title?: string;
  brand?: string;
  keywords?: string[];
}

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
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
  version?: number;
  variant?: string | null;
  usage?: Usage;
  lease?: { reviewer: string; expiresAt: string } | null;
  routing?: { decision: 'auto_approved' | 'in_review'; reasons: string[]; sampled: boolean; threshold: number } | null;
  revisions?: Revision[];
  publishedAt?: string | null;
  lastError?: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
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

export interface BatchSummary {
  batch: Batch;
  counts: Record<Status, number>;
  total: number;
  generated: number;
  settled: number;
  done: boolean;
  costUsd: number;
  meanScore: number | null;
  locales: Partial<Record<Locale, number>>;
  categories: Record<string, number>;
}

export interface CreateBatchResult {
  batchId: string;
  itemIds: string[];
  warnings: { index: number; sku: string; locale: string; message: string }[];
  estimatedCostUsd: number;
}

export interface QueueEntry {
  item: Item;
  reasons: string[];
  openComments: number;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  overdue: boolean;
  enteredAt: string | null;
}

export type DiffOp = { op: 'equal' | 'insert' | 'delete'; text: string };

export interface Comment {
  id: string;
  itemId: string;
  author: string;
  body: string;
  at: string;
  start: number | null;
  end: number | null;
  resolved: boolean;
}

export interface ItemView {
  item: Item;
  reasons: string[];
  comments: Comment[];
  diff: DiffOp[] | null;
  edits: { wordsBefore: number; wordsAfter: number; wordsInserted: number; wordsDeleted: number; editRatio: number } | null;
  revisionDiff: DiffOp[] | null;
}

export interface LintResult {
  findings: Finding[];
  fixed: string;
  blocking: number;
}

export interface GlossaryTerm {
  id: string;
  locale: Locale | '*';
  term: string;
  kind: 'forbidden' | 'preferred' | 'keep';
  replacement: string | null;
  note: string | null;
  caseSensitive: boolean;
  createdBy: string;
  createdAt: string;
}

export interface GroupStats {
  key: string;
  items: number;
  inReview: number;
  autoApproved: number;
  published: number;
  failed: number;
  meanScore: number | null;
  approvalRate: number | null;
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

export interface RoutingPolicy {
  autoApproveAt: number;
  sampleRate: number;
  categoryThresholds?: Record<string, number>;
  alwaysReview?: string[];
}

export interface BudgetStatus {
  day: string;
  spentUsd: number;
  limitUsd: number | null;
  remainingUsd: number | null;
}

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
    overdue: number;
    slaHours: number;
  };
  byCategory: GroupStats[];
  byLocale: GroupStats[];
  reviewers: ReviewerStats[];
  findings: { code: string; count: number; blocking: number }[];
  cost: { totalUsd: number; perPublishedUsd: number | null; today: BudgetStatus };
  policy: RoutingPolicy;
}

export interface CalibrationRow {
  threshold: number;
  n: number;
  approved: number;
  precision: number | null;
  ci: { low: number; high: number } | null;
  coverage: number | null;
}

export interface Calibration {
  current: number;
  rows: CalibrationRow[];
  recommendation: { threshold: number | null; reason: string };
}

export interface DailyRow {
  day: string;
  created: number;
  published: number;
  decided: number;
  costUsd: number;
}

export interface ExperimentReport {
  experimentId: string | null;
  arms: {
    variant: string;
    items: number;
    reviewed: number;
    approvedClean: number;
    approvedEdited: number;
    rejected: number;
    revised: number;
    autoApproved: number;
    meanScore: number | null;
    meanEditRatio: number | null;
    costUsd: number;
    cleanApprovalRate: number | null;
  }[];
  comparisons: { variant: string; lift: number | null; z: number | null; p: number | null; significant: boolean }[];
  note: string;
}

export interface OutboxMessage {
  id: string;
  event: string;
  target: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: 'pending' | 'delivered' | 'dead';
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastStatus: number | null;
  deliveredAt: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
}

export interface Meta {
  statuses: Status[];
  locales: { id: Locale; name: string }[];
  categories: { id: string; label: string; regulated: boolean; words: [number, number]; requiredFacts: string[] }[];
  checks: { id: string; description: string }[];
  variants: { id: string; label: string; description: string }[];
  promptVersion: string;
  model: string;
}

export interface Health {
  ok: boolean;
  store: { ok: boolean; detail?: string };
  queue: { waiting: number; delayed: number; active: number; failed: number } | null;
  budget: BudgetStatus;
  model: string;
  promptVersion: string;
}

export type AppEvent =
  | { type: 'item.status'; itemId: string; batchId: string; from: Status | null; to: Status; by: string; at: string }
  | { type: 'item.leased'; itemId: string; reviewer: string; expiresAt: string; at: string }
  | { type: 'item.released'; itemId: string; reviewer: string; at: string }
  | { type: 'item.comment'; itemId: string; commentId: string; author: string; at: string }
  | { type: 'batch.created'; batchId: string; itemCount: number; by: string; at: string }
  | { type: 'batch.completed'; batchId: string; at: string }
  | { type: 'batch.cancelled'; batchId: string; by: string; cancelled: number; at: string }
  | { type: 'review.overdue'; itemId: string; batchId: string; sku: string; enteredAt: string; at: string }
  | { type: 'budget.exceeded'; spentUsd: number; limitUsd: number; at: string }
  | { type: 'outbox.dead'; messageId: string; event: string; target: string; at: string };

export interface LocaleVersion {
  locale: Locale;
  itemId: string;
  status: Status;
  text: string | null;
  source: 'final' | 'draft' | 'none';
  score: number | null;
  updatedAt: string | null;
}

export interface ConsistencyIssue {
  kind: 'copy-measurement' | 'fact-measurement' | 'missing-locale' | 'status-gap';
  severity: Severity;
  locales: Locale[];
  message: string;
}

export interface SkuOverview {
  sku: string;
  versions: LocaleVersion[];
  issues: ConsistencyIssue[];
}

export interface SkuRow {
  sku: string;
  locales: Locale[];
  statuses: Partial<Record<Locale, Status>>;
  issues: number;
  blocking: number;
}

export interface BatchReport {
  batchId: string;
  findings: { code: string; items: number; blocking: number }[];
  reasons: { reason: string; items: number }[];
  locales: { locale: Locale; items: number; autoApproved: number; reviewed: number; approved: number; published: number; failed: number }[];
  edits: { approved: number; edited: number; meanEditRatio: number | null };
  errors: { message: string; items: number }[];
}

export interface WhoAmI {
  user: string | null;
  roles: ('editor' | 'reviewer' | 'publisher' | 'admin')[];
}
