/**
 * Tokenizers shared by the checks, readability, diffing and duplicate detection.
 * Offsets always refer to the original string so findings can be highlighted in the review app.
 */

export interface Token {
  text: string;
  start: number;
  end: number;
  kind: 'word' | 'number' | 'punct' | 'space';
}

// Letters (any script), combining marks, apostrophes and hyphens inside words.
const WORD = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/uy;
const NUMBER = /\d+(?:[.,]\d+)*(?:\/\d+)?/y;
const SPACE = /\s+/y;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    let m: RegExpExecArray | null = null;
    let kind: Token['kind'] = 'punct';
    for (const [re, k] of [
      [SPACE, 'space'],
      [WORD, 'word'],
      [NUMBER, 'number'],
    ] as const) {
      re.lastIndex = i;
      m = re.exec(text);
      if (m) {
        kind = k;
        break;
      }
    }
    if (m) {
      out.push({ text: m[0], start: i, end: i + m[0].length, kind });
      i += m[0].length;
    } else {
      // One code point of punctuation or a symbol.
      const cp = text.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      out.push({ text: text.slice(i, i + len), start: i, end: i + len, kind: 'punct' });
      i += len;
    }
  }
  return out;
}

export function words(text: string): Token[] {
  return tokenize(text).filter((t) => t.kind === 'word' || t.kind === 'number');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

// Abbreviations that end with a period but do not end a sentence.
const ABBREVIATIONS = new Set(['approx', 'dia', 'e.g', 'etc', 'i.e', 'incl', 'max', 'min', 'no', 'oz', 'lb', 'lbs', 'qty', 'vs', 'env', 'p. ex', 'sr', 'sra', 'dr', 'mr', 'mrs', 'ms', 'st', 'mme', 'm', 'cm', 'mm', 'in', 'ft']);

/**
 * Split into sentences on . ! ? (and their Spanish/French variants), keeping offsets.
 * Decimal numbers, abbreviations and dimension units ("50 x 60 in.") do not end a sentence unless a
 * capital letter follows.
 */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    // Consume runs like "?!" or "...".
    let j = i;
    while (j + 1 < n && '.!?…'.includes(text[j + 1])) j++;
    // Closing quotes or brackets belong to the sentence.
    while (j + 1 < n && '"”»)\'’'.includes(text[j + 1])) j++;
    const next = text.slice(j + 1).match(/^\s*(\S)?/);
    const nextChar = next?.[1];
    if (ch === '.' && i + 1 < n && /\d/.test(text[i + 1]) && i > 0 && /\d/.test(text[i - 1])) continue; // 2.5
    if (ch === '.' && nextChar !== undefined) {
      const before = text.slice(start, i).match(/([\p{L}.]+)$/u)?.[1]?.toLowerCase();
      if (before && ABBREVIATIONS.has(before) && !/[\p{Lu}¿¡]/u.test(nextChar)) continue;
      if (!/[\p{Lu}¿¡"“«(\d]/u.test(nextChar)) continue;
    }
    if (nextChar !== undefined && !/\s/.test(text[j + 1] ?? ' ')) continue; // "e.g." mid-token
    const raw = text.slice(start, j + 1);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), start: start + lead, end: j + 1 });
    start = j + 1;
    i = j;
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    const lead = tail.length - tail.trimStart().length;
    out.push({ text: tail.trim(), start: start + lead, end: start + lead + tail.trim().length });
  }
  return out;
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a phrase on word boundaries, Unicode-aware. JavaScript's \b only knows ASCII word characters,
 * so "algodón" would otherwise match inside "algodónes" or fail next to accented letters.
 */
export function findPhrase(text: string, phrase: string, flags = 'iu'): { start: number; end: number }[] {
  const p = phrase.trim();
  if (!p) return [];
  const body = escapeRegExp(p).replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${body}(?![\\p{L}\\p{M}\\p{N}])`, flags.includes('g') ? flags : `${flags}g`);
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length });
  return out;
}

export function containsPhrase(text: string, phrase: string): boolean {
  return findPhrase(text, phrase).length > 0;
}

/** Normalize whitespace and typographic quotes so loose comparisons ignore formatting noise. */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/[  ]/g, ' ')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Character n-grams of a normalized string (used by similarity). */
export function charNgrams(s: string, n: number): string[] {
  const t = normalizeForCompare(s);
  if (t.length <= n) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  return out;
}

/** Word n-grams ("shingles") of the lower-cased word sequence. */
export function wordShingles(s: string, n = 3): string[] {
  const ws = words(s).map((w) => w.text.toLowerCase());
  if (ws.length < n) return ws.length ? [ws.join(' ')] : [];
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(' '));
  return out;
}

/** Truncate on a word boundary for previews. */
export function preview(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
