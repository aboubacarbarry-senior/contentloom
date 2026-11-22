import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from './audit';
import type { Clock } from './clock';
import type { Brief, Locale } from './domain';
import { ConflictError, NotFoundError } from './errors';
import { applyPreferred, checkGlossary, glossaryConflicts, GlossaryTerm, NewGlossaryTerm, validateTerm } from './glossary';
import { fold } from './locales';
import { Store, STORE } from './repository';
import { CLOCK } from './tokens';

/**
 * Glossary CRUD plus a short-lived cache for the workers, which read the terms for every draft.
 * Edits invalidate the local cache at once; other processes pick them up within the TTL.
 */
@Injectable()
export class GlossaryService {
  private cache: { at: number; terms: GlossaryTerm[] } | null = null;
  private readonly ttlMs = 60_000;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<GlossaryTerm[]> {
    const now = this.clock.now().getTime();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.terms;
    const terms = await this.store.glossary.list();
    this.cache = { at: now, terms };
    return terms;
  }

  async forLocale(locale: Locale): Promise<GlossaryTerm[]> {
    return (await this.all()).filter((t) => t.locale === '*' || t.locale === locale);
  }

  list(locale?: Locale | '*'): Promise<GlossaryTerm[]> {
    return this.store.glossary.list(locale);
  }

  async add(input: NewGlossaryTerm, by: string): Promise<GlossaryTerm> {
    const t = validateTerm(input);
    const existing = await this.store.glossary.list(t.locale === '*' ? undefined : t.locale);
    const clash = existing.find((e) => e.locale === t.locale && fold(e.term) === fold(t.term));
    if (clash) throw new ConflictError(`"${t.term}" is already in the ${t.locale} glossary as ${clash.kind}`, { id: clash.id });
    const term: GlossaryTerm = {
      id: randomUUID(),
      locale: t.locale,
      term: t.term,
      kind: t.kind,
      replacement: t.replacement ?? null,
      note: t.note ?? null,
      caseSensitive: !!t.caseSensitive,
      createdBy: by,
      createdAt: this.clock.now().toISOString(),
    };
    const problems = glossaryConflicts([...existing, term]);
    if (problems.length) throw new ConflictError(problems[0], { problems });
    await this.store.glossary.add(term);
    this.cache = null;
    await this.audit.record(by, 'glossary.add', `glossary:${term.id}`, { locale: term.locale, term: term.term, kind: term.kind, replacement: term.replacement });
    return term;
  }

  async remove(id: string, by: string): Promise<void> {
    const t = await this.store.glossary.get(id);
    if (!t) throw new NotFoundError(`glossary term ${id} not found`);
    await this.store.glossary.remove(id);
    this.cache = null;
    await this.audit.record(by, 'glossary.remove', `glossary:${id}`, { locale: t.locale, term: t.term, kind: t.kind });
  }

  /** Preview the glossary's effect on a text: findings and the text with preferred terms applied. */
  async preview(brief: Brief, text: string) {
    const terms = await this.forLocale(brief.locale);
    return { findings: checkGlossary(terms, brief, text), fixed: applyPreferred(terms, brief.locale, text) };
  }

  /** Bulk import (e.g. from the localisation team's spreadsheet). Skips duplicates, reports errors per row. */
  async importMany(rows: NewGlossaryTerm[], by: string): Promise<{ added: number; skipped: number; errors: { row: number; message: string }[] }> {
    let added = 0;
    let skipped = 0;
    const errors: { row: number; message: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.add(rows[i], by);
        added++;
      } catch (e) {
        if (e instanceof ConflictError && /already in the/.test(e.message)) skipped++;
        else errors.push({ row: i + 1, message: (e as Error).message });
      }
    }
    return { added, skipped, errors };
  }
}
