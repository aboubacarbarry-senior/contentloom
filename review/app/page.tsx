'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScoreBreakdown } from '../components/ItemPanels';
import { CommentsPanel } from '../components/ItemPanels';
import { DiffView, FactsTable, FindingsList, HighlightedText, ReasonsList } from '../components/TextViews';
import { useToast } from '../components/Toasts';
import { EmptyState, ErrorBanner, KeyHelp, Spinner, Tone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { ago, wordCount } from '../lib/format';
import { useDebounced, useEvents, useHotkeys, useInterval, useStoredState } from '../lib/hooks';
import { changedWords, diff } from '../lib/text';
import type { Comment, Finding, Item, LintResult } from '../lib/types';

const HEARTBEAT_MS = 2 * 60_000;

/**
 * The review workspace: one draft at a time, worst score first. The API leases the draft to this
 * reviewer, so nobody else gets it while it is open; the lease is kept alive while the page is open.
 */
export default function ReviewWorkspace() {
  const toast = useToast();
  const [filter, setFilter] = useStoredState('contentloom.review.filter', '');
  const [filterDraft, setFilterDraft] = useState('');
  const [item, setItem] = useState<Item | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [empty, setEmpty] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [lint, setLint] = useState<LintResult | null>(null);
  const [anchor, setAnchor] = useState<{ start: number; end: number } | null>(null);
  const [tab, setTab] = useState<'edit' | 'changes'>('edit');
  const [done, setDone] = useState(0);
  const noteRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setFilterDraft(filter), [filter]);

  const load = useCallback(
    async (skip: string[] = skipped) => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.claim(filter, skip);
        if (!next) {
          setItem(null);
          setEmpty(true);
          return;
        }
        setEmpty(false);
        setItem(next);
        setText(next.draft ?? '');
        setNote('');
        setLint(null);
        setAnchor(null);
        setTab('edit');
        const view = await api.view(next.id);
        setReasons(view.reasons);
        setComments(view.comments);
      } catch (e) {
        setError(e as Error);
      } finally {
        setLoading(false);
      }
    },
    [filter, skipped],
  );

  useEffect(() => {
    void load([]);
    setSkipped([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Keep the lease alive while the reviewer works.
  useInterval(
    () => {
      if (!item) return;
      api.heartbeat(item.id).catch((e) => {
        if (e instanceof ApiError && e.conflict) toast.error('Your hold on this draft expired and someone else may have it. Reload before deciding.');
      });
    },
    item ? HEARTBEAT_MS : null,
  );

  // When the queue was empty, pick up new drafts as soon as they arrive.
  useEvents(['item.status'], (e) => {
    if (e.type === 'item.status' && e.to === 'in_review' && empty && !loading) void load();
  });

  // Release the lease when the reviewer leaves the page.
  useEffect(() => {
    const id = item?.id;
    if (!id) return;
    const release = () => navigator.sendBeacon?.(`/api/items/${id}/release`);
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, [item?.id]);

  const edited = !!item && text.trim() !== (item.draft ?? '').trim();
  const liveDiff = useMemo(() => (item && edited ? diff(item.draft ?? '', text) : null), [item, text, edited]);
  const debouncedText = useDebounced(text, 600);

  useEffect(() => {
    if (!item || !edited || !debouncedText.trim()) {
      setLint(null);
      return;
    }
    let stale = false;
    api
      .lint(item.id, debouncedText)
      .then((r) => !stale && setLint(r))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedText, item?.id]);

  const findings: Finding[] = edited ? (lint?.findings ?? []) : (item?.score?.findings ?? []);

  async function decide(decision: 'approve' | 'reject' | 'revise') {
    if (!item || busy) return;
    if (decision === 'revise' && note.trim().length < 5) {
      noteRef.current?.focus();
      toast.info('A revision needs a note of at least 5 characters for the writer.');
      return;
    }
    if (decision === 'approve' && edited && lint && lint.blocking > 0) {
      const ok = window.confirm(`Your edit still has ${lint.blocking} blocking problem(s). Approve anyway?`);
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.review(item.id, decision, { editedText: decision === 'approve' && edited ? text : undefined, note });
      setDone((n) => n + 1);
      toast.info(decision === 'approve' ? (edited ? 'Approved with edits' : 'Approved') : decision === 'reject' ? 'Rejected' : 'Sent back for revision');
      await load();
    } catch (e) {
      toast.error(e);
      if (e instanceof ApiError && e.conflict) await load();
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    if (!item) return;
    const next = [...skipped, item.id];
    setSkipped(next);
    await api.release(item.id).catch(() => undefined);
    await load(next);
  }

  function applySuggestion(f: Finding) {
    if (f.start === undefined || f.end === undefined || !f.suggestion) return;
    // Suggestions from the model draft's findings refer to the draft; only apply when the text still matches.
    const source = edited ? text : (item?.draft ?? '');
    setText(source.slice(0, f.start) + f.suggestion + source.slice(f.end));
  }

  useHotkeys([
    { key: 'a', description: 'approve', run: () => void decide('approve') },
    { key: 'Enter', mod: true, description: 'approve', run: () => void decide('approve') },
    { key: 'r', description: 'reject', run: () => void decide('reject') },
    { key: 'v', description: 'revise', run: () => (note.trim().length >= 5 ? void decide('revise') : noteRef.current?.focus()) },
    { key: 's', description: 'skip', run: () => void skip() },
    { key: 'e', description: 'edit', run: () => textRef.current?.focus() },
    { key: 'Escape', description: 'reset text', inInputs: true, run: () => item && setText(item.draft ?? '') },
  ]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Review</h1>
          <div className="sub">
            Worst-scoring drafts first.{done > 0 && ` ${done} decided this session.`} {skipped.length > 0 && `${skipped.length} skipped.`}
          </div>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter(filterDraft.trim());
          }}
        >
          <input type="search" placeholder="Filter, e.g. locale:fr-CA category:rugs" value={filterDraft} onChange={(e) => setFilterDraft(e.target.value)} style={{ width: 300 }} aria-label="Queue filter" />
          <button className="btn" type="submit">
            Apply
          </button>
          {filter && (
            <button className="btn ghost" type="button" onClick={() => setFilter('')}>
              Clear
            </button>
          )}
        </form>
      </div>

      <ErrorBanner error={error} onRetry={() => void load()} />

      {loading && !item && <Spinner label="Finding the next draft…" />}

      {empty && !loading && (
        <div className="card">
          <EmptyState icon="✓" title="Nothing to review">
            <p>{filter ? `No drafts match “${filter}”.` : 'New drafts appear here as soon as they are scored.'}</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn" onClick={() => void load([])}>
                Check again
              </button>
              <Link className="btn ghost" href="/queue">
                Open the queue
              </Link>
            </div>
          </EmptyState>
        </div>
      )}

      {item && (
        <div className="workspace">
          <div className="side stack">
            <section className="card">
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>
                  <Link href={`/items/${item.id}`}>{item.brief.sku}</Link>
                </h2>
                <div className="row">
                  <Tone tone="info">{item.brief.locale}</Tone>
                  <Tone tone={['baby', 'supplements', 'electrical'].includes(item.brief.category) ? 'bad' : 'muted'}>{item.brief.category}</Tone>
                  {item.variant && item.variant !== 'control' && <Tone tone="muted">{item.variant}</Tone>}
                </div>
              </div>
              {item.brief.title && <p className="muted">{item.brief.title}</p>}
              <FactsTable facts={item.brief.facts} mustMention={item.brief.mustMention} />
              {item.brief.banned.length > 0 && (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Never say: {item.brief.banned.join(', ')}
                </p>
              )}
            </section>
            <section className="card">
              <h3>Why it is here</h3>
              <ReasonsList reasons={reasons} />
            </section>
            {item.score && (
              <section className="card">
                <h3>Score</h3>
                <ScoreBreakdown score={item.score} threshold={item.routing?.threshold} />
              </section>
            )}
          </div>

          <div className="stack">
            <section className="card">
              <div className="spread">
                <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 'none' }}>
                  <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
                    Draft
                  </button>
                  <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')} disabled={!edited}>
                    Your changes{liveDiff ? ` (${changedWords(liveDiff)} words)` : ''}
                  </button>
                </div>
                <span className="muted small">
                  {wordCount(text)} words · generated {ago(item.history.find((h) => h.to === 'scored')?.at)}
                  {item.reviewNote && ' · revision'}
                </span>
              </div>
              {tab === 'edit' ? (
                <>
                  <div style={{ margin: '12px 0', padding: 12, background: 'var(--surface-2)', borderRadius: 6 }}>
                    <HighlightedText text={item.draft ?? ''} findings={item.score?.findings ?? []} comments={comments} onSelect={setAnchor} />
                  </div>
                  <textarea ref={textRef} rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-label="Final text" style={{ fontSize: 15 }} />
                </>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <DiffView ops={liveDiff} />
                </div>
              )}
              {item.reviewNote && (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Last revision note: “{item.reviewNote}”
                </p>
              )}
              <div className="actions" style={{ marginTop: 12 }}>
                <input ref={noteRef} type="text" className="grow" placeholder="Note for a revision or rejection" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
                <button className="btn primary" onClick={() => void decide('approve')} disabled={busy || !text.trim()}>
                  {edited ? 'Approve with edits' : 'Approve'}
                </button>
                <button className="btn" onClick={() => void decide('revise')} disabled={busy || note.trim().length < 5}>
                  Send back
                </button>
                <button className="btn danger" onClick={() => void decide('reject')} disabled={busy}>
                  Reject
                </button>
                <button className="btn ghost" onClick={() => void skip()} disabled={busy}>
                  Skip
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <KeyHelp
                  keys={[
                    { key: 'A', description: 'approve' },
                    { key: 'V', description: 'revise' },
                    { key: 'R', description: 'reject' },
                    { key: 'S', description: 'skip' },
                    { key: 'E', description: 'edit' },
                    { key: 'Esc', description: 'reset' },
                  ]}
                />
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h2>{edited ? 'Checks on your edit' : 'Findings'}</h2>
                {edited && lint && (
                  <div className="row">
                    {lint.fixed !== text && (
                      <button className="btn small" onClick={() => setText(lint.fixed)}>
                        Fix typography
                      </button>
                    )}
                    <Tone tone={lint.blocking ? 'bad' : 'ok'}>{lint.blocking ? `${lint.blocking} blocking` : 'No blocking problems'}</Tone>
                  </div>
                )}
              </div>
              <FindingsList findings={findings} onApply={applySuggestion} />
            </section>

            <section className="card">
              <h2>Comments</h2>
              <CommentsPanel itemId={item.id} comments={comments} draft={item.draft} anchor={anchor} onClearAnchor={() => setAnchor(null)} onChange={setComments} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
