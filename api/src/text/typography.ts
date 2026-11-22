import type { Finding, Locale } from '../domain';
import { profile } from '../locales';
import { findMeasurements } from './units';

/**
 * Locale typography. These are warnings with a suggested fix; `fixTypography` applies the safe ones
 * so reviewers can accept them with one click.
 */

const NBSP = ' ';
const NNBSP = ' ';

interface Rule {
  code: string;
  applies: (locale: Locale) => boolean;
  find: (text: string, locale: Locale) => Finding[];
  fix?: (text: string, locale: Locale) => string;
}

function each(re: RegExp, text: string, make: (m: RegExpMatchArray) => Finding | null): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(re)) {
    const f = make(m);
    if (f) out.push(f);
  }
  return out;
}

const RULES: Rule[] = [
  {
    code: 'typography.double-space',
    applies: () => true,
    find: (t) =>
      each(/ {2,}/g, t, (m) => ({ code: 'typography.double-space', severity: 'warn', message: 'repeated spaces', start: m.index!, end: m.index! + m[0].length, suggestion: ' ' })),
    fix: (t) => t.replace(/ {2,}/g, ' '),
  },
  {
    code: 'typography.space-before-punct',
    applies: (l) => !profile(l).spaceBeforeHighPunctuation,
    find: (t) =>
      each(/(?<=\S) +([,.;:!?])/g, t, (m) => ({
        code: 'typography.space-before-punct',
        severity: 'warn',
        message: `space before "${m[1]}"`,
        start: m.index!,
        end: m.index! + m[0].length,
        suggestion: m[1],
      })),
    fix: (t) => t.replace(/(?<=\S) +([,.;:!?])/g, '$1'),
  },
  {
    code: 'typography.fr-high-punct',
    applies: (l) => profile(l).spaceBeforeHighPunctuation,
    // French: (narrow) no-break space before ; : ! ?  — a missing or ordinary space is a warning.
    find: (t) =>
      each(/(\S)( ?)([;:!?])(?=\s|$)/g, t, (m) => {
        if (m[1] === NBSP || m[1] === NNBSP) return null;
        if (/\d/.test(m[1]) && m[3] === ':') return null; // times like 10:30
        return {
          code: 'typography.fr-high-punct',
          severity: 'warn',
          message: `needs a no-break space before "${m[3]}"`,
          start: m.index! + 1,
          end: m.index! + m[0].length,
          suggestion: `${m[3] === ':' ? NBSP : NNBSP}${m[3]}`,
        };
      }),
    fix: (t) =>
      t.replace(/(\S) ?([;:!?])(?=\s|$)/g, (all, prev: string, p: string) => {
        if (prev === NBSP || prev === NNBSP) return all;
        if (/\d/.test(prev) && p === ':') return all;
        return `${prev}${p === ':' ? NBSP : NNBSP}${p}`;
      }),
  },
  {
    code: 'typography.quotes',
    applies: () => true,
    find: (t, l) => {
      const [open, close] = profile(l).quotes;
      return each(/"([^"\n]{1,200})"/g, t, (m) => ({
        code: 'typography.quotes',
        severity: 'warn',
        message: 'straight quotation marks',
        start: m.index!,
        end: m.index! + m[0].length,
        suggestion: `${open}${m[1].trim()}${close}`,
      }));
    },
    fix: (t, l) => {
      const [open, close] = profile(l).quotes;
      return t.replace(/"([^"\n]{1,200})"/g, (_all, inner: string) => `${open}${inner.trim()}${close}`);
    },
  },
  {
    code: 'typography.es-inverted',
    applies: (l) => profile(l).invertedOpeners,
    find: (t) => {
      const out: Finding[] = [];
      for (const m of t.matchAll(/(^|[.!?…]\s+)([^¿¡.!?…]+?)([?!])/g)) {
        const body = m[2];
        const mark = m[3];
        const opener = mark === '?' ? '¿' : '¡';
        if (body.includes(opener)) continue;
        const start = m.index! + m[1].length;
        out.push({
          code: 'typography.es-inverted',
          severity: 'warn',
          message: `Spanish ${mark === '?' ? 'question' : 'exclamation'} without "${opener}"`,
          start,
          end: start + body.length + 1,
          suggestion: `${opener}${body.trim()}${mark}`,
        });
      }
      return out;
    },
  },
  {
    code: 'typography.decimal',
    applies: (l) => profile(l).decimalSeparator === ',',
    find: (t, l) =>
      findMeasurements(t, l)
        .filter((m) => /\d\.\d/.test(m.text))
        .map((m) => ({
          code: 'typography.decimal',
          severity: 'warn' as const,
          message: `decimal point in "${m.text.trim()}"; ${profile(l).name} uses a comma`,
          start: m.start,
          end: m.end,
          suggestion: m.text.trim().replace(/(\d)\.(\d)/g, '$1,$2'),
        })),
    fix: (t, l) => {
      let out = t;
      for (const m of findMeasurements(t, l).reverse()) {
        if (!/\d\.\d/.test(m.text)) continue;
        out = out.slice(0, m.start) + m.text.replace(/(\d)\.(\d)/g, '$1,$2') + out.slice(m.end);
      }
      return out;
    },
  },
  {
    code: 'typography.ellipsis',
    applies: () => true,
    find: (t) =>
      each(/\.{3}/g, t, (m) => ({ code: 'typography.ellipsis', severity: 'info', message: 'three dots instead of an ellipsis', start: m.index!, end: m.index! + 3, suggestion: '…' })),
    fix: (t) => t.replace(/\.{3}/g, '…'),
  },
  {
    code: 'typography.trailing',
    applies: () => true,
    find: (t) => {
      const trimmed = t.trimEnd();
      if (!trimmed) return [];
      const last = trimmed[trimmed.length - 1];
      if ('.!?…»”"'.includes(last)) return [];
      return [{ code: 'typography.trailing', severity: 'warn', message: 'does not end with a full stop', start: trimmed.length - 1, end: trimmed.length }];
    },
  },
  {
    code: 'typography.markup',
    applies: () => true,
    // Models sometimes return markdown or a preamble; copy goes straight into a product page.
    find: (t) => {
      const out: Finding[] = [];
      for (const m of t.matchAll(/(\*\*[^*]+\*\*|^#{1,6}\s|^\s*[-*•]\s|`[^`]+`|<\/?[a-z][^>]*>)/gim)) {
        out.push({ code: 'typography.markup', severity: 'block', message: `formatting markup "${m[0].trim().slice(0, 20)}" in plain-text copy`, start: m.index!, end: m.index! + m[0].length });
      }
      const preamble = /^(?:here(?:'s| is) (?:a|the|your)|sure[,!]|certainly[,!]|aquí tiene|voici)/i.exec(t.trim());
      if (preamble) out.push({ code: 'typography.preamble', severity: 'block', message: `starts with a chat preamble ("${preamble[0]}")`, start: 0, end: preamble[0].length });
      return out;
    },
  },
];

export function checkTypography(text: string, locale: Locale): Finding[] {
  return RULES.filter((r) => r.applies(locale)).flatMap((r) => r.find(text, locale));
}

/** Apply every rule that has a safe automatic fix. Idempotent. */
export function fixTypography(text: string, locale: Locale): string {
  let out = text;
  for (const r of RULES) if (r.fix && r.applies(locale)) out = r.fix(out, locale);
  return out;
}

export const TYPOGRAPHY_CODES = RULES.map((r) => r.code);
