'use client';
import { useState } from 'react';
import { BarChart, CalibrationChart, HBars, Sparkline } from '../../components/Charts';
import { ErrorBanner, Section, Spinner, Stat, Tabs, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { int, minutes, pct, usd } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import type { GroupStats } from '../../lib/types';

type Tab = 'overview' | 'calibration' | 'experiments';

function GroupTable({ rows, label }: { rows: GroupStats[]; label: string }) {
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">Items</th>
          <th className="num">Auto-approved</th>
          <th className="num">In review</th>
          <th className="num">Published</th>
          <th className="num">Failed</th>
          <th className="num">Mean score</th>
          <th className="num">Approval rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.key}>
            <td>{g.key}</td>
            <td className="num">{int(g.items)}</td>
            <td className="num">{int(g.autoApproved)}</td>
            <td className="num">{int(g.inReview)}</td>
            <td className="num">{int(g.published)}</td>
            <td className="num">{g.failed ? <Tone tone="bad">{g.failed}</Tone> : 0}</td>
            <td className="num">{g.meanScore === null ? '—' : g.meanScore.toFixed(2)}</td>
            <td className="num">{pct(g.approvalRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Overview() {
  const m = useAsync(() => api.metrics(), []);
  const daily = useAsync(() => api.daily(14), []);
  if (m.error) return <ErrorBanner error={m.error} onRetry={m.reload} />;
  if (!m.data) return <Spinner label="Loading metrics…" />;
  const d = m.data;
  const days = daily.data ?? [];
  const ci = d.autoApprovePrecisionCi;
  return (
    <div className="stack">
      <div className="grid-4">
        <Stat
          label="Auto-approve precision"
          value={pct(d.autoApprovePrecision, 1)}
          tone={d.autoApprovePrecision === null ? undefined : ci && ci.low >= 0.95 ? 'ok' : d.autoApprovePrecision < 0.9 ? 'bad' : 'wait'}
          hint={ci ? `95% CI ${pct(ci.low)}–${pct(ci.high)} from ${d.qaSample.decided} QA reviews` : 'No QA-sample reviews yet'}
        />
        <Stat
          label="Waiting for review"
          value={int(d.inReview)}
          tone={d.review.overdue ? 'bad' : undefined}
          hint={d.review.overdue ? `${int(d.review.overdue)} past the ${d.review.slaHours} h SLA` : `${int(d.autoApproved)} auto-approved, ${int(d.published)} published`}
        />
        <Stat label="Reviewer edit rate" value={pct(d.review.approved ? d.review.approvedWithEdits / d.review.approved : null)} hint={d.review.meanEditRatio !== null ? `${pct(d.review.meanEditRatio)} of words changed when edited` : undefined} />
        <Stat
          label="Model cost"
          value={usd(d.cost.totalUsd)}
          hint={
            <>
              {d.cost.perPublishedUsd !== null && `${usd(d.cost.perPublishedUsd)} per published · `}
              today {usd(d.cost.today.spentUsd)}
              {d.cost.today.limitUsd !== null && ` of ${usd(d.cost.today.limitUsd)}`}
            </>
          }
        />
      </div>

      <div className="grid-2">
        <Section title="Last 14 days" actions={<Sparkline values={days.map((x) => x.costUsd)} />}>
          {days.length ? (
            <BarChart
              labels={days.map((x) => x.day.slice(5))}
              series={[
                { label: 'Created', values: days.map((x) => x.created) },
                { label: 'Published', values: days.map((x) => x.published), alt: true },
              ]}
            />
          ) : (
            <Spinner />
          )}
        </Section>
        <Section title="Review">
          <table className="table compact">
            <tbody>
              <tr>
                <td>Decisions</td>
                <td className="num">{int(d.review.decided)}</td>
              </tr>
              <tr>
                <td>Approved (with edits)</td>
                <td className="num">
                  {int(d.review.approved)} ({int(d.review.approvedWithEdits)})
                </td>
              </tr>
              <tr>
                <td>Sent back for revision</td>
                <td className="num">{int(d.review.revised)}</td>
              </tr>
              <tr>
                <td>Rejected</td>
                <td className="num">{int(d.review.rejected)}</td>
              </tr>
              <tr>
                <td>Time in review, median / p90</td>
                <td className="num">
                  {minutes(d.review.medianMinutesInReview)} / {minutes(d.review.p90MinutesInReview)}
                </td>
              </tr>
              <tr>
                <td>QA sample (sampled / decided / approved)</td>
                <td className="num">
                  {d.qaSample.sampled} / {d.qaSample.decided} / {d.qaSample.approved}
                </td>
              </tr>
              <tr>
                <td>Policy</td>
                <td className="num">
                  approve at {d.policy.autoApproveAt}, sample {pct(d.policy.sampleRate)}
                </td>
              </tr>
            </tbody>
          </table>
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Most common findings">
          {d.findings.length ? <HBars rows={d.findings.map((f) => ({ label: f.code, value: f.count, highlight: f.blocking }))} /> : <p className="muted">No findings yet.</p>}
          <p className="small muted" style={{ marginTop: 8 }}>
            Red share: findings that blocked auto-approval.
          </p>
        </Section>
        <Section title="Reviewers" flush>
          <table className="table compact">
            <thead>
              <tr>
                <th>Reviewer</th>
                <th className="num">Decided</th>
                <th className="num">Approved</th>
                <th className="num">Edited</th>
                <th className="num">Rejected</th>
                <th className="num">Revised</th>
                <th className="num">Median time</th>
              </tr>
            </thead>
            <tbody>
              {d.reviewers.map((r) => (
                <tr key={r.reviewer}>
                  <td>{r.reviewer}</td>
                  <td className="num">{r.decided}</td>
                  <td className="num">{r.approved}</td>
                  <td className="num">{r.approvedWithEdits}</td>
                  <td className="num">{r.rejected}</td>
                  <td className="num">{r.revised}</td>
                  <td className="num">{minutes(r.medianMinutesInReview)}</td>
                </tr>
              ))}
              {!d.reviewers.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No decisions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>
      </div>

      <Section title="By category" flush>
        <GroupTable rows={d.byCategory} label="Category" />
      </Section>
      <Section title="By locale" flush>
        <GroupTable rows={d.byLocale} label="Locale" />
      </Section>
    </div>
  );
}

function CalibrationTab() {
  const [target, setTarget] = useState(0.95);
  const cal = useAsync(() => api.calibration(target), [target]);
  return (
    <div className="stack">
      <div className="row">
        <label className="row">
          Target precision
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {[0.9, 0.95, 0.97, 0.99].map((t) => (
              <option key={t} value={t}>
                {pct(t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBanner error={cal.error} onRetry={cal.reload} />
      {!cal.data ? (
        <Spinner />
      ) : (
        <>
          <div className={`banner ${cal.data.recommendation.threshold === null ? 'info' : 'warn'}`}>
            {cal.data.recommendation.threshold === null ? (
              <>No recommendation: {cal.data.recommendation.reason}.</>
            ) : (
              <>
                A threshold of <strong>{cal.data.recommendation.threshold}</strong> meets the target ({cal.data.recommendation.reason}); the current threshold is {cal.data.current}.
              </>
            )}
          </div>
          <Section title="Precision by threshold">
            <CalibrationChart rows={cal.data.rows} target={target} current={cal.data.current} />
          </Section>
          <Section title="Table" flush>
            <table className="table compact">
              <thead>
                <tr>
                  <th className="num">Threshold</th>
                  <th className="num">Reviewed</th>
                  <th className="num">Approved</th>
                  <th className="num">Precision</th>
                  <th className="num">95% CI</th>
                  <th className="num">Would auto-approve</th>
                </tr>
              </thead>
              <tbody>
                {cal.data.rows.map((r) => (
                  <tr key={r.threshold} style={r.threshold === cal.data!.current ? { fontWeight: 600 } : undefined}>
                    <td className="num">{r.threshold.toFixed(2)}</td>
                    <td className="num">{r.n}</td>
                    <td className="num">{r.approved}</td>
                    <td className="num">{pct(r.precision, 1)}</td>
                    <td className="num">{r.ci ? `${pct(r.ci.low)}–${pct(r.ci.high)}` : '—'}</td>
                    <td className="num">{pct(r.coverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <p className="small muted">
            Built from drafts a reviewer decided whose only reason for review was their score or the QA sample. Drafts with blocking findings go to review at any threshold, so they are left out.
          </p>
        </>
      )}
    </div>
  );
}

function ExperimentsTab() {
  const exp = useAsync(() => api.experiments(), []);
  if (exp.error) return <ErrorBanner error={exp.error} onRetry={exp.reload} />;
  if (!exp.data) return <Spinner />;
  const e = exp.data;
  return (
    <div className="stack">
      <div className="banner info">{e.experimentId ? `Experiment “${e.experimentId}”. ${e.note}` : `No experiment is running; showing prompt variants seen in the data. ${e.note}`}</div>
      <Section title="Arms" flush>
        <table className="table compact">
          <thead>
            <tr>
              <th>Variant</th>
              <th className="num">Items</th>
              <th className="num">Reviewed</th>
              <th className="num">Approved as written</th>
              <th className="num">Edited</th>
              <th className="num">Rejected</th>
              <th className="num">Revised</th>
              <th className="num">Mean score</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {e.arms.map((a) => (
              <tr key={a.variant}>
                <td>{a.variant}</td>
                <td className="num">{a.items}</td>
                <td className="num">{a.reviewed}</td>
                <td className="num">
                  {a.approvedClean} ({pct(a.cleanApprovalRate)})
                </td>
                <td className="num">{a.approvedEdited}</td>
                <td className="num">{a.rejected}</td>
                <td className="num">{a.revised}</td>
                <td className="num">{a.meanScore === null ? '—' : a.meanScore.toFixed(2)}</td>
                <td className="num">{usd(a.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {e.comparisons.length > 0 && (
        <Section title="Against control">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {e.comparisons.map((c) => (
              <li key={c.variant}>
                <strong>{c.variant}</strong>: {c.lift === null ? 'not enough data' : `${c.lift >= 0 ? '+' : ''}${pct(c.lift, 1)} clean approvals`}
                {c.p !== null && ` (p = ${c.p})`} {c.significant ? <Tone tone="ok">significant</Tone> : <Tone tone="muted">not significant</Tone>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export default function MetricsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <div className="sub">Is auto-approval safe, where do drafts fail, and what does it cost?</div>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'calibration', label: 'Threshold calibration' },
          { id: 'experiments', label: 'Prompt experiments' },
        ]}
      />
      {tab === 'overview' && <Overview />}
      {tab === 'calibration' && <CalibrationTab />}
      {tab === 'experiments' && <ExperimentsTab />}
    </div>
  );
}
