'use client';
import { Fragment, ReactNode } from 'react';
import { SEVERITY_LABEL } from '../lib/format';
import { findingSpans, worstSeverity } from '../lib/text';
import type { Comment, DiffOp, Finding, Severity } from '../lib/types';

/**
 * The draft with every finding that has a position underlined, and comment anchors marked. Hovering a
 * highlight shows what was found there.
 */
export function HighlightedText({ text, findings = [], comments = [], onSelect }: { text: string; findings?: Finding[]; comments?: Comment[]; onSelect?: (range: { start: number; end: number }) => void }) {
  const commentFindings: Finding[] = comments
    .filter((c) => !c.resolved && c.start !== null && c.end !== null)
    .map((c) => ({ code: 'comment', severity: 'info', message: `${c.author}: ${c.body}`, start: c.start!, end: c.end! }));
  const spans = findingSpans([...findings, ...commentFindings], text.length);
  const parts: ReactNode[] = [];
  let pos = 0;
  spans.forEach((s, i) => {
    if (s.start > pos) parts.push(<Fragment key={`t${i}`}>{text.slice(pos, s.start)}</Fragment>);
    const isComment = s.findings.every((f) => f.code === 'comment');
    const sev = worstSeverity(s.findings.filter((f) => f.code !== 'comment'));
    parts.push(
      <mark key={`m${i}`} className={`hl ${isComment ? 'hl-comment' : `hl-${sev}`}`} title={s.findings.map((f) => (f.code === 'comment' ? f.message : `${SEVERITY_LABEL[f.severity]}: ${f.message}`)).join('\n')}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  });
  if (pos < text.length) parts.push(<Fragment key="tail">{text.slice(pos)}</Fragment>);

  return (
    <div
      className="copy"
      onMouseUp={() => {
        if (!onSelect) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const selected = sel.toString();
        const idx = text.indexOf(selected);
        if (selected.trim() && idx !== -1) onSelect({ start: idx, end: idx + selected.length });
      }}
    >
      {parts}
    </div>
  );
}

export function DiffView({ ops, empty = 'No changes.' }: { ops: DiffOp[] | null; empty?: string }) {
  if (!ops || !ops.some((o) => o.op !== 'equal')) return <p className="muted">{empty}</p>;
  return (
    <div className="copy">
      {ops.map((o, i) =>
        o.op === 'equal' ? (
          <Fragment key={i}>{o.text}</Fragment>
        ) : o.op === 'insert' ? (
          <ins key={i} className="diff">
            {o.text}
          </ins>
        ) : (
          <del key={i} className="diff">
            {o.text}
          </del>
        ),
      )}
    </div>
  );
}

const ORDER: Severity[] = ['block', 'warn', 'info'];

export function FindingsList({ findings, onApply, compact }: { findings: Finding[]; onApply?: (f: Finding) => void; compact?: boolean }) {
  if (!findings.length) return <p className="muted">No findings.</p>;
  const sorted = findings.slice().sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  return (
    <ul className="findings">
      {sorted.map((f, i) => (
        <li key={`${f.code}-${i}`}>
          <span className={`badge tone-${f.severity === 'block' ? 'bad' : f.severity === 'warn' ? 'wait' : 'info'}`}>{SEVERITY_LABEL[f.severity]}</span>
          <span>
            {f.message}
            {!compact && <span className="code"> · {f.code}</span>}
            {f.suggestion && onApply && f.start !== undefined && (
              <>
                {' '}
                <button className="btn small ghost" onClick={() => onApply(f)} title={`Replace with "${f.suggestion}"`}>
                  Use “{f.suggestion.length > 30 ? `${f.suggestion.slice(0, 29)}…` : f.suggestion}”
                </button>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FactsTable({ facts, mustMention = [] }: { facts: Record<string, string>; mustMention?: string[] }) {
  const must = mustMention.map((m) => m.toLowerCase());
  return (
    <dl className="facts">
      {Object.entries(facts).map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>
            {v}
            {must.some((m) => v.toLowerCase().includes(m)) && (
              <span className="badge tone-info" style={{ marginLeft: 6 }} title="Must be mentioned">
                must mention
              </span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function ReasonsList({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <p className="muted">Eligible for auto-approval.</p>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {reasons.map((r) => (
        <li key={r}>{r === 'QA sample' ? 'Random QA sample (would have auto-approved)' : r}</li>
      ))}
    </ul>
  );
}
