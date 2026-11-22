'use client';
import Link from 'next/link';
import { Section, Spinner, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import type { Status } from '../../lib/types';

const FLOW: { status: Status; text: string }[] = [
  { status: 'queued', text: 'Waiting for a worker. Revisions jump the queue.' },
  { status: 'generating', text: 'The writer model is drafting and the judge is grading.' },
  { status: 'in_review', text: 'Waiting for a person: something blocked auto-approval, the score was low, or it landed in the QA sample.' },
  { status: 'auto_approved', text: 'Passed every check and scored above the threshold. Ready to publish.' },
  { status: 'approved', text: 'A reviewer approved it, possibly with edits. Ready to publish.' },
  { status: 'rejected', text: 'A reviewer rejected it. An editor can regenerate it.' },
  { status: 'published', text: 'Live. The PIM and storefront were notified by webhook.' },
  { status: 'withdrawn', text: 'Taken down after publishing (wrong data, a recall). Can be regenerated.' },
  { status: 'failed', text: 'The model failed four times, or declined. Retry from the batch page.' },
  { status: 'cancelled', text: 'Its batch was cancelled before it was published.' },
];

const SHORTCUTS: [string, string][] = [
  ['A or Ctrl+Enter', 'Approve (with your edits, if you made any)'],
  ['V', 'Send back for revision (needs a note of 5+ characters)'],
  ['R', 'Reject'],
  ['S', 'Skip to the next draft without deciding'],
  ['E', 'Jump into the text box to edit'],
  ['Esc', 'Undo your edits and go back to the model draft'],
];

const FINDING_GROUPS: { prefix: string; title: string; text: string }[] = [
  { prefix: 'fact.', title: 'Missing facts', text: 'A "must mention" phrase from the brief is not in the copy.' },
  { prefix: 'claim.', title: 'Claims', text: 'Banned claims, and health, safety, environmental, origin, warranty or pricing claims the facts do not back. Most block auto-approval.' },
  { prefix: 'units.', title: 'Measurements', text: 'A size, weight or volume that is not in the facts, or that only matches after converting units.' },
  { prefix: 'locale.', title: 'Other locales', text: 'The copy gives a different size than the same SKU in another language.' },
  { prefix: 'glossary.', title: 'Terminology', text: 'Forbidden terms, preferred house words, and names that must be kept exactly.' },
  { prefix: 'style.', title: 'Style', text: 'Hype words, unsupported superlatives, exclamation marks, capitals and repeated openings. Warnings only.' },
  { prefix: 'typography.', title: 'Typography', text: 'French spacing, Spanish ¿ ¡, quotes, decimals, and markdown or chat preambles (those block).' },
  { prefix: 'duplicate.', title: 'Near-duplicates', text: 'Almost the same as another SKU in the batch; search engines treat that as duplicate content.' },
  { prefix: 'seo.', title: 'Keywords', text: 'A requested keyword is missing, or stuffed in more than twice.' },
];

export default function HelpPage() {
  const meta = useAsync(() => api.meta(), []);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>How review works</h1>
          <div className="sub">The short version for new reviewers.</div>
        </div>
      </div>

      <div className="grid-2">
        <Section title="Your day">
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Open <Link href="/">Review</Link>. You get the worst-scoring draft first, and it is held for you so nobody else edits it at the same time.
            </li>
            <li>Read the facts on the left and the highlighted problems in the draft. Hover a highlight to see what was found.</li>
            <li>Fix small things yourself and approve. The checks re-run on your edit before you approve.</li>
            <li>
              Send it back with a note when the writer should try again (&ldquo;mention it is pre-washed&rdquo;). Reject only when the brief itself is wrong.
            </li>
            <li>Select text in the draft to leave a comment on it for the team.</li>
          </ol>
        </Section>
        <Section title="Keyboard">
          <table className="table compact">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>
            Single-key shortcuts are off while you type in a text box.
          </p>
        </Section>
      </div>

      <Section title="Why some drafts skip review">
        <p>
          A draft auto-approves only when every required fact is there, nothing blocks, the judge gave a verdict and the score clears the threshold. Regulated categories (baby, supplements, electrical) always need a person. A random share of
          drafts that would have auto-approved still comes to you: that QA sample is how we know auto-approval is safe (see <Link href="/metrics">Metrics</Link>).
        </p>
      </Section>

      <div className="grid-2">
        <Section title="Statuses">
          <table className="table compact">
            <tbody>
              {FLOW.map((f) => (
                <tr key={f.status}>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td className="small">{f.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="Findings">
          <table className="table compact">
            <tbody>
              {FINDING_GROUPS.map((g) => (
                <tr key={g.prefix}>
                  <td>
                    <strong>{g.title}</strong>
                    <div className="mono small muted">
                      <Link href={`/search?q=${encodeURIComponent(`finding:${g.prefix} status:in_review`)}`}>{g.prefix}*</Link>
                    </div>
                  </td>
                  <td className="small">{g.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <Section title="Categories">
        {!meta.data ? (
          <Spinner />
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>Category</th>
                <th>Words</th>
                <th>Facts a brief needs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {meta.data.categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.label} <span className="mono small muted">{c.id}</span>
                  </td>
                  <td>
                    {c.words[0]}–{c.words[1]}
                  </td>
                  <td className="small">{c.requiredFacts.join(', ')}</td>
                  <td>{c.regulated && <span className="badge tone-bad">always reviewed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
