'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HighlightedText } from '../../../components/TextViews';
import { ErrorBanner, ScoreBadge, Spinner, StatusBadge, Tone } from '../../../components/ui';
import { api } from '../../../lib/api';
import { ago } from '../../../lib/format';
import { useAsync, useEvents } from '../../../lib/hooks';
import type { Finding, LocaleVersion } from '../../../lib/types';

/** Mark every number-with-unit in a text, so sizes can be compared across columns at a glance. */
function measurementMarks(text: string): Finding[] {
  const re = /\d+(?:[.,]\d+)?(?:\s*(?:x|×|by|por|par)\s*\d+(?:[.,]\d+)?)*\s?(?:cm|mm|m|in|ft|"|kg|g|lb|oz|ml|l|W|V|pulgadas|pies|po|pi)\b/gi;
  return [...text.matchAll(re)].map((m) => ({ code: 'measure', severity: 'info' as const, message: 'measurement', start: m.index!, end: m.index! + m[0].length }));
}

function Column({ v }: { v: LocaleVersion }) {
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>{v.locale}</h2>
        <div className="row">
          <StatusBadge status={v.status} />
          <ScoreBadge value={v.score} />
        </div>
      </div>
      <div className="small muted">
        {v.source === 'final' ? 'Final text' : v.source === 'draft' ? 'Latest draft' : 'No text yet'} · updated {ago(v.updatedAt)} · <Link href={`/items/${v.itemId}`}>open item</Link>
      </div>
      {v.text ? <HighlightedText text={v.text} findings={measurementMarks(v.text)} /> : <p className="muted">Nothing generated yet.</p>}
    </section>
  );
}

export default function SkuPage() {
  const params = useParams<{ sku: string }>();
  const sku = decodeURIComponent(params?.sku ?? '');
  const data = useAsync(() => api.sku(sku), [sku]);
  useEvents(['item.status'], () => void data.reload());

  if (data.error) return <ErrorBanner error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Spinner label="Loading…" />;
  const d = data.data;
  const blocking = d.issues.filter((i) => i.severity === 'block');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{d.sku}</h1>
            {blocking.length ? <Tone tone="bad">{blocking.length} disagreement{blocking.length === 1 ? '' : 's'}</Tone> : <Tone tone="ok">consistent</Tone>}
          </div>
          <div className="sub">All locales of this SKU. Measurements are highlighted so they can be compared.</div>
        </div>
        <Link className="btn" href="/skus">
          All SKUs
        </Link>
      </div>
      {d.issues.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {d.issues.map((i, n) => (
            <div key={n} className={`banner ${i.severity === 'block' ? 'error' : i.severity === 'warn' ? 'warn' : 'info'}`}>
              <strong>{i.kind.replace('-', ' ')}:</strong> {i.message}
            </div>
          ))}
        </div>
      )}
      <div className="grid-3">
        {d.versions.map((v) => (
          <Column key={v.locale} v={v} />
        ))}
      </div>
    </div>
  );
}
