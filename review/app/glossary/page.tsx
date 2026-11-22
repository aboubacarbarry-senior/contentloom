'use client';
import { FormEvent, useMemo, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { ConfirmButton, EmptyState, ErrorBanner, Section, Spinner, Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { parseCsv } from '../../lib/text';
import type { GlossaryTerm } from '../../lib/types';

const KIND_HELP: Record<GlossaryTerm['kind'], string> = {
  forbidden: 'Never used. Blocks auto-approval when a draft contains it.',
  preferred: 'The house word: drafts using the variant get a warning and a one-click fix.',
  keep: 'Names kept exactly as written in every locale (collections, brands).',
};

const LOCALE_OPTIONS = ['*', 'en-US', 'es-US', 'fr-CA'];

export default function GlossaryPage() {
  const toast = useToast();
  const [locale, setLocale] = useState('');
  const [filter, setFilter] = useState('');
  const terms = useAsync(() => api.glossary(locale || undefined), [locale]);
  const [form, setForm] = useState({ locale: 'en-US', term: '', kind: 'forbidden' as GlossaryTerm['kind'], replacement: '', note: '', caseSensitive: false });
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<{ added: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (terms.data ?? []).filter((t) => !f || t.term.toLowerCase().includes(f) || (t.replacement ?? '').toLowerCase().includes(f));
  }, [terms.data, filter]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.addTerm({ ...form, replacement: form.replacement || undefined, note: form.note || undefined });
      toast.info(`Added “${form.term}”`);
      setForm({ ...form, term: '', replacement: '', note: '' });
      await terms.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: GlossaryTerm) {
    try {
      await api.removeTerm(t.id);
      terms.setData((d) => (d ? d.filter((x) => x.id !== t.id) : d));
      toast.info(`Removed “${t.term}”`);
    } catch (err) {
      toast.error(err);
    }
  }

  async function runImport() {
    try {
      const rows = parseCsv(importText);
      const [head, ...body] = rows;
      const idx = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n);
      const [li, ti, ki, ri, ni] = ['locale', 'term', 'kind', 'replacement', 'note'].map(idx);
      if (li < 0 || ti < 0 || ki < 0) throw new Error('the CSV needs locale, term and kind columns');
      const list = body.map((r) => ({
        locale: r[li].trim(),
        term: r[ti].trim(),
        kind: r[ki].trim() as GlossaryTerm['kind'],
        replacement: ri >= 0 ? r[ri]?.trim() || undefined : undefined,
        note: ni >= 0 ? r[ni]?.trim() || undefined : undefined,
      }));
      const res = await api.importTerms(list);
      setImportResult(res);
      await terms.reload();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Glossary</h1>
          <div className="sub">House terminology the writer is told about and the checks enforce. Changes apply to drafts generated from now on.</div>
        </div>
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)' }}>
        <Section
          title={`Terms${terms.data ? ` (${terms.data.length})` : ''}`}
          actions={
            <>
              <input type="search" placeholder="Find" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 140 }} />
              <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Locale">
                <option value="">All locales</option>
                {LOCALE_OPTIONS.filter((l) => l !== '*').map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </>
          }
          flush
        >
          <ErrorBanner error={terms.error} onRetry={terms.reload} />
          {!terms.data && !terms.error && (
            <div style={{ padding: 16 }}>
              <Spinner />
            </div>
          )}
          {terms.data && shown.length === 0 && <EmptyState title="No terms" />}
          {shown.length > 0 && (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Kind</th>
                  <th>Use instead</th>
                  <th>Locale</th>
                  <th>Note</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.term}</strong>
                      {t.caseSensitive && <span className="muted small"> (case-sensitive)</span>}
                    </td>
                    <td>
                      <Tone tone={t.kind === 'forbidden' ? 'bad' : t.kind === 'preferred' ? 'wait' : 'info'}>{t.kind}</Tone>
                    </td>
                    <td>{t.replacement ?? <span className="muted">—</span>}</td>
                    <td>{t.locale === '*' ? 'all' : t.locale}</td>
                    <td className="small">{t.note}</td>
                    <td className="small muted" title={t.createdAt}>
                      {dateTime(t.createdAt)} by {t.createdBy}
                    </td>
                    <td>
                      <ConfirmButton label="Remove" confirmLabel="Remove" danger onConfirm={() => remove(t)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <div className="stack">
          <Section title="Add a term">
            <form className="stack" onSubmit={add}>
              <div className="row">
                <label className="field">
                  Locale
                  <select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
                    {LOCALE_OPTIONS.map((l) => (
                      <option key={l} value={l}>
                        {l === '*' ? 'All locales' : l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Kind
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as GlossaryTerm['kind'] })}>
                    <option value="forbidden">Forbidden</option>
                    <option value="preferred">Preferred replacement</option>
                    <option value="keep">Keep as written</option>
                  </select>
                </label>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {KIND_HELP[form.kind]}
              </p>
              <label className="field">
                {form.kind === 'preferred' ? 'Variant to avoid' : 'Term'}
                <input type="text" required maxLength={80} value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} />
              </label>
              {form.kind !== 'keep' && (
                <label className="field">
                  {form.kind === 'preferred' ? 'House word' : 'Suggested replacement (optional)'}
                  <input type="text" maxLength={80} required={form.kind === 'preferred'} value={form.replacement} onChange={(e) => setForm({ ...form, replacement: e.target.value })} />
                </label>
              )}
              <label className="field">
                Note (shown to reviewers)
                <input type="text" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </label>
              <label className="row small">
                <input type="checkbox" checked={form.caseSensitive} onChange={(e) => setForm({ ...form, caseSensitive: e.target.checked })} /> Case-sensitive
              </label>
              <div>
                <button className="btn primary" type="submit" disabled={busy || !form.term.trim()}>
                  {busy ? 'Adding…' : 'Add term'}
                </button>
              </div>
            </form>
          </Section>

          <Section title="Import from CSV">
            <p className="small muted">
              Columns <code>locale</code>, <code>term</code>, <code>kind</code>, optional <code>replacement</code> and <code>note</code>. Existing terms are skipped.
            </p>
            <textarea rows={5} className="mono" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'locale,term,kind,replacement\nfr-CA,email,preferred,courriel'} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => void runImport()} disabled={!importText.trim()}>
                Import
              </button>
              {importResult && (
                <span className="small">
                  {importResult.added} added, {importResult.skipped} skipped{importResult.errors.length ? `, ${importResult.errors.length} errors` : ''}
                </span>
              )}
            </div>
            {importResult?.errors.length ? (
              <ul className="small" style={{ color: 'var(--bad)', paddingLeft: 18 }}>
                {importResult.errors.map((e) => (
                  <li key={e.row}>
                    Row {e.row + 1}: {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}
