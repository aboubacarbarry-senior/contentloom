import type { BatchSummary } from './types';

/** The progress bar splits a batch by where its items are: done, waiting on people, in the pipeline, failed. */
export function batchParts(s: BatchSummary) {
  const c = s.counts;
  return [
    { value: c.published, tone: 'ok' as const, label: 'published' },
    { value: c.approved + c.auto_approved, tone: 'info' as const, label: 'approved' },
    { value: c.in_review, tone: 'wait' as const, label: 'in review' },
    { value: c.queued + c.generating + c.scored, tone: 'muted' as const, label: 'in the pipeline' },
    { value: c.failed + c.rejected, tone: 'bad' as const, label: 'failed or rejected' },
  ];
}
