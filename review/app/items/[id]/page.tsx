'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CommentsPanel, ScoreBreakdown, Timeline, UsageLine } from '../../../components/ItemPanels';
import { DiffView, FactsTable, FindingsList, HighlightedText, ReasonsList } from '../../../components/TextViews';
import { useToast } from '../../../components/Toasts';
import { ConfirmButton, ErrorBanner, Section, Spinner, StatusBadge, Tabs, Tone } from '../../../components/ui';
import { api } from '../../../lib/api';
import { dateTime, pct, shortId } from '../../../lib/format';
import { useAsync, useEvents } from '../../../lib/hooks';
import type { Item, ItemView } from '../../../lib/types';

type Tab = 'final' | 'changes' | 'revisions';

/** Everything about one item: the copy, how it scored, what happened to it, and the actions left. */
export default function ItemPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const toast = useToast();
  const view = useAsync(() => api.view(id), [id]);
  const [tab, setTab] = useState<Tab>('final');
  const [anchor, setAnchor] = useState<{ start: number; end: number } | null>(null);

  useEvents(['item.status', 'item.comment'], (e) => {
    if ('itemId' in e && e.itemId === id) void view.reload();
  });

  async function act(label: string, fn: () => Promise<Item>) {
    try {
      const item = await fn();
      toast.info(`${label}: now ${item.status.replace('_', ' ')}`);
      await view.reload();
    } catch (e) {
      toast.error(e);
    }
  }

  if (view.error) return <ErrorBanner error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Spinner label="Loading…" />;
  const v: ItemView = view.data;
  const item = v.item;
  const modelRevisions = (item.revisions ?? []).filter((r) => r.source === 'model');
  const final = item.finalText ?? item.draft ?? '';

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{item.brief.sku}</h1>
            <StatusBadge status={item.status} />
            <Tone tone="info">{item.brief.locale}</Tone>
            <Tone tone="muted">{item.brief.category}</Tone>
            {item.variant && item.variant !== 'control' && <Tone tone="muted">variant {item.variant}</Tone>}
          </div>
          <div className="sub small">
            <Link href={`/skus/${encodeURIComponent(item.brief.sku)}`}>All locales</Link> · Item <span className="mono">{shortId(item.id)}</span> in batch <Link href={`/batches/${item.batchId}`}>{shortId(item.batchId)}</Link> · created {dateTime(item.createdAt)} · {item.attempts} attempt
            {item.attempts === 1 ? '' : 's'}
          </div>
        </div>
        <div className="row">
          {item.status === 'in_review' && (
            <Link className="btn primary" href="/">
              Review in workspace
            </Link>
          )}
          {(item.status === 'approved' || item.status === 'auto_approved') && (
            <>
              <button className="btn primary" onClick={() => void act('Published', () => api.publish(item.id))}>
                Publish
              </button>
              <ConfirmButton label="Reopen review" reason reasonPlaceholder="What needs another look?" onConfirm={(r) => act('Reopened', () => api.reopen(item.id, r))} />
            </>
          )}
          {item.status === 'published' && <ConfirmButton label="Withdraw" danger reason reasonPlaceholder="Why take it down?" onConfirm={(r) => act('Withdrawn', () => api.withdraw(item.id, r))} />}
          {['failed', 'rejected', 'withdrawn'].includes(item.status) && (
            <ConfirmButton label="Regenerate" confirmLabel="Queue it" reason reasonPlaceholder="Optional note for the writer" minReason={0} onConfirm={(r) => act('Queued', () => api.regenerate(item.id, r))} />
          )}
        </div>
      </div>

      {item.lastError && <div className="banner error">Last error: {item.lastError}</div>}
      {item.lease && Date.parse(item.lease.expiresAt) > Date.now() && <div className="banner warn">Being reviewed by {item.lease.reviewer}.</div>}

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' }}>
        <div className="stack">
          <section className="card">
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'final', label: item.finalText ? 'Final text' : 'Draft' },
                { id: 'changes', label: `Reviewer edits${v.edits ? ` (${pct(v.edits.editRatio)})` : ''}` },
                { id: 'revisions', label: `Model revisions (${modelRevisions.length})` },
              ]}
            />
            {tab === 'final' &&
              (final ? (
                <HighlightedText text={final} findings={item.finalText && item.finalText !== item.draft ? [] : (item.score?.findings ?? [])} comments={v.comments} onSelect={setAnchor} />
              ) : (
                <p className="muted">No text yet.</p>
              ))}
            {tab === 'changes' && (
              <>
                <DiffView ops={v.diff} empty="The reviewer approved the draft as written." />
                {v.edits && (
                  <p className="small muted" style={{ marginTop: 8 }}>
                    {v.edits.wordsDeleted} words removed, {v.edits.wordsInserted} added ({v.edits.wordsBefore} → {v.edits.wordsAfter}).
                  </p>
                )}
              </>
            )}
            {tab === 'revisions' && (
              <div className="stack">
                {v.revisionDiff && (
                  <>
                    <h3>Latest regeneration</h3>
                    <DiffView ops={v.revisionDiff} />
                  </>
                )}
                {(item.revisions ?? [])
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <div key={i} className="comment">
                      <div className="spread small">
                        <strong>{r.source === 'model' ? 'Model draft' : 'Reviewer edit'}</strong>
                        <span className="muted">{dateTime(r.at)}</span>
                      </div>
                      {r.note && <blockquote>{r.note}</blockquote>}
                      <div className="copy" style={{ fontSize: 14 }}>
                        {r.text}
                      </div>
                    </div>
                  ))}
                {!item.revisions?.length && <p className="muted">No drafts yet.</p>}
              </div>
            )}
          </section>

          <Section title="Findings">
            <FindingsList findings={item.score?.findings ?? []} />
          </Section>

          <Section title="Comments">
            <CommentsPanel itemId={item.id} comments={v.comments} draft={final} anchor={anchor} onClearAnchor={() => setAnchor(null)} onChange={(c) => view.setData((d) => (d ? { ...d, comments: c } : d))} />
          </Section>
        </div>

        <div className="stack">
          <Section title="Brief">
            <FactsTable facts={item.brief.facts} mustMention={item.brief.mustMention} />
            <div className="small muted" style={{ marginTop: 8 }}>
              {item.brief.mustMention.length > 0 && <div>Must mention: {item.brief.mustMention.join(', ')}</div>}
              {item.brief.banned.length > 0 && <div>Never say: {item.brief.banned.join(', ')}</div>}
              {item.brief.keywords?.length ? <div>Keywords: {item.brief.keywords.join(', ')}</div> : null}
            </div>
          </Section>
          {item.score && (
            <Section title="Score">
              <ScoreBreakdown score={item.score} threshold={item.routing?.threshold} />
            </Section>
          )}
          <Section title="Routing">
            <ReasonsList reasons={v.reasons} />
            {item.routing?.sampled && <p className="small muted">This draft is part of the QA sample that measures auto-approve precision.</p>}
          </Section>
          <Section title="History">
            <Timeline history={item.history} />
            <UsageLine usage={item.usage} />
          </Section>
        </div>
      </div>
    </div>
  );
}
