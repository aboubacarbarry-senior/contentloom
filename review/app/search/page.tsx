'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BulkBar } from '../../components/BulkBar';
import { EmptyState, ErrorBanner, Pager, ScoreBadge, Spinner, StatusBadge } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { ago, truncate } from '../../lib/format';
import { useQueryParam, useStoredState } from '../../lib/hooks';
import type { Item } from '../../lib/types';

const EXAMPLES = [
  { q: 'status:in_review category:baby', label: 'Baby products waiting for review' },
  { q: 'finding:units status:in_review', label: 'Size or weight mismatches' },
  { q: 'finding:claim. -status:cancelled', label: 'Any unsupported claim' },
  { q: 'status:published locale:fr-CA created>2026-01-01', label: 'French copy published this year' },
  { q: 'status:failed', label: 'Failed generations' },
  { q: 'sampled:yes', label: 'QA sample' },
  { q: '"pre-washed"', label: 'Text search' },
];

const FILTERS: [string, string][] = [
  ['status:', 'queued, generating, in_review, auto_approved, approved, rejected, published, withdrawn, failed, cancelled (prefix with - to exclude)'],
  ['category:', 'one or more categories, comma-separated'],
  ['locale:', 'en-US, es-US, fr-CA'],
  ['sku:', 'exact SKU, or a prefix ending in *'],
  ['score<0.7', 'also >, <=, >= and score:0.9'],
  ['finding:', 'a finding code (units.mismatch) or prefix (claim.)'],
  ['reviewer:', 'who decided'],
  ['variant:', 'prompt experiment arm'],
  ['sampled:', 'yes or no'],
  ['created>', 'a date (YYYY-MM-DD) or timestamp'],
  ['sort:', 'score_asc, score_desc, created_asc, created_desc, updated_desc, sku_asc'],
];

export default function SearchPage() {
  const [q, setQ] = useQueryParam('q');
  const [draft, setDraft] = useState(q);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [normalized, setNormalized] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useStoredState<{ name: string; q: string }[]>('contentloom.savedSearches', []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function saveCurrent() {
    const name = window.prompt('Name this search', normalized || q);
    if (!name?.trim()) return;
    setSaved([...saved.filter((x) => x.name !== name.trim()), { name: name.trim(), q }].slice(-20));
  }

  useEffect(() => setDraft(q), [q]);

  async function run(query: string, more = false) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.search(query, more ? cursor : null);
      setItems((prev) => (more ? [...prev, ...page.items] : page.items));
      setTotal(page.total);
      setCursor(page.nextCursor);
      setNormalized(page.query);
      setSearched(true);
      if (!more) setSelected(new Set());
    } catch (e) {
      setError(e as Error);
      if (!more) setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (q) void run(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const position = error instanceof ApiError ? (error.details?.position as number | undefined) : undefined;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <div className="sub">Find items by status, category, locale, score, findings or text.</div>
        </div>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
          if (draft.trim() === q) void run(draft.trim());
        }}
      >
        <input type="search" className="grow mono" autoFocus placeholder='status:in_review locale:fr-CA "pre-washed"' value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Query" />
        <button className="btn primary" type="submit" disabled={loading}>
          Search
        </button>
      </form>

      {saved.length > 0 && (
        <div className="row small">
          <span className="muted">Saved:</span>
          {saved.map((x) => (
            <span key={x.name} className="badge tone-info">
              <a href="#" onClick={(e) => (e.preventDefault(), setQ(x.q))} title={x.q}>
                {x.name}
              </a>
              <button className="btn small ghost" style={{ padding: 0, marginLeft: 4 }} aria-label={`Forget ${x.name}`} onClick={() => setSaved(saved.filter((y) => y.name !== x.name))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="stack" style={{ gap: 4 }}>
          <ErrorBanner error={error} />
          {position !== undefined && (
            <code className="small">
              {draft}
              <br />
              {' '.repeat(position)}^
            </code>
          )}
        </div>
      )}

      {!searched && !loading && (
        <div className="grid-2">
          <section className="card">
            <h2>Try</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {EXAMPLES.map((ex) => (
                <li key={ex.q}>
                  <a href="#" onClick={(e) => (e.preventDefault(), setQ(ex.q))}>
                    {ex.label}
                  </a>{' '}
                  <code className="muted">{ex.q}</code>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Filters</h2>
            <table className="table compact">
              <tbody>
                {FILTERS.map(([k, d]) => (
                  <tr key={k}>
                    <td>
                      <code>{k}</code>
                    </td>
                    <td className="small">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {loading && !items.length && <Spinner label="Searching…" />}

      {searched && !error && <BulkBar selected={items.filter((i) => selected.has(i.id))} onDone={() => void run(q)} onClear={() => setSelected(new Set())} />}

      {searched && !error && (
        <div className="card flush">
          <div style={{ padding: '10px 12px' }} className="small muted">
            {total.toLocaleString()} result{total === 1 ? '' : 's'} for <code>{normalized || '(everything)'}</code>
            {q && (
              <button className="btn small ghost" onClick={saveCurrent} style={{ marginLeft: 8 }}>
                Save search
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <EmptyState title="No items match" />
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all shown"
                        checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                      />
                    </th>
                    <th>SKU</th>
                    <th>Status</th>
                    <th>Locale</th>
                    <th>Category</th>
                    <th className="num">Score</th>
                    <th>Text</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${i.brief.sku} ${i.brief.locale}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                      </td>
                      <td>
                        <Link href={`/items/${i.id}`}>{i.brief.sku}</Link>
                      </td>
                      <td>
                        <StatusBadge status={i.status} />
                      </td>
                      <td>{i.brief.locale}</td>
                      <td>{i.brief.category}</td>
                      <td className="num">
                        <ScoreBadge value={i.score?.total} />
                      </td>
                      <td className="small" style={{ maxWidth: 380 }}>
                        {truncate(i.finalText ?? i.draft ?? i.lastError ?? '', 120)}
                      </td>
                      <td className="small muted">{ago(i.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager hasMore={!!cursor} loading={loading} onMore={() => void run(q, true)} shown={items.length} total={total} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
