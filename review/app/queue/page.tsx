'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { EmptyState, ErrorBanner, ScoreBadge, Spinner, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { ago, truncate } from '../../lib/format';
import { useAsync, useEvents, useNow, useQueryParam } from '../../lib/hooks';
import type { QueueEntry } from '../../lib/types';

type SortKey = 'score' | 'age' | 'sku';

function reasonTone(r: string): 'bad' | 'wait' | 'info' {
  if (r === 'QA sample') return 'info';
  if (r.startsWith('score ')) return 'wait';
  return 'bad';
}

/** Everything waiting for a reviewer, with the reasons and who is working on what right now. */
export default function QueuePage() {
  const [q, setQ] = useQueryParam('q');
  const [draft, setDraft] = useState(q);
  const [sort, setSort] = useState<SortKey>('score');
  const [onlyFree, setOnlyFree] = useState(false);
  const now = useNow(15_000);
  const queue = useAsync(() => api.queue(q, 500), [q]);

  // Live: leases and status changes update the list without a reload.
  useEvents(['item.leased', 'item.released', 'item.status'], (e) => {
    if (e.type === 'item.status') {
      if (e.to === 'in_review' || e.from === 'in_review') void queue.reload();
      return;
    }
    if (e.type !== 'item.leased' && e.type !== 'item.released') return;
    queue.setData((prev) =>
      prev
        ? prev.map((entry) =>
            entry.item.id !== e.itemId
              ? entry
              : e.type === 'item.leased'
                ? { ...entry, leasedBy: e.reviewer, leaseExpiresAt: e.expiresAt }
                : { ...entry, leasedBy: null, leaseExpiresAt: null },
          )
        : prev,
    );
  });

  const rows = useMemo(() => {
    const list = (queue.data ?? []).filter((e) => !onlyFree || !e.leasedBy || (e.leaseExpiresAt && Date.parse(e.leaseExpiresAt) < now));
    const enteredAt = (e: QueueEntry) => e.item.history.filter((h) => h.to === 'in_review').at(-1)?.at ?? '';
    return list.slice().sort((a, b) => {
      if (sort === 'age') return enteredAt(a).localeCompare(enteredAt(b));
      if (sort === 'sku') return a.item.brief.sku.localeCompare(b.item.brief.sku);
      return (a.item.score?.total ?? 0) - (b.item.score?.total ?? 0);
    });
  }, [queue.data, onlyFree, sort, now]);

  const reasonCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of queue.data ?? []) for (const r of e.reasons) {
      const k = r.startsWith('score ') ? 'low score' : r.split(':')[0];
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [queue.data]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Review queue</h1>
          <div className="sub">
            {queue.data ? `${queue.data.length} drafts waiting` : ' '}
            {queue.data && queue.data.some((e) => e.overdue) ? ` · ${queue.data.filter((e) => e.overdue).length} overdue` : ''}
          </div>
        </div>
        <Link className="btn primary" href="/">
          Start reviewing
        </Link>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input type="search" className="grow" placeholder="Filter: category:baby locale:fr-CA score<0.7 finding:units" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Filter" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="score">Worst score first</option>
          <option value="age">Waiting longest</option>
          <option value="sku">SKU</option>
        </select>
        <label className="row small">
          <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> Only unclaimed
        </label>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      {reasonCounts.length > 0 && (
        <div className="row small">
          <span className="muted">Why drafts are here:</span>
          {reasonCounts.map(([r, n]) => (
            <span key={r} className={`badge tone-${reasonTone(r === 'low score' ? 'score ' : r)}`}>
              {r} · {n}
            </span>
          ))}
        </div>
      )}

      <ErrorBanner error={queue.error} onRetry={queue.reload} />
      {queue.loading && !queue.data && <Spinner label="Loading the queue…" />}

      {queue.data && rows.length === 0 && (
        <div className="card">
          <EmptyState icon="✓" title={q ? 'No drafts match this filter' : 'The queue is empty'} />
        </div>
      )}

      {rows.length > 0 && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Locale</th>
                <th>Category</th>
                <th className="num">Score</th>
                <th>Reasons</th>
                <th>Draft</th>
                <th>Waiting</th>
                <th>Held by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const held = e.leasedBy && e.leaseExpiresAt && Date.parse(e.leaseExpiresAt) > now;
                return (
                  <tr key={e.item.id}>
                    <td>
                      <Link href={`/items/${e.item.id}`}>{e.item.brief.sku}</Link>
                      {e.openComments > 0 && (
                        <span className="badge tone-info" style={{ marginLeft: 6 }} title="Open comments">
                          💬 {e.openComments}
                        </span>
                      )}
                    </td>
                    <td>{e.item.brief.locale}</td>
                    <td>{e.item.brief.category}</td>
                    <td className="num">
                      <ScoreBadge value={e.item.score?.total} threshold={e.item.routing?.threshold} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {e.reasons.slice(0, 3).map((r) => (
                          <Tone key={r} tone={reasonTone(r)} title={r}>
                            {truncate(r, 32)}
                          </Tone>
                        ))}
                        {e.reasons.length > 3 && <span className="muted small">+{e.reasons.length - 3}</span>}
                      </div>
                    </td>
                    <td className="small" style={{ maxWidth: 320 }}>
                      {truncate(e.item.draft ?? '', 110)}
                    </td>
                    <td className="small muted">
                      {ago(e.enteredAt, now)}
                      {e.overdue && (
                        <span className="badge tone-bad" style={{ marginLeft: 6 }} title="Waiting longer than the review SLA">
                          overdue
                        </span>
                      )}
                    </td>
                    <td className="small">{held ? <Tone tone="wait">{e.leasedBy}</Tone> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
