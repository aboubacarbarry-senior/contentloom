import type {
  AuditEntry,
  BatchReport,
  BatchSummary,
  Brief,
  Calibration,
  Comment,
  CreateBatchResult,
  DailyRow,
  ExperimentReport,
  GlossaryTerm,
  Health,
  SkuOverview,
  SkuRow,
  WhoAmI,
  Item,
  ItemView,
  LintResult,
  Meta,
  MetricsOverview,
  OutboxMessage,
  Page,
  QueueEntry,
  RoutingPolicy,
} from './types';

/**
 * Typed client for the ContentLoom API. Requests go to /api/*, which next.config.js rewrites to the
 * API; the SSO proxy in front of this app injects x-user / x-roles on the way.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get conflict() {
    return this.status === 409;
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join('; ');
    if (m && typeof m === 'object' && typeof (m as { message?: unknown }).message === 'string') return (m as { message: string }).message;
  }
  return fallback;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const details = body && typeof body === 'object' ? ((body as { details?: Record<string, unknown> }).details ?? undefined) : undefined;
    throw new ApiError(messageOf(body, r.statusText || `HTTP ${r.status}`), r.status, details);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export const api = {
  meta: () => request<Meta>('/meta'),
  health: () => request<Health>('/health'),
  whoami: () => request<WhoAmI>('/whoami'),

  // review
  queue: (q?: string, limit = 100) => request<QueueEntry[]>(`/review/queue${qs({ q, limit })}`),
  claim: (query?: string, skip: string[] = []) => post<Item | undefined>('/review/claim', { query: query || undefined, skip: skip.length ? skip : undefined }),
  heartbeat: (id: string) => post<Item>(`/items/${id}/heartbeat`),
  release: (id: string) => post<Item>(`/items/${id}/release`),
  review: (id: string, decision: 'approve' | 'reject' | 'revise', opts: { editedText?: string; note?: string } = {}) =>
    post<Item>(`/items/${id}/review`, { decision, editedText: opts.editedText, note: opts.note || undefined }),
  lint: (id: string, text: string) => post<LintResult>(`/items/${id}/lint`, { text }),

  // items
  item: (id: string) => request<Item>(`/items/${id}`),
  view: (id: string) => request<ItemView>(`/items/${id}/view`),
  search: (q: string, cursor?: string | null, limit = 50) => request<Page<Item> & { query: string }>(`/items${qs({ q, cursor, limit })}`),
  publish: (id: string) => post<Item>(`/items/${id}/publish`),
  bulk: (action: 'publish' | 'regenerate' | 'reopen' | 'withdraw', ids: string[], reason?: string) =>
    post<{ action: string; done: { id: string; status: string }[]; failed: { id: string; error: string }[] }>('/items/bulk', { action, ids, reason: reason || undefined }),
  withdraw: (id: string, reason: string) => post<Item>(`/items/${id}/withdraw`, { reason }),
  reopen: (id: string, reason: string) => post<Item>(`/items/${id}/reopen`, { reason }),
  regenerate: (id: string, note?: string) => post<Item>(`/items/${id}/regenerate`, { note: note || undefined }),
  comments: (id: string) => request<Comment[]>(`/items/${id}/comments`),
  addComment: (id: string, body: string, anchor?: { start: number; end: number }) => post<Comment>(`/items/${id}/comments`, { body, ...(anchor ?? {}) }),
  resolveComment: (id: string, resolved: boolean) => patch<Comment>(`/comments/${id}`, { resolved }),

  // SKUs across locales
  skus: (prefix?: string) => request<SkuRow[]>(`/skus${qs({ prefix, limit: 200 })}`),
  sku: (sku: string) => request<SkuOverview>(`/skus/${encodeURIComponent(sku)}`),

  // batches
  batches: (cursor?: string | null, mine = false) => request<Page<BatchSummary>>(`/batches${qs({ cursor, mine: mine ? 1 : undefined, limit: 20 })}`),
  batch: (id: string) => request<BatchSummary>(`/batches/${id}`),
  batchReport: (id: string) => request<BatchReport>(`/batches/${id}/report`),
  batchItems: (id: string, q?: string, cursor?: string | null) => request<Page<Item>>(`/batches/${id}/items${qs({ q, cursor, limit: 100 })}`),
  createBatch: (briefs: Brief[], name?: string) => post<CreateBatchResult>('/batches', { briefs, name: name || undefined }),
  importCsv: (csv: string, name?: string) => post<CreateBatchResult>('/batches/csv', { csv, name: name || undefined }),
  cancelBatch: (id: string) => post<{ cancelled: number }>(`/batches/${id}/cancel`),
  retryFailed: (id: string) => post<{ requeued: number }>(`/batches/${id}/retry-failed`),
  publishBatch: (id: string) => post<{ published: string[]; skipped: { id: string; reason: string }[] }>(`/batches/${id}/publish`),

  // metrics
  metrics: () => request<MetricsOverview>('/metrics'),
  calibration: (target = 0.95) => request<Calibration>(`/metrics/calibration${qs({ target })}`),
  daily: (days = 14) => request<DailyRow[]>(`/metrics/daily${qs({ days })}`),
  experiments: () => request<ExperimentReport>('/metrics/experiments'),

  // glossary
  glossary: (locale?: string) => request<GlossaryTerm[]>(`/glossary${qs({ locale })}`),
  addTerm: (t: { locale: string; term: string; kind: GlossaryTerm['kind']; replacement?: string; note?: string; caseSensitive?: boolean }) => post<GlossaryTerm>('/glossary', t),
  importTerms: (terms: { locale: string; term: string; kind: GlossaryTerm['kind']; replacement?: string; note?: string }[]) =>
    post<{ added: number; skipped: number; errors: { row: number; message: string }[] }>('/glossary/import', { terms }),
  removeTerm: (id: string) => request<void>(`/glossary/${id}`, { method: 'DELETE' }),

  // admin
  policy: () => request<{ policy: RoutingPolicy; effectiveThresholds: Record<string, number> }>('/policy'),
  updatePolicy: (p: Partial<{ autoApproveAt: number; sampleRate: number; categoryThresholds: Record<string, number | null>; alwaysReview: string[] }>) =>
    patch<{ policy: RoutingPolicy; warnings: string[] }>('/policy', p),
  audit: (opts: { subject?: string; actor?: string; action?: string; cursor?: string | null } = {}) => request<Page<AuditEntry>>(`/audit${qs({ ...opts, limit: 50 })}`),
  outbox: (status?: string, cursor?: string | null) =>
    request<Page<OutboxMessage> & { counts: Record<'pending' | 'delivered' | 'dead', number> }>(`/outbox${qs({ status, cursor, limit: 50 })}`),
  retryOutbox: (id: string) => post<OutboxMessage>(`/outbox/${id}/retry`),
  sweep: () => post<{ requeued: number; failed: number; leasesExpired: number; outbox: Record<string, number> }>('/admin/sweep'),
  exportUrl: (kind: 'published' | 'reviews', params: Record<string, string | undefined>) => `/api/exports/${kind}${qs(params)}`,
};
