import type { Brief, Finding, Locale } from './domain';
import { ValidationError } from './errors';
import { fold, isLocale } from './locales';
import { findPhrase } from './text/tokenize';

/**
 * The terminology base the copy team maintains per locale:
 *  - forbidden: never use this term (trademark trouble, a competitor's name, a word legal dislikes).
 *  - preferred: `term` is the discouraged variant, `replacement` the house word ("email" → "courriel").
 *  - keep:      names that stay exactly as written in every locale (collection and brand names).
 */
export type TermKind = 'forbidden' | 'preferred' | 'keep';

export interface GlossaryTerm {
  id: string;
  locale: Locale | '*';
  term: string;
  kind: TermKind;
  replacement: string | null;
  note: string | null;
  caseSensitive: boolean;
  createdBy: string;
  createdAt: string;
}

export interface NewGlossaryTerm {
  locale: Locale | '*';
  term: string;
  kind: TermKind;
  replacement?: string | null;
  note?: string | null;
  caseSensitive?: boolean;
}

export function validateTerm(t: NewGlossaryTerm): NewGlossaryTerm {
  const term = t.term?.trim() ?? '';
  if (!term) throw new ValidationError('term is required');
  if (term.length > 80) throw new ValidationError('term is longer than 80 characters');
  if (t.locale !== '*' && !isLocale(t.locale)) throw new ValidationError(`unknown locale "${t.locale}"`);
  if (!['forbidden', 'preferred', 'keep'].includes(t.kind)) throw new ValidationError(`unknown kind "${t.kind}"`);
  const replacement = t.replacement?.trim() || null;
  if (t.kind === 'preferred' && !replacement) throw new ValidationError('a preferred term needs a replacement');
  if (replacement && fold(replacement) === fold(term)) throw new ValidationError('replacement is the same as the term');
  if (t.kind === 'keep' && replacement) throw new ValidationError('a keep term has no replacement');
  return { ...t, term, replacement, note: t.note?.trim() || null, caseSensitive: !!t.caseSensitive };
}

export function termsFor(terms: GlossaryTerm[], locale: Locale): GlossaryTerm[] {
  return terms.filter((t) => t.locale === '*' || t.locale === locale);
}

function occurrences(text: string, t: GlossaryTerm): { start: number; end: number }[] {
  return findPhrase(text, t.term, t.caseSensitive ? 'u' : 'iu');
}

/** Terms that matter for this brief: forbidden and preferred always, keep terms when the facts use them. */
export function relevantTerms(terms: GlossaryTerm[], brief: Brief): GlossaryTerm[] {
  const factText = [brief.title ?? '', brief.brand ?? '', ...Object.values(brief.facts)].join(' \n ');
  return termsFor(terms, brief.locale).filter((t) => t.kind !== 'keep' || findPhrase(factText, t.term, 'iu').length > 0);
}

/** Lines for the writer prompt. Sorted so the prompt is byte-stable for caching. */
export function glossaryInstructions(terms: GlossaryTerm[], brief: Brief): string[] {
  const rel = relevantTerms(terms, brief).slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.term.localeCompare(b.term));
  return rel.map((t) => {
    if (t.kind === 'forbidden') return `Never use "${t.term}"${t.replacement ? ` (use "${t.replacement}")` : ''}.`;
    if (t.kind === 'preferred') return `Write "${t.replacement}", not "${t.term}".`;
    return `Keep the name "${t.term}" exactly as written; do not translate it.`;
  });
}

export function checkGlossary(terms: GlossaryTerm[], brief: Brief, draft: string): Finding[] {
  const out: Finding[] = [];
  for (const t of relevantTerms(terms, brief)) {
    if (t.kind === 'forbidden') {
      for (const h of occurrences(draft, t)) {
        out.push({
          code: 'glossary.forbidden',
          severity: 'block',
          message: `uses the forbidden term "${draft.slice(h.start, h.end)}"${t.note ? ` (${t.note})` : ''}`,
          start: h.start,
          end: h.end,
          ...(t.replacement ? { suggestion: t.replacement } : {}),
        });
      }
    } else if (t.kind === 'preferred') {
      for (const h of occurrences(draft, t)) {
        out.push({
          code: 'glossary.preferred',
          severity: 'warn',
          message: `"${draft.slice(h.start, h.end)}" should be "${t.replacement}"`,
          start: h.start,
          end: h.end,
          suggestion: t.replacement ?? undefined,
        });
      }
    } else {
      const loose = findPhrase(draft, t.term, 'iu');
      const exact = findPhrase(draft, t.term, 'u');
      if (loose.length > exact.length) {
        const bad = loose.find((l) => !exact.some((e) => e.start === l.start))!;
        out.push({
          code: 'glossary.keep-case',
          severity: 'warn',
          message: `name written as "${draft.slice(bad.start, bad.end)}" instead of "${t.term}"`,
          start: bad.start,
          end: bad.end,
          suggestion: t.term,
        });
      } else if (!loose.length) {
        out.push({ code: 'glossary.keep-missing', severity: 'info', message: `the name "${t.term}" from the facts is not used` });
      }
    }
  }
  return out;
}

/** Replace preferred-term variants with their replacements, keeping the original's capitalisation. */
export function applyPreferred(terms: GlossaryTerm[], locale: Locale, text: string): string {
  let out = text;
  for (const t of termsFor(terms, locale)) {
    if (t.kind !== 'preferred' || !t.replacement) continue;
    const hits = occurrences(out, t).reverse();
    for (const h of hits) {
      const orig = out.slice(h.start, h.end);
      const rep = /^\p{Lu}/u.test(orig) ? t.replacement[0].toUpperCase() + t.replacement.slice(1) : t.replacement;
      out = out.slice(0, h.start) + rep + out.slice(h.end);
    }
  }
  return out;
}

/** Find conflicting entries, e.g. a term that is both forbidden and somebody's replacement. */
export function glossaryConflicts(terms: GlossaryTerm[]): string[] {
  const problems: string[] = [];
  const byLocale = new Map<string, GlossaryTerm[]>();
  for (const t of terms) {
    const k = t.locale;
    byLocale.set(k, [...(byLocale.get(k) ?? []), t]);
  }
  for (const t of terms) {
    const scope = [...(byLocale.get(t.locale) ?? []), ...(t.locale === '*' ? terms : byLocale.get('*') ?? [])];
    for (const o of scope) {
      if (o === t) continue;
      if (t.kind === 'forbidden' && o.replacement && fold(o.replacement) === fold(t.term)) {
        problems.push(`"${t.term}" is forbidden but is the replacement for "${o.term}" (${o.locale})`);
      }
      if (fold(o.term) === fold(t.term) && o.kind !== t.kind && o.id < t.id) {
        problems.push(`"${t.term}" is both ${o.kind} and ${t.kind} (${o.locale} / ${t.locale})`);
      }
    }
  }
  return [...new Set(problems)];
}
