'use client';
import { ReactNode, useState } from 'react';
import { classes, score as fmtScore, scoreTone, STATUS_LABEL, statusTone } from '../lib/format';
import type { Status } from '../lib/types';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge tone-${statusTone(status)}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ScoreBadge({ value, threshold }: { value: number | null | undefined; threshold?: number }) {
  return (
    <span className={`badge tone-${scoreTone(value, threshold)}`} title={value === null || value === undefined ? 'not scored' : `score ${value}`}>
      {fmtScore(value)}
    </span>
  );
}

export function Tone({ tone, children, title }: { tone: 'ok' | 'wait' | 'bad' | 'info' | 'muted'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export interface MeterPart {
  value: number;
  tone: 'ok' | 'wait' | 'bad' | 'info' | 'muted';
  label?: string;
}

/** Stacked horizontal meter. Values are fractions of `total`. */
export function Meter({ parts, total, title }: { parts: MeterPart[]; total: number; title?: string }) {
  return (
    <div className="meter" title={title ?? parts.map((p) => `${p.label ?? p.tone}: ${p.value}`).join(', ')} role="img" aria-label={title}>
      {total > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p, i) => <span key={i} className={p.tone} style={{ width: `${(p.value / total) * 100}%` }} />)}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spinner" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ErrorBanner({ error, onRetry }: { error: Error | string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  return (
    <div className="banner error spread" role="alert">
      <span>{msg}</span>
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon = '∅', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big" aria-hidden>
        {icon}
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'wait' | 'bad' }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Pager({ hasMore, loading, onMore, shown, total }: { hasMore: boolean; loading?: boolean; onMore: () => void; shown: number; total: number }) {
  return (
    <div className="spread" style={{ padding: '8px 12px' }}>
      <span className="muted small">
        Showing {shown.toLocaleString()} of {total.toLocaleString()}
      </span>
      {hasMore && (
        <button className="btn small" onClick={onMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={classes(t.id === value && 'active')} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A button that asks for confirmation inline (and optionally a reason) instead of a modal, so
 * keyboard users stay where they are.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  onConfirm,
  danger,
  reason,
  reasonPlaceholder = 'Reason',
  minReason = 5,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: (reason: string) => Promise<unknown> | void;
  danger?: boolean;
  reason?: boolean;
  reasonPlaceholder?: string;
  minReason?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button className={classes('btn', danger && 'danger')} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  const ok = !reason || text.trim().length >= minReason;
  return (
    <span className="row">
      {reason && <input type="text" autoFocus placeholder={reasonPlaceholder} value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 220 }} />}
      <button
        className={classes('btn', danger ? 'danger' : 'primary')}
        disabled={!ok || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm(text.trim());
            setOpen(false);
            setText('');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
      <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </button>
    </span>
  );
}

export function KeyHelp({ keys }: { keys: { key: string; description: string }[] }) {
  return (
    <div className="row small muted" aria-label="Keyboard shortcuts">
      {keys.map((k) => (
        <span key={k.key}>
          <kbd>{k.key}</kbd> {k.description}
        </span>
      ))}
    </div>
  );
}

export function Section({ title, actions, children, flush }: { title: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={classes('card', flush && 'flush')}>
      <div className="card-head" style={flush ? { padding: '12px 16px 0' } : undefined}>
        <h2>{title}</h2>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
