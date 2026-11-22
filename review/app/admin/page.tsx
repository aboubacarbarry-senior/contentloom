'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { ErrorBanner, Pager, Section, Spinner, Tabs, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { ago, dateTime, subjectLabel, truncate } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import type { AuditEntry, OutboxMessage, Page } from '../../lib/types';

type Tab = 'policy' | 'outbox' | 'audit' | 'exports' | 'system';

function PolicyTab() {
  const toast = useToast();
  const meta = useAsync(() => api.meta(), []);
  const pol = useAsync(() => api.policy(), []);
  const [autoApproveAt, setAuto] = useState('');
  const [sampleRate, setSample] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [alwaysReview, setAlways] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pol.data) return;
    const p = pol.data.policy;
    setAuto(String(p.autoApproveAt));
    setSample(String(p.sampleRate));
    setOverrides(Object.fromEntries(Object.entries(p.categoryThresholds ?? {}).map(([k, v]) => [k, String(v)])));
    setAlways((p.alwaysReview ?? []).join(', '));
  }, [pol.data]);

  async function save() {
    setBusy(true);
    try {
      const current = pol.data!.policy.categoryThresholds ?? {};
      const categoryThresholds: Record<string, number | null> = {};
      for (const c of new Set([...Object.keys(current), ...Object.keys(overrides)])) {
        const v = overrides[c]?.trim();
        categoryThresholds[c] = v ? Number(v) : null;
      }
      const r = await api.updatePolicy({
        autoApproveAt: Number(autoApproveAt),
        sampleRate: Number(sampleRate),
        categoryThresholds,
        alwaysReview: alwaysReview
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast.info('Policy saved. It applies to drafts scored from now on.');
      for (const w of r.warnings) toast.info(w);
      await pol.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  if (pol.error) return <ErrorBanner error={pol.error} onRetry={pol.reload} />;
  if (!pol.data || !meta.data) return <Spinner />;
  return (
    <div className="grid-2">
      <Section title="Auto-approval">
        <div className="stack">
          <label className="field">
            Auto-approve at score
            <input type="number" min={0} max={1} step={0.01} value={autoApproveAt} onChange={(e) => setAuto(e.target.value)} />
          </label>
          <label className="field">
            QA sample rate (share of auto-approvable drafts still reviewed)
            <input type="number" min={0.01} max={1} step={0.01} value={sampleRate} onChange={(e) => setSample(e.target.value)} />
          </label>
          <label className="field">
            Extra categories that always need review (comma-separated)
            <input type="text" value={alwaysReview} onChange={(e) => setAlways(e.target.value)} placeholder="toys, outdoor" />
          </label>
          <p className="small muted">
            Before raising the threshold or lowering the sample, check <Link href="/metrics">threshold calibration</Link>. Every change is recorded in the audit log.
          </p>
          <div>
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save policy'}
            </button>
          </div>
        </div>
      </Section>
      <Section title="Per-category thresholds" flush>
        <table className="table compact">
          <thead>
            <tr>
              <th>Category</th>
              <th>Regulated</th>
              <th className="num">Override</th>
              <th className="num">Effective</th>
            </tr>
          </thead>
          <tbody>
            {meta.data.categories.map((c) => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>{c.regulated ? <Tone tone="bad">always reviewed</Tone> : ''}</td>
                <td className="num">
                  <input type="number" min={0} max={1} step={0.01} style={{ width: 80 }} value={overrides[c.id] ?? ''} placeholder="—" onChange={(e) => setOverrides({ ...overrides, [c.id]: e.target.value })} disabled={c.regulated} />
                </td>
                <td className="num">{pol.data!.effectiveThresholds[c.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function OutboxTab() {
  const toast = useToast();
  const [status, setStatus] = useState<'' | OutboxMessage['status']>('');
  const [page, setPage] = useState<(Page<OutboxMessage> & { counts: Record<string, number> }) | null>(null);
  const first = useAsync(async () => {
    const p = await api.outbox(status || undefined);
    setPage(p);
    return p;
  }, [status]);

  async function retry(m: OutboxMessage) {
    try {
      await api.retryOutbox(m.id);
      toast.info('Queued for another attempt');
      await first.reload();
    } catch (e) {
      toast.error(e);
    }
  }

  async function sweep() {
    try {
      const r = await api.sweep();
      toast.info(`Sweep: ${r.outbox.delivered ?? 0} delivered, ${r.outbox.retried ?? 0} retried, ${r.requeued} items requeued, ${r.leasesExpired} leases cleared`);
      await first.reload();
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          {(['', 'pending', 'delivered', 'dead'] as const).map((s) => (
            <button key={s || 'all'} className={`btn small ${status === s ? 'primary' : ''}`} onClick={() => setStatus(s)}>
              {s || 'All'}
              {s && page?.counts[s] !== undefined ? ` (${page.counts[s]})` : ''}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void sweep()}>
          Run housekeeping now
        </button>
      </div>
      <ErrorBanner error={first.error} onRetry={first.reload} />
      {page && (
        <div className="card flush">
          <table className="table compact">
            <thead>
              <tr>
                <th>Event</th>
                <th>Target</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.items.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.event}</td>
                  <td className="small">{new URL(m.target).host}</td>
                  <td>
                    <Tone tone={m.status === 'delivered' ? 'ok' : m.status === 'dead' ? 'bad' : 'wait'}>{m.status}</Tone>
                    {m.status === 'pending' && <div className="small muted">next {ago(m.nextAttemptAt)}</div>}
                  </td>
                  <td className="num">{m.attempts}</td>
                  <td className="small" title={m.lastError ?? ''}>
                    {m.lastError ? truncate(m.lastError, 60) : ''}
                  </td>
                  <td className="small muted">{dateTime(m.createdAt)}</td>
                  <td>
                    {m.status === 'dead' && (
                      <button className="btn small" onClick={() => void retry(m)}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!page.items.length && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    No webhook deliveries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <Pager
            hasMore={!!page.nextCursor}
            onMore={async () => {
              const more = await api.outbox(status || undefined, page.nextCursor);
              setPage({ ...more, items: [...page.items, ...more.items] });
            }}
            shown={page.items.length}
            total={page.total}
          />
        </div>
      )}
    </div>
  );
}

function AuditTab() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState<Page<AuditEntry> | null>(null);
  const first = useAsync(async () => {
    const p = await api.audit({ actor: actor || undefined, action: action || undefined });
    setPage(p);
    return p;
  }, [actor, action]);

  const link = (subject: string) => {
    const { kind, id } = subjectLabel(subject);
    if (kind === 'item' && id) return <Link href={`/items/${id}`}>item {id.slice(0, 8)}</Link>;
    if (kind === 'batch' && id) return <Link href={`/batches/${id}`}>batch {id.slice(0, 8)}</Link>;
    return <span>{id ? `${kind} ${id.slice(0, 8)}` : kind}</span>;
  };

  return (
    <div className="stack">
      <div className="row">
        <input type="text" placeholder="Actor" value={actor} onChange={(e) => setActor(e.target.value)} />
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {['batch.create', 'batch.cancel', 'batch.retry_failed', 'item.publish', 'item.withdraw', 'glossary.add', 'glossary.remove', 'policy.update', 'outbox.retry'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner error={first.error} onRetry={first.reload} />
      {page && (
        <div className="card flush">
          <table className="table compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Subject</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((e) => (
                <tr key={e.id}>
                  <td className="small" title={e.at}>
                    {dateTime(e.at)}
                  </td>
                  <td>{e.actor}</td>
                  <td className="mono">{e.action}</td>
                  <td className="small">{link(e.subject)}</td>
                  <td className="small mono" style={{ maxWidth: 420, wordBreak: 'break-word' }}>
                    {truncate(JSON.stringify(e.detail), 160)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            hasMore={!!page.nextCursor}
            onMore={async () => {
              const more = await api.audit({ actor: actor || undefined, action: action || undefined, cursor: page.nextCursor });
              setPage({ ...more, items: [...page.items, ...more.items] });
            }}
            shown={page.items.length}
            total={page.total}
          />
        </div>
      )}
    </div>
  );
}

function ExportsTab() {
  const [locale, setLocale] = useState('');
  const [since, setSince] = useState('');
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv');
  const params = { locale: locale || undefined, since: since || undefined, format };
  return (
    <div className="grid-2">
      <Section title="Published copy">
        <p className="small muted">For the PIM team: every published description with its SKU and locale.</p>
        <div className="row">
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="">All locales</option>
            <option value="en-US">en-US</option>
            <option value="es-US">es-US</option>
            <option value="fr-CA">fr-CA</option>
          </select>
          <label className="row small">
            Since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <select value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'jsonl')}>
            <option value="csv">CSV</option>
            <option value="jsonl">JSON Lines</option>
          </select>
        </div>
        <div style={{ marginTop: 12 }}>
          <a className="btn primary" href={api.exportUrl('published', params)}>
            Download
          </a>
        </div>
      </Section>
      <Section title="Review log">
        <p className="small muted">For audits: every reviewer decision with the model draft next to the approved text.</p>
        <a className="btn" href={api.exportUrl('reviews', params)}>
          Download review log
        </a>
      </Section>
    </div>
  );
}

function SystemTab() {
  const health = useAsync(() => api.health(), []);
  const meta = useAsync(() => api.meta(), []);
  if (!health.data || !meta.data) return <Spinner />;
  const h = health.data;
  return (
    <div className="grid-2">
      <Section title="Health">
        <table className="table compact">
          <tbody>
            <tr>
              <td>Store</td>
              <td>
                <Tone tone={h.store.ok ? 'ok' : 'bad'}>{h.store.ok ? 'ok' : 'down'}</Tone> <span className="small muted">{h.store.detail}</span>
              </td>
            </tr>
            <tr>
              <td>Queue</td>
              <td>{h.queue ? `${h.queue.waiting} waiting · ${h.queue.delayed} delayed · ${h.queue.active} active · ${h.queue.failed} failed` : 'unavailable'}</td>
            </tr>
            <tr>
              <td>Budget today</td>
              <td>{h.budget.limitUsd === null ? `$${h.budget.spentUsd.toFixed(2)} spent, no limit` : `$${h.budget.spentUsd.toFixed(2)} of $${h.budget.limitUsd.toFixed(2)}`}</td>
            </tr>
            <tr>
              <td>Model</td>
              <td className="mono">{h.model}</td>
            </tr>
            <tr>
              <td>Prompt version</td>
              <td className="mono">{h.promptVersion}</td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section title="Checks">
        <table className="table compact">
          <tbody>
            {meta.data.checks.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td className="small">{c.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('policy');
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <div className="sub">Routing policy, webhook deliveries, the audit log and exports. Most actions need the admin role.</div>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'policy', label: 'Routing policy' },
          { id: 'outbox', label: 'Webhooks' },
          { id: 'audit', label: 'Audit log' },
          { id: 'exports', label: 'Exports' },
          { id: 'system', label: 'System' },
        ]}
      />
      {tab === 'policy' && <PolicyTab />}
      {tab === 'outbox' && <OutboxTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'exports' && <ExportsTab />}
      {tab === 'system' && <SystemTab />}
    </div>
  );
}
