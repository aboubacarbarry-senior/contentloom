import { Inject, Injectable } from '@nestjs/common';
import type { Item, Locale, Status } from './domain';
import { LOCALES } from './domain';
import { NotFoundError } from './errors';
import { profile } from './locales';
import { Store, STORE } from './repository';
import { findMeasurements, Measurement, sameQuantity } from './text/units';

/**
 * Cross-locale consistency. The same SKU is written separately for each locale, so nothing stops the
 * French copy saying 127 x 180 cm while the English says 50 x 60 in. This compares the locales of one
 * SKU with each other: measurements in the copy, measurements in the facts, and which locales exist.
 */

export interface LocaleVersion {
  locale: Locale;
  itemId: string;
  status: Status;
  /** The text a shopper would see: final text when there is one, otherwise the latest draft. */
  text: string | null;
  source: 'final' | 'draft' | 'none';
  score: number | null;
  updatedAt: string | null;
}

export type IssueKind = 'copy-measurement' | 'fact-measurement' | 'missing-locale' | 'status-gap';

export interface ConsistencyIssue {
  kind: IssueKind;
  severity: 'block' | 'warn' | 'info';
  locales: Locale[];
  message: string;
}

export interface SkuOverview {
  sku: string;
  versions: LocaleVersion[];
  issues: ConsistencyIssue[];
}

/** Pick the item that represents a locale: published beats approved beats anything newer. */
export function representative(items: Item[]): Item | null {
  const rank: Partial<Record<Status, number>> = { published: 0, approved: 1, auto_approved: 1, in_review: 2, rejected: 3, withdrawn: 4, failed: 5, cancelled: 6 };
  return (
    items.slice().sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null
  );
}

export function versionOf(item: Item): LocaleVersion {
  const text = item.finalText ?? item.draft;
  return {
    locale: item.brief.locale,
    itemId: item.id,
    status: item.status,
    text,
    source: item.finalText ? 'final' : item.draft ? 'draft' : 'none',
    score: item.score?.total ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

function describe(ms: Measurement[]): string {
  return ms.map((m) => m.text.trim()).join(', ');
}

/**
 * Measurements of one dimension in `a` that have no counterpart in `b` (after unit conversion).
 * Each side is only compared on dimensions both sides mention, so a locale that leaves out the weight
 * is not an inconsistency here (the must-mention check covers omissions).
 */
export function unmatched(a: Measurement[], b: Measurement[]): Measurement[] {
  return a.filter((m) => {
    const same = b.filter((x) => x.unit.dimension === m.unit.dimension);
    return same.length > 0 && !same.some((x) => sameQuantity(m, x) || sameQuantity(x, m));
  });
}

export function compareVersions(items: Item[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const byLocale = new Map<Locale, Item>();
  for (const i of items) byLocale.set(i.brief.locale, i);
  const present = [...byLocale.keys()];

  for (let x = 0; x < present.length; x++) {
    for (let y = x + 1; y < present.length; y++) {
      const la = present[x];
      const lb = present[y];
      const a = byLocale.get(la)!;
      const b = byLocale.get(lb)!;

      // Facts: merchandisers sometimes give each locale a different size.
      const fa = Object.values(a.brief.facts).flatMap((v) => findMeasurements(v, la));
      const fb = Object.values(b.brief.facts).flatMap((v) => findMeasurements(v, lb));
      const badFacts = unmatched(fa, fb);
      if (badFacts.length) {
        issues.push({
          kind: 'fact-measurement',
          severity: 'block',
          locales: [la, lb],
          message: `facts disagree: ${la} gives ${describe(badFacts)}, ${lb} gives ${describe(fb.filter((m) => badFacts.some((x) => x.unit.dimension === m.unit.dimension)))}`,
        });
      }

      const ta = a.finalText ?? a.draft;
      const tb = b.finalText ?? b.draft;
      if (!ta || !tb) continue;
      const ma = findMeasurements(ta, la);
      const mb = findMeasurements(tb, lb);
      const bad = unmatched(ma, mb);
      if (bad.length) {
        issues.push({
          kind: 'copy-measurement',
          severity: 'block',
          locales: [la, lb],
          message: `${la} copy says ${describe(bad)} but ${lb} copy says ${describe(mb.filter((m) => bad.some((x) => x.unit.dimension === m.unit.dimension)))}`,
        });
      }
    }
  }

  const missing = LOCALES.filter((l) => !byLocale.has(l));
  if (present.length && missing.length) {
    issues.push({ kind: 'missing-locale', severity: 'info', locales: missing, message: `no copy for ${missing.map((l) => profile(l).name).join(', ')}` });
  }
  const published = present.filter((l) => byLocale.get(l)!.status === 'published');
  const unpublished = present.filter((l) => byLocale.get(l)!.status !== 'published');
  if (published.length && unpublished.length) {
    issues.push({
      kind: 'status-gap',
      severity: 'warn',
      locales: unpublished,
      message: `published in ${published.join(', ')} but not in ${unpublished.join(', ')}`,
    });
  }
  return issues;
}

@Injectable()
export class ConsistencyService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  async sku(sku: string): Promise<SkuOverview> {
    const all: Item[] = [];
    for await (const i of this.store.items.scan({ sku })) all.push(i);
    if (!all.length) throw new NotFoundError(`no items for SKU ${sku}`);
    const byLocale = new Map<Locale, Item[]>();
    for (const i of all) byLocale.set(i.brief.locale, [...(byLocale.get(i.brief.locale) ?? []), i]);
    const reps = [...byLocale.values()].map(representative).filter((x): x is Item => !!x);
    reps.sort((a, b) => LOCALES.indexOf(a.brief.locale) - LOCALES.indexOf(b.brief.locale));
    return { sku: reps[0]?.brief.sku ?? sku, versions: reps.map(versionOf), issues: compareVersions(reps) };
  }

  /**
   * SKUs (optionally under a prefix) with their locale coverage and issue counts, for the overview list.
   * Bounded so one call can't scan the whole catalogue.
   */
  async list(prefix = '', limit = 100): Promise<{ sku: string; locales: Locale[]; statuses: Partial<Record<Locale, Status>>; issues: number; blocking: number }[]> {
    const groups = new Map<string, Item[]>();
    for await (const i of this.store.items.scan(prefix ? { sku: `${prefix}*` } : {})) {
      const key = i.brief.sku.toLowerCase();
      const g = groups.get(key);
      if (g) g.push(i);
      else {
        if (groups.size >= limit) continue;
        groups.set(key, [i]);
      }
    }
    return [...groups.values()]
      .map((items) => {
        const byLocale = new Map<Locale, Item[]>();
        for (const i of items) byLocale.set(i.brief.locale, [...(byLocale.get(i.brief.locale) ?? []), i]);
        const reps = [...byLocale.values()].map(representative).filter((x): x is Item => !!x);
        const issues = compareVersions(reps);
        return {
          sku: items[0].brief.sku,
          locales: reps.map((r) => r.brief.locale).sort((a, b) => LOCALES.indexOf(a) - LOCALES.indexOf(b)),
          statuses: Object.fromEntries(reps.map((r) => [r.brief.locale, r.status])) as Partial<Record<Locale, Status>>,
          issues: issues.filter((x) => x.kind !== 'missing-locale').length,
          blocking: issues.filter((x) => x.severity === 'block').length,
        };
      })
      .sort((a, b) => b.blocking - a.blocking || a.sku.localeCompare(b.sku));
  }
}
