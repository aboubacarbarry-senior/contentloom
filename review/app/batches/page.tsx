'use client';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, ErrorBanner, Meter, Pager, Spinner, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { ago, pct, usd } from '../../lib/format';
import { useAsync, useEvents } from '../../lib/hooks';
import { batchParts } from '../../lib/batch';
import type { BatchSummary, Page } from '../../lib/types';

export default function BatchesPage() {
  const [mine, setMine] = useState(false);
  const [pages, setPages] = useState<Page<BatchSummary> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useAsync(async () => {
    const p = await api.batches(null, mine);
    setPages(p);
    return p;
  }, [mine]);

  useEvents(['batch.created', 'batch.completed', 'batch.cancelled'], () => void first.reload());

  async function more() {
    if (!pages?.nextCursor) return;
    setLoadingMore(true);
    try {
      const p = await api.batches(pages.nextCursor, mine);
      setPages({ ...p, items: [...pages.items, ...p.items] });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Batches</h1>
          <div className="sub">Each upload of briefs becomes a batch. Open one to follow it through review and publishing.</div>
        </div>
        <div className="row">
          <label className="row small">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
          </label>
          <Link className="btn primary" href="/batches/new">
            New batch
          </Link>
        </div>
      </div>
      <ErrorBanner error={first.error} onRetry={first.reload} />
      {first.loading && !pages && <Spinner label="Loading batches…" />}
      {pages && pages.items.length === 0 && (
        <div className="card">
          <EmptyState title="No batches yet">
            <p>
              <Link href="/batches/new">Upload a spreadsheet of briefs</Link> to start.
            </p>
          </EmptyState>
        </div>
      )}
      {pages && pages.items.length > 0 && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th className="num">Items</th>
                <th style={{ width: '28%' }}>Progress</th>
                <th className="num">Mean score</th>
                <th className="num">Cost</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {pages.items.map((s) => (
                <tr key={s.batch.id}>
                  <td>
                    <Link href={`/batches/${s.batch.id}`}>{s.batch.name}</Link>
                    <div className="small muted">
                      {Object.entries(s.locales)
                        .map(([l, n]) => `${l} ${n}`)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className="small">
                    {ago(s.batch.createdAt)}
                    <div className="muted">by {s.batch.createdBy}</div>
                  </td>
                  <td className="num">{s.total}</td>
                  <td>
                    <Meter parts={batchParts(s)} total={s.total} />
                    <div className="small muted" style={{ marginTop: 4 }}>
                      {pct(s.generated)} generated · {pct(s.settled)} settled
                    </div>
                  </td>
                  <td className="num">{s.meanScore === null ? '—' : s.meanScore.toFixed(2)}</td>
                  <td className="num">{usd(s.costUsd)}</td>
                  <td>
                    {s.batch.cancelledAt ? (
                      <Tone tone="muted">Cancelled</Tone>
                    ) : s.done ? (
                      <Tone tone="ok">Done</Tone>
                    ) : s.counts.in_review > 0 ? (
                      <Tone tone="wait">{s.counts.in_review} to review</Tone>
                    ) : (
                      <Tone tone="info">Running</Tone>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager hasMore={!!pages.nextCursor} loading={loadingMore} onMore={() => void more()} shown={pages.items.length} total={pages.total} />
        </div>
      )}
    </div>
  );
}
