'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { BatchReportPanel } from '../../../components/BatchReport';
import { useToast } from '../../../components/Toasts';
import { ConfirmButton, ErrorBanner, Meter, Pager, ScoreBadge, Section, Spinner, Stat, StatusBadge, Tone } from '../../../components/ui';
import { api } from '../../../lib/api';
import { dateTime, int, pct, STATUS_LABEL, truncate, usd } from '../../../lib/format';
import { useAsync, useEvents } from '../../../lib/hooks';
import type { Item, Page, Status } from '../../../lib/types';
import { batchParts } from '../../../lib/batch';

const FILTERS: { label: string; q: string }[] = [
  { label: 'All', q: '' },
  { label: 'In review', q: 'status:in_review' },
  { label: 'Ready to publish', q: 'status:approved,auto_approved' },
  { label: 'Published', q: 'status:published' },
  { label: 'Failed', q: 'status:failed' },
  { label: 'Rejected', q: 'status:rejected' },
];

export default function BatchPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const toast = useToast();
  const summary = useAsync(() => api.batch(id), [id]);
  const [filter, setFilter] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [items, setItems] = useState<Page<Item> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const list = useAsync(async () => {
    const p = await api.batchItems(id, filter);
    setItems(p);
    return p;
  }, [id, filter]);

  useEvents(['item.status', 'batch.completed', 'batch.cancelled'], (e) => {
    if ('batchId' in e && e.batchId === id) {
      void summary.reload();
      if (e.type !== 'item.status') void list.reload();
    }
  });

  const s = summary.data;
  const ready = s ? s.counts.approved + s.counts.auto_approved : 0;
  const statusRows = useMemo(() => (s ? (Object.entries(s.counts) as [Status, number][]).filter(([, n]) => n > 0) : []), [s]);

  async function run<T>(label: string, fn: () => Promise<T>, describe: (r: T) => string) {
    try {
      const r = await fn();
      toast.info(`${label}: ${describe(r)}`);
      await Promise.all([summary.reload(), list.reload()]);
    } catch (e) {
      toast.error(e);
    }
  }

  async function more() {
    if (!items?.nextCursor) return;
    setLoadingMore(true);
    try {
      const p = await api.batchItems(id, filter, items.nextCursor);
      setItems({ ...p, items: [...items.items, ...p.items] });
    } finally {
      setLoadingMore(false);
    }
  }

  if (summary.error) return <ErrorBanner error={summary.error} onRetry={summary.reload} />;
  if (!s) return <Spinner label="Loading batch…" />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{s.batch.name}</h1>
            {s.batch.cancelledAt ? <Tone tone="muted">Cancelled</Tone> : s.done ? <Tone tone="ok">Done</Tone> : <Tone tone="info">Running</Tone>}
          </div>
          <div className="sub small">
            Created {dateTime(s.batch.createdAt)} by {s.batch.createdBy} from {s.batch.source === 'csv' ? 'a spreadsheet' : 'the API'}
            {s.batch.cancelledAt && ` · cancelled ${dateTime(s.batch.cancelledAt)} by ${s.batch.cancelledBy}`}
          </div>
        </div>
        <div className="row">
          <a className="btn" href={api.exportUrl('published', { batch: id })}>
            Export published
          </a>
          {ready > 0 && !s.batch.cancelledAt && (
            <ConfirmButton label={`Publish ${ready} ready`} confirmLabel="Publish all" onConfirm={() => run('Publish', () => api.publishBatch(id), (r) => `${r.published.length} published${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`)} />
          )}
          {s.counts.failed > 0 && !s.batch.cancelledAt && (
            <button className="btn" onClick={() => void run('Retry', () => api.retryFailed(id), (r) => `${r.requeued} queued again`)}>
              Retry {s.counts.failed} failed
            </button>
          )}
          {!s.batch.cancelledAt && !s.done && <ConfirmButton label="Cancel batch" danger confirmLabel="Cancel everything unpublished" onConfirm={() => run('Cancel', () => api.cancelBatch(id), (r) => `${r.cancelled} items cancelled`)} />}
        </div>
      </div>

      <div className="grid-4">
        <Stat label="Items" value={int(s.total)} hint={Object.entries(s.locales).map(([l, n]) => `${l} ${n}`).join(' · ')} />
        <Stat label="Waiting for review" value={int(s.counts.in_review)} tone={s.counts.in_review ? 'wait' : undefined} />
        <Stat label="Mean score" value={s.meanScore === null ? '—' : s.meanScore.toFixed(2)} hint={`${pct(s.generated)} generated`} />
        <Stat label="Model cost" value={usd(s.costUsd)} hint={s.counts.published ? `${usd(s.costUsd / s.counts.published)} per published item` : undefined} />
      </div>

      <Section title="Progress">
        <Meter parts={batchParts(s)} total={s.total} />
        <div className="row small" style={{ marginTop: 8 }}>
          {statusRows.map(([st, n]) => (
            <a key={st} href="#" onClick={(e) => (e.preventDefault(), setFilter(`status:${st}`))}>
              <StatusBadge status={st} /> {n}
            </a>
          ))}
        </div>
      </Section>

      <div className="row">
        <button className="btn small" onClick={() => setShowReport((v) => !v)}>
          {showReport ? 'Hide report' : 'What went wrong?'}
        </button>
      </div>
      {showReport && <BatchReportPanel batchId={id} />}

      <div className="row">
        {FILTERS.map((f) => (
          <button key={f.label} className={`btn small ${filter === f.q ? 'primary' : ''}`} onClick={() => setFilter(f.q)}>
            {f.label}
          </button>
        ))}
        {filter && !FILTERS.some((f) => f.q === filter) && <Tone tone="info">{STATUS_LABEL[filter.replace('status:', '') as Status] ?? filter}</Tone>}
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} />
      {items && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Locale</th>
                <th>Status</th>
                <th className="num">Score</th>
                <th>Copy</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {items.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/items/${i.id}`}>{i.brief.sku}</Link>
                  </td>
                  <td>{i.brief.locale}</td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="num">
                    <ScoreBadge value={i.score?.total} threshold={i.routing?.threshold} />
                  </td>
                  <td className="small" style={{ maxWidth: 460 }}>
                    {i.status === 'failed' ? <span style={{ color: 'var(--bad)' }}>{i.lastError}</span> : truncate(i.finalText ?? i.draft ?? '', 140)}
                  </td>
                  <td className="small">{i.reviewer ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
              {items.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No items in this view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pager hasMore={!!items.nextCursor} loading={loadingMore} onMore={() => void more()} shown={items.items.length} total={items.total} />
        </div>
      )}
    </div>
  );
}
