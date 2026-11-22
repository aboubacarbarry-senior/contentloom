'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DragEvent, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toasts';
import { ErrorBanner, Section, Tabs, Tone } from '../../../components/ui';
import { api, ApiError } from '../../../lib/api';
import { classes, plural, usd } from '../../../lib/format';
import { useAsync } from '../../../lib/hooks';
import { previewCsv, SAMPLE_CSV } from '../../../lib/text';
import type { Brief, CreateBatchResult } from '../../../lib/types';

type Mode = 'csv' | 'json';

const MAX_FILE = 2_000_000;

/**
 * New batch from a spreadsheet (CSV, as merchandisers export it) or pasted JSON. The file is parsed in
 * the browser first, so problems show up row by row before anything is sent.
 */
export default function NewBatchPage() {
  const router = useRouter();
  const toast = useToast();
  const meta = useAsync(() => api.meta(), []);
  const [mode, setMode] = useState<Mode>('csv');
  const [name, setName] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [serverErrors, setServerErrors] = useState<{ row: number; message: string }[]>([]);
  const [result, setResult] = useState<CreateBatchResult | null>(null);

  const preview = useMemo(() => (csv ? previewCsv(csv) : null), [csv]);
  const parsedJson = useMemo((): { briefs: Brief[] | null; error: string | null } => {
    if (!json.trim()) return { briefs: null, error: null };
    try {
      const v = JSON.parse(json);
      const briefs = Array.isArray(v) ? v : v.briefs;
      if (!Array.isArray(briefs)) return { briefs: null, error: 'expected an array of briefs, or { "briefs": [...] }' };
      return { briefs, error: null };
    } catch (e) {
      return { briefs: null, error: (e as Error).message };
    }
  }, [json]);

  const knownCategories = new Set(meta.data?.categories.map((c) => c.id) ?? []);
  const rowsOk = preview?.rows.filter((r) => r.brief) ?? [];
  const rowsBad = preview?.rows.filter((r) => !r.brief) ?? [];
  const unknownCats = [...new Set(rowsOk.map((r) => r.brief!.category).filter((c) => knownCategories.size && !knownCategories.has(c)))];
  const canSubmit = mode === 'csv' ? !!preview && !preview.fileError && rowsOk.length > 0 && rowsBad.length === 0 && rowsOk.length <= 500 : !!parsedJson.briefs?.length;

  async function readFile(f: File) {
    setError(null);
    if (f.size > MAX_FILE) {
      setError(new Error(`${f.name} is larger than 2 MB; split it into smaller batches`));
      return;
    }
    setFileName(f.name);
    setCsv(await f.text());
    if (!name) setName(f.name.replace(/\.(csv|tsv|txt)$/i, ''));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void readFile(f);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setServerErrors([]);
    try {
      const r = mode === 'csv' ? await api.importCsv(csv, name) : await api.createBatch(parsedJson.briefs!, name);
      setResult(r);
      toast.info(`Batch created with ${plural(r.itemIds.length, 'item')}`);
      if (!r.warnings.length) router.push(`/batches/${r.batchId}`);
    } catch (e) {
      setError(e as Error);
      const errs = e instanceof ApiError ? (e.details?.errors as { row: number; message: string }[] | string[] | undefined) : undefined;
      if (Array.isArray(errs)) setServerErrors(errs.map((x, i) => (typeof x === 'string' ? { row: i + 1, message: x } : x)));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="stack">
        <h1>Batch created</h1>
        <div className="card stack">
          <p>
            {plural(result.itemIds.length, 'item')} queued for generation. Estimated model cost {usd(result.estimatedCostUsd)}.
          </p>
          {result.warnings.length > 0 && (
            <>
              <h3>Worth a look ({result.warnings.length})</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>
                    {w.sku ? (
                      <strong>
                        {w.sku} ({w.locale}):{' '}
                      </strong>
                    ) : null}
                    {w.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <Link className="btn primary" href={`/batches/${result.batchId}`}>
              Open the batch
            </Link>
            <button className="btn" onClick={() => (setResult(null), setCsv(''), setFileName(null), setName(''))}>
              Upload another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>New batch</h1>
          <div className="sub">Up to 500 briefs per batch. Each SKU and locale pair becomes one item.</div>
        </div>
      </div>

      <label className="field" style={{ maxWidth: 420 }}>
        Batch name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring throws, fr-CA refresh…" maxLength={120} />
      </label>

      <Tabs<Mode>
        value={mode}
        onChange={setMode}
        tabs={[
          { id: 'csv', label: 'Spreadsheet (CSV)' },
          { id: 'json', label: 'JSON' },
        ]}
      />

      {mode === 'csv' ? (
        <>
          <div
            className={classes('dropzone', over && 'over')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <p>
              <strong>{fileName ?? 'Drop a CSV file here'}</strong>
            </p>
            <p className="small">
              Columns: <code>sku</code>, <code>locale</code>, <code>category</code>, optional <code>title</code>, <code>brand</code>, <code>must_mention</code>, <code>banned</code>, <code>keywords</code> (lists split on ; or |). Every other column is a
              product fact.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <label className="btn">
                Choose file
                <input type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
              </label>
              <button className="btn ghost" onClick={() => (setCsv(SAMPLE_CSV), setFileName('sample.csv'))}>
                Use a sample
              </button>
            </div>
          </div>

          {preview?.fileError && <div className="banner error">{preview.fileError}</div>}

          {preview && !preview.fileError && (
            <Section
              title={`Preview: ${plural(preview.rows.length, 'row')}`}
              actions={
                <>
                  {rowsBad.length > 0 && <Tone tone="bad">{plural(rowsBad.length, 'row')} with problems</Tone>}
                  {rowsOk.length > 500 && <Tone tone="bad">More than 500 rows</Tone>}
                  {unknownCats.length > 0 && <Tone tone="wait">Unknown categories: {unknownCats.join(', ')}</Tone>}
                </>
              }
              flush
            >
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>SKU</th>
                      <th>Locale</th>
                      <th>Category</th>
                      <th>Facts</th>
                      <th>Must mention</th>
                      <th>Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 500).map((r) => (
                      <tr key={r.row}>
                        <td className="muted">{r.row}</td>
                        <td>{r.brief?.sku ?? '—'}</td>
                        <td>{r.brief?.locale ?? '—'}</td>
                        <td>{r.brief?.category ?? '—'}</td>
                        <td className="small">{r.brief ? Object.keys(r.brief.facts).join(', ') : ''}</td>
                        <td className="small">{r.brief?.mustMention.join('; ')}</td>
                        <td className="small" style={{ color: 'var(--bad)' }}>
                          {r.errors.join('; ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      ) : (
        <div className="stack">
          <textarea rows={14} className="mono" placeholder='[{"sku":"THR-1","locale":"en-US","category":"textiles","facts":{"name":"Sage Throw","material":"cotton"},"mustMention":["cotton"],"banned":[]}]' value={json} onChange={(e) => setJson(e.target.value)} />
          {parsedJson.error && <div className="banner error">{parsedJson.error}</div>}
          {parsedJson.briefs && <p className="muted">{plural(parsedJson.briefs.length, 'brief')} ready.</p>}
        </div>
      )}

      <ErrorBanner error={error} />
      {serverErrors.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--bad)' }}>
          {serverErrors.slice(0, 30).map((e, i) => (
            <li key={i}>
              Row {e.row}: {e.message}
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <button className="btn primary" onClick={() => void submit()} disabled={!canSubmit || busy}>
          {busy ? 'Creating…' : 'Create batch'}
        </button>
        <Link className="btn ghost" href="/batches">
          Cancel
        </Link>
      </div>
    </div>
  );
}
