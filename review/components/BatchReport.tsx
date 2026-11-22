'use client';
import Link from 'next/link';
import { HBars } from './Charts';
import { ErrorBanner, Section, Spinner } from './ui';
import { api } from '../lib/api';
import { pct } from '../lib/format';
import { useAsync } from '../lib/hooks';

/**
 * What went wrong in a batch: the findings and review reasons that came up most, outcomes per locale,
 * how much reviewers edited, and why items failed. Merchandisers use it to fix their briefs.
 */
export function BatchReportPanel({ batchId }: { batchId: string }) {
  const report = useAsync(() => api.batchReport(batchId), [batchId]);
  if (report.error) return <ErrorBanner error={report.error} onRetry={report.reload} />;
  if (!report.data) return <Spinner label="Building the report…" />;
  const r = report.data;
  return (
    <div className="stack">
      <div className="grid-2">
        <Section title="Most common findings">
          {r.findings.length ? (
            <>
              <HBars rows={r.findings.slice(0, 10).map((f) => ({ label: f.code, value: f.items, highlight: f.blocking }))} />
              <p className="small muted" style={{ marginTop: 8 }}>
                Items with each finding; the red share blocked auto-approval.{' '}
                <Link href={`/search?q=${encodeURIComponent(`batch:${batchId} status:in_review`)}`}>See the drafts waiting</Link>.
              </p>
            </>
          ) : (
            <p className="muted">No findings.</p>
          )}
        </Section>
        <Section title="Why drafts went to review">
          {r.reasons.length ? (
            <table className="table compact">
              <tbody>
                {r.reasons.map((x) => (
                  <tr key={x.reason}>
                    <td>{x.reason === 'QA sample' ? 'Random QA sample' : x.reason}</td>
                    <td className="num">{x.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Nothing went to review.</p>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>
            Reviewers changed {r.edits.edited} of {r.edits.approved} approved drafts
            {r.edits.meanEditRatio !== null && `, rewriting ${pct(r.edits.meanEditRatio)} of the words on average`}.
          </p>
        </Section>
      </div>
      <Section title="By locale" flush>
        <table className="table compact">
          <thead>
            <tr>
              <th>Locale</th>
              <th className="num">Items</th>
              <th className="num">Auto-approved</th>
              <th className="num">Reviewed</th>
              <th className="num">Approved</th>
              <th className="num">Published</th>
              <th className="num">Failed</th>
            </tr>
          </thead>
          <tbody>
            {r.locales.map((l) => (
              <tr key={l.locale}>
                <td>{l.locale}</td>
                <td className="num">{l.items}</td>
                <td className="num">
                  {l.autoApproved} <span className="muted">({pct(l.items ? l.autoApproved / l.items : null)})</span>
                </td>
                <td className="num">{l.reviewed}</td>
                <td className="num">{l.approved}</td>
                <td className="num">{l.published}</td>
                <td className="num">{l.failed || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {r.errors.length > 0 && (
        <Section title="Failures">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.errors.map((e) => (
              <li key={e.message}>
                <span className="mono small">{e.message}</span> <span className="muted">× {e.items}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
