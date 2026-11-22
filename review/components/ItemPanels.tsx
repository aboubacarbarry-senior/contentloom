'use client';
import { useState } from 'react';
import { api } from '../lib/api';
import { ago, dateTime, pct, score as fmtScore, STATUS_LABEL, statusTone, usd } from '../lib/format';
import type { Comment, HistoryEntry, Score, Usage } from '../lib/types';
import { useToast } from './Toasts';

export function Timeline({ history }: { history: HistoryEntry[] }) {
  return (
    <ol className="timeline">
      {history
        .slice()
        .reverse()
        .map((h, i) => {
          const tone = statusTone(h.to);
          return (
            <li key={i} className={tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'wait' ? 'wait' : ''}>
              <div className="spread">
                <strong>{STATUS_LABEL[h.to]}</strong>
                <span className="muted small" title={h.at}>
                  {dateTime(h.at)}
                </span>
              </div>
              <div className="small muted">
                by {h.by}
                {h.from ? ` · from ${STATUS_LABEL[h.from]}` : ''}
              </div>
              {h.note && <div className="small">{h.note}</div>}
            </li>
          );
        })}
    </ol>
  );
}

const COMPONENTS: { key: keyof Pick<Score, 'facts' | 'claims' | 'length' | 'judge'>; label: string; weight: number }[] = [
  { key: 'facts', label: 'Required facts', weight: 0.25 },
  { key: 'claims', label: 'No banned claims', weight: 0.25 },
  { key: 'length', label: 'Length', weight: 0.1 },
  { key: 'judge', label: 'Judge', weight: 0.4 },
];

export function ScoreBreakdown({ score, threshold }: { score: Score; threshold?: number }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="spread">
        <strong style={{ fontSize: 22 }}>{fmtScore(score.total)}</strong>
        {threshold !== undefined && <span className="muted small">auto-approve at {threshold}</span>}
      </div>
      <table className="table compact">
        <tbody>
          {COMPONENTS.map((c) => {
            const v = score[c.key];
            return (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="num muted">×{c.weight}</td>
                <td className="num">{v === null ? '—' : pct(v)}</td>
              </tr>
            );
          })}
          {score.readability !== undefined && score.readability !== null && (
            <tr>
              <td>Readability</td>
              <td className="num muted">info</td>
              <td className="num">{score.readability.toFixed(0)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {score.verdict && (
        <div className="small">
          <div className="muted">
            Judge: accuracy {score.verdict.accuracy}/5 · usefulness {score.verdict.usefulness}/5 · tone {score.verdict.tone}/5
          </div>
          <p style={{ margin: '4px 0 0' }}>{score.verdict.rationale}</p>
        </div>
      )}
    </div>
  );
}

export function UsageLine({ usage }: { usage?: Usage }) {
  if (!usage || !usage.calls) return <span className="muted small">No model usage recorded.</span>;
  return (
    <span className="small muted">
      {usage.calls} calls · {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out tokens
      {usage.cacheReadTokens ? ` · ${usage.cacheReadTokens.toLocaleString()} cached` : ''} · {usd(usage.costUsd)}
    </span>
  );
}

/**
 * Comments on an item. A selection in the draft (passed in as `anchor`) attaches the comment to that
 * span; the review app highlights unresolved anchored comments in the text.
 */
export function CommentsPanel({
  itemId,
  comments,
  draft,
  anchor,
  onClearAnchor,
  onChange,
}: {
  itemId: string;
  comments: Comment[];
  draft: string | null;
  anchor: { start: number; end: number } | null;
  onClearAnchor: () => void;
  onChange: (comments: Comment[]) => void;
}) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const visible = comments.filter((c) => showResolved || !c.resolved);

  async function add() {
    setBusy(true);
    try {
      const c = await api.addComment(itemId, body.trim(), anchor ?? undefined);
      onChange([...comments, c]);
      setBody('');
      onClearAnchor();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Comment) {
    try {
      const updated = await api.resolveComment(c.id, !c.resolved);
      onChange(comments.map((x) => (x.id === c.id ? updated : x)));
    } catch (e) {
      toast.error(e);
    }
  }

  const resolvedCount = comments.filter((c) => c.resolved).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {visible.length === 0 && <p className="muted small">No comments yet. Select text in the draft to comment on it.</p>}
      {visible.map((c) => (
        <div key={c.id} className={`comment ${c.resolved ? 'resolved' : ''}`}>
          <div className="spread small">
            <strong>{c.author}</strong>
            <span className="muted" title={c.at}>
              {ago(c.at)}
            </span>
          </div>
          {c.start !== null && c.end !== null && draft && <blockquote>{draft.slice(c.start, c.end)}</blockquote>}
          <div>{c.body}</div>
          <button className="btn small ghost" onClick={() => toggle(c)}>
            {c.resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      ))}
      {resolvedCount > 0 && (
        <button className="btn small ghost" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved
        </button>
      )}
      {anchor && draft && (
        <div className="banner info small spread">
          <span>On “{draft.slice(anchor.start, anchor.end)}”</span>
          <button className="btn small ghost" onClick={onClearAnchor}>
            Clear
          </button>
        </div>
      )}
      <textarea rows={2} placeholder="Add a comment for other reviewers" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
      <div>
        <button className="btn small" onClick={add} disabled={!body.trim() || busy}>
          {busy ? 'Saving…' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
