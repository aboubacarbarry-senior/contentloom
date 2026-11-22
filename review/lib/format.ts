import type { Severity, Status } from './types';

export const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  generating: 'Generating',
  scored: 'Scored',
  in_review: 'In review',
  auto_approved: 'Auto-approved',
  approved: 'Approved',
  rejected: 'Rejected',
  published: 'Published',
  withdrawn: 'Withdrawn',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Tone used for badges: green for done, amber for waiting on people, red for problems. */
export function statusTone(s: Status): 'ok' | 'wait' | 'bad' | 'muted' | 'info' {
  switch (s) {
    case 'published':
    case 'approved':
    case 'auto_approved':
      return 'ok';
    case 'in_review':
      return 'wait';
    case 'failed':
    case 'rejected':
      return 'bad';
    case 'cancelled':
    case 'withdrawn':
      return 'muted';
    default:
      return 'info';
  }
}

export const SEVERITY_LABEL: Record<Severity, string> = { block: 'Blocks', warn: 'Warning', info: 'Note' };

export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function score(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  return x.toFixed(2);
}

/** Score colour band: under 0.7 needs attention, 0.7–0.85 borderline, above is good. */
export function scoreTone(x: number | null | undefined, threshold = 0.85): 'ok' | 'wait' | 'bad' | 'muted' {
  if (x === null || x === undefined) return 'muted';
  if (x >= threshold) return 'ok';
  if (x >= 0.7) return 'wait';
  return 'bad';
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  if (x > 0 && x < 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function int(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  return x.toLocaleString('en-US');
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

/** "3 minutes ago", "in 2 hours". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((t - now) / 1000);
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs || unit === 'second') {
      const v = Math.round(diff / secs);
      return rtf ? rtf.format(v, unit) : `${Math.abs(v)} ${unit}s ${v < 0 ? 'ago' : 'from now'}`;
    }
  }
  return iso;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function minutes(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  if (x < 1) return `${Math.round(x * 60)} s`;
  if (x < 90) return `${x.toFixed(x < 10 ? 1 : 0)} min`;
  return `${(x / 60).toFixed(1)} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${int(n)} ${n === 1 ? one : many}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function truncate(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** "item:1234…" style audit subjects, made readable. */
export function subjectLabel(subject: string): { kind: string; id: string | null } {
  const i = subject.indexOf(':');
  return i === -1 ? { kind: subject, id: null } : { kind: subject.slice(0, i), id: subject.slice(i + 1) };
}

export function classes(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
