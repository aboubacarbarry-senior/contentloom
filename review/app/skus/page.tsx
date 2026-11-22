'use client';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState, ErrorBanner, Spinner, StatusBadge, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync, useQueryParam } from '../../lib/hooks';
import type { Locale } from '../../lib/types';

const LOCALES: Locale[] = ['en-US', 'es-US', 'fr-CA'];

/**
 * Every SKU with its locales side by side, worst first: SKUs whose locales disagree on a size or
 * weight, or are published in one language but not another.
 */
export default function SkusPage() {
  const [prefix, setPrefix] = useQueryParam('prefix');
  const [draft, setDraft] = useState(prefix);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const rows = useAsync(() => api.skus(prefix || undefined), [prefix]);
  const shown = (rows.data ?? []).filter((r) => !onlyIssues || r.issues > 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Locales</h1>
          <div className="sub">Each SKU is written once per locale. This view catches locales that disagree with each other.</div>
        </div>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setPrefix(draft.trim());
        }}
      >
        <input type="search" placeholder="SKU prefix, e.g. TEX-HARBOR" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 280 }} aria-label="SKU prefix" />
        <button className="btn" type="submit">
          Show
        </button>
        <label className="row small">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only SKUs with issues
        </label>
      </form>
      <ErrorBanner error={rows.error} onRetry={rows.reload} />
      {rows.loading && !rows.data && <Spinner label="Loading SKUs…" />}
      {rows.data && shown.length === 0 && (
        <div className="card">
          <EmptyState title={onlyIssues ? 'No cross-locale issues' : 'No SKUs found'} />
        </div>
      )}
      {shown.length > 0 && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                {LOCALES.map((l) => (
                  <th key={l}>{l}</th>
                ))}
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku}>
                  <td>
                    <Link href={`/skus/${encodeURIComponent(r.sku)}`}>{r.sku}</Link>
                  </td>
                  {LOCALES.map((l) => (
                    <td key={l}>{r.statuses[l] ? <StatusBadge status={r.statuses[l]!} /> : <span className="muted">—</span>}</td>
                  ))}
                  <td>{r.blocking ? <Tone tone="bad">{r.blocking} blocking</Tone> : r.issues ? <Tone tone="wait">{r.issues}</Tone> : <Tone tone="ok">consistent</Tone>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.data && rows.data.length >= 200 && <p className="small muted">Showing the first 200 SKUs; narrow with a prefix.</p>}
    </div>
  );
}
