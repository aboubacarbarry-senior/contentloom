import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { verifySignature } from './outbox';

/**
 * `contentloom` command-line client for operators and scripts. It talks to a running API over HTTP,
 * identifying as CONTENTLOOM_USER with CONTENTLOOM_ROLES (behind the gateway, use a service account).
 *
 *   node dist/src/cli.js import briefs.csv --name "Spring throws" [--wait]
 *   node dist/src/cli.js status <batchId>
 *   node dist/src/cli.js export --locale fr-CA --format csv --out fr.csv
 *   node dist/src/cli.js queue [--q "category:baby"]
 *   node dist/src/cli.js metrics
 *   node dist/src/cli.js glossary-import terms.csv
 *   node dist/src/cli.js verify --secret S --header 't=…,v1=…' --body payload.json
 */

export interface ParsedArgs {
  command: string | null;
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { command: positional.shift() ?? null, positional, flags };
}

export function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** Fixed-width table for terminal output. */
export function table(rows: (string | number | null | undefined)[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const cells = all.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length))) ?? [];
  const line = (r: string[]) => r.map((c, i) => (/^-?[\d.,$%]+$/.test(c) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  const out = cells.map(line);
  if (header) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return out.join('\n');
}

export class ApiClient {
  constructor(
    readonly base: string,
    private readonly user: string,
    private readonly roles: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; headers: Headers }> {
    const res = await this.fetchFn(`${this.base.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': this.user, 'x-roles': this.roles },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (exports) */
    }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : text || res.statusText;
      throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }
}

interface Summary {
  batch: { id: string; name: string; cancelledAt: string | null };
  counts: Record<string, number>;
  total: number;
  generated: number;
  done: boolean;
  costUsd: number;
  meanScore: number | null;
}

function printSummary(s: Summary): string {
  const counts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => [k, n]);
  return [
    `${s.batch.name} (${s.batch.id})${s.batch.cancelledAt ? ' — cancelled' : s.done ? ' — done' : ''}`,
    `${s.total} items, ${(s.generated * 100).toFixed(0)}% generated, mean score ${s.meanScore ?? '—'}, cost $${s.costUsd.toFixed(4)}`,
    table(counts, ['status', 'items']),
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(argv: string[], env: Record<string, string | undefined>, out: (s: string) => void, fetchFn: typeof fetch = fetch): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const api = new ApiClient(env.CONTENTLOOM_API ?? 'http://localhost:3001', env.CONTENTLOOM_USER ?? 'cli', env.CONTENTLOOM_ROLES ?? 'editor,reviewer,publisher,admin', fetchFn);

  switch (command) {
    case 'import': {
      const file = positional[0];
      if (!file) throw new Error('usage: import <file.csv> [--name NAME] [--wait]');
      const csv = readFileSync(file, 'utf8');
      const { data } = await api.call<{ batchId: string; itemIds: string[]; warnings: { sku: string; locale: string; message: string }[]; estimatedCostUsd: number }>('POST', '/batches/csv', {
        csv,
        name: str(flags, 'name') ?? basename(file).replace(/\.\w+$/, ''),
      });
      out(`batch ${data.batchId}: ${data.itemIds.length} items queued, estimated $${data.estimatedCostUsd.toFixed(2)}`);
      for (const w of data.warnings.slice(0, 20)) out(`  warning ${w.sku ? `${w.sku} ${w.locale}: ` : ''}${w.message}`);
      if (data.warnings.length > 20) out(`  … and ${data.warnings.length - 20} more warnings`);
      if (flags.wait) return run(['wait', data.batchId], env, out, fetchFn);
      return 0;
    }
    case 'status': {
      const id = positional[0];
      if (!id) throw new Error('usage: status <batchId>');
      out(printSummary((await api.call<Summary>('GET', `/batches/${id}`)).data));
      return 0;
    }
    case 'wait': {
      const id = positional[0];
      if (!id) throw new Error('usage: wait <batchId> [--timeout SECONDS]');
      const deadline = Date.now() + Number(str(flags, 'timeout') ?? 1800) * 1000;
      for (;;) {
        const s = (await api.call<Summary>('GET', `/batches/${id}`)).data;
        if (s.generated >= 1 || s.batch.cancelledAt) {
          out(printSummary(s));
          return s.counts.failed ? 2 : 0;
        }
        if (Date.now() > deadline) {
          out(`timed out at ${(s.generated * 100).toFixed(0)}% generated`);
          return 3;
        }
        await sleep(Number(str(flags, 'interval') ?? 5) * 1000);
      }
    }
    case 'export': {
      const params = new URLSearchParams();
      for (const k of ['locale', 'format', 'batch', 'since', 'category']) {
        const v = str(flags, k);
        if (v) params.set(k, v);
      }
      const kind = flags.reviews ? 'reviews' : 'published';
      const { data, headers } = await api.call<string>('GET', `/exports/${kind}?${params}`);
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const file = str(flags, 'out');
      if (file) {
        writeFileSync(file, body);
        out(`wrote ${headers.get('x-row-count') ?? '?'} rows to ${file}`);
      } else out(body);
      return 0;
    }
    case 'queue': {
      const q = str(flags, 'q');
      const { data } = await api.call<{ item: { id: string; brief: { sku: string; locale: string; category: string }; score: { total: number } | null }; reasons: string[]; leasedBy: string | null }[]>(
        'GET',
        `/review/queue?limit=${Number(str(flags, 'limit') ?? 20)}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      );
      if (!data.length) out('the review queue is empty');
      else
        out(
          table(
            data.map((e) => [e.item.brief.sku, e.item.brief.locale, e.item.brief.category, e.item.score?.total.toFixed(2), e.leasedBy ?? '', e.reasons.join('; ').slice(0, 60)]),
            ['sku', 'locale', 'category', 'score', 'held by', 'reasons'],
          ),
        );
      return 0;
    }
    case 'metrics': {
      const { data: m } = await api.call<{
        total: number;
        inReview: number;
        published: number;
        autoApprovePrecision: number | null;
        autoApprovePrecisionCi: { low: number; high: number } | null;
        qaSample: { decided: number };
        cost: { totalUsd: number; today: { spentUsd: number; limitUsd: number | null } };
      }>('GET', '/metrics');
      const p = m.autoApprovePrecision === null ? 'n/a' : `${(m.autoApprovePrecision * 100).toFixed(1)}%`;
      const ci = m.autoApprovePrecisionCi ? ` (95% CI ${(m.autoApprovePrecisionCi.low * 100).toFixed(0)}–${(m.autoApprovePrecisionCi.high * 100).toFixed(0)}%, n=${m.qaSample.decided})` : '';
      out(
        table([
          ['items', m.total],
          ['in review', m.inReview],
          ['published', m.published],
          ['auto-approve precision', `${p}${ci}`],
          ['total cost', `$${m.cost.totalUsd.toFixed(2)}`],
          ['spent today', `$${m.cost.today.spentUsd.toFixed(2)}${m.cost.today.limitUsd !== null ? ` of $${m.cost.today.limitUsd.toFixed(2)}` : ''}`],
        ]),
      );
      return 0;
    }
    case 'glossary-import': {
      const file = positional[0];
      if (!file) throw new Error('usage: glossary-import <terms.csv>');
      const { parseCsvObjects } = await import('./text/csv');
      const { records } = parseCsvObjects(readFileSync(file, 'utf8'));
      const terms = records.map((r) => ({ locale: r.locale, term: r.term, kind: r.kind, replacement: r.replacement || undefined, note: r.note || undefined }));
      const { data } = await api.call<{ added: number; skipped: number; errors: { row: number; message: string }[] }>('POST', '/glossary/import', { terms });
      out(`${data.added} added, ${data.skipped} already present`);
      for (const e of data.errors) out(`  row ${e.row + 1}: ${e.message}`);
      return data.errors.length ? 2 : 0;
    }
    case 'verify': {
      const secret = str(flags, 'secret') ?? env.WEBHOOK_SECRET;
      const header = str(flags, 'header');
      const bodyFile = str(flags, 'body');
      if (!secret || !header || !bodyFile) throw new Error('usage: verify --secret S --header "t=…,v1=…" --body payload.json [--now UNIX]');
      const ok = verifySignature(secret, header, readFileSync(bodyFile, 'utf8'), Number(str(flags, 'now') ?? Math.floor(Date.now() / 1000)));
      out(ok ? 'signature ok' : 'signature INVALID');
      return ok ? 0 : 1;
    }
    case 'help':
    case null:
      out(
        [
          'usage: contentloom <command> [options]',
          '',
          '  import <file.csv> [--name N] [--wait]   create a batch from a spreadsheet',
          '  status <batchId>                        batch progress',
          '  wait <batchId> [--timeout S]            block until generation finishes',
          '  export [--locale L] [--format csv|jsonl] [--batch ID] [--since DATE] [--reviews] [--out FILE]',
          '  queue [--q QUERY] [--limit N]           drafts waiting for review',
          '  metrics                                 precision, backlog and cost',
          '  glossary-import <terms.csv>             add glossary terms',
          '  verify --secret S --header H --body F   check a webhook signature',
          '',
          'environment: CONTENTLOOM_API, CONTENTLOOM_USER, CONTENTLOOM_ROLES',
        ].join('\n'),
      );
      return 0;
    default:
      throw new Error(`unknown command "${command}"; try "help"`);
  }
}

if (require.main === module) {
  run(process.argv.slice(2), process.env, (s) => console.log(s))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
