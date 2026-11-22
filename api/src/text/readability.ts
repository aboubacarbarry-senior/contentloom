import type { Locale } from '../domain';
import { profile } from '../locales';
import { sentences, words } from './tokenize';

/**
 * Readability for the three supported languages. Each formula is a reading-ease score where higher
 * means easier (roughly 0–100). Product copy aims for 60+; under 30 reads like a legal notice.
 *
 *   English  — Flesch reading ease:   206.835 − 1.015·(words/sentences) − 84.6·(syllables/words)
 *   Spanish  — Fernández-Huerta:      206.84 − 0.60·P − 1.02·F  (P syllables, F sentences per 100 words)
 *   French   — Kandel & Moles:        207 − 1.015·(words/sentences) − 73.6·(syllables/words)
 */

const EN_VOWELS = /[aeiouy]+/g;

export function syllablesEn(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Common silent endings.
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]);
  w = w.replace(/^y/, '');
  // "-le" after a consonant (table, gentle) keeps its e above, so it already counts as a syllable.
  return Math.max(1, w.match(EN_VOWELS)?.length ?? 0);
}

const ES_STRONG = new Set(['a', 'e', 'o', 'á', 'é', 'ó', 'í', 'ú']);
const ES_VOWEL = /[aeiouáéíóúü]/;

/** Spanish syllable count from vowel nuclei, honouring diphthongs and hiatus. */
export function syllablesEs(word: string): number {
  let w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (!w) return 0;
  // The u in que/qui/gue/gui is silent.
  w = w.replace(/([qg])u([eéií])/g, '$1$2');
  // Final y after a vowel is a vowel sound inside a diphthong (hoy, muy): drop it.
  w = w.replace(/([aeiouáéíóú])y$/, '$1');
  let count = 0;
  let prev: string | null = null;
  for (const ch of w) {
    if (!ES_VOWEL.test(ch)) {
      prev = null;
      continue;
    }
    if (prev === null) {
      count++;
    } else {
      // Two vowels in a row: a hiatus (new syllable) when both are strong, or when either is an accented weak vowel.
      const hiatus = ES_STRONG.has(prev) && ES_STRONG.has(ch);
      if (hiatus) count++;
    }
    prev = ch;
  }
  return Math.max(1, count);
}

const FR_VOWEL_GROUP = /[aeiouyàâäéèêëîïôöùûüœæ]+/g;

/** French syllables from vowel groups, with the mute final e. Good enough for a readability band. */
export function syllablesFr(word: string): number {
  let w = word.toLowerCase().replace(/[^a-zàâäéèêëîïôöùûüœæç]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/([^aeiouyàâäéèêëîïôöùûü])(?:es|e)$/, '$1');
  const groups = w.match(FR_VOWEL_GROUP)?.length ?? 0;
  return Math.max(1, groups);
}

export function syllables(word: string, locale: Locale): number {
  switch (profile(locale).language) {
    case 'en':
      return syllablesEn(word);
    case 'es':
      return syllablesEs(word);
    case 'fr':
      return syllablesFr(word);
  }
}

export interface ReadabilityReport {
  formula: 'flesch' | 'fernandez-huerta' | 'kandel-moles';
  score: number;
  band: 'very easy' | 'easy' | 'fairly easy' | 'standard' | 'fairly difficult' | 'difficult' | 'very difficult';
  words: number;
  sentences: number;
  syllables: number;
  wordsPerSentence: number;
  syllablesPerWord: number;
  /** Flesch–Kincaid grade, English only. */
  grade: number | null;
  longestSentenceWords: number;
}

export function band(score: number): ReadabilityReport['band'] {
  if (score >= 90) return 'very easy';
  if (score >= 80) return 'easy';
  if (score >= 70) return 'fairly easy';
  if (score >= 60) return 'standard';
  if (score >= 50) return 'fairly difficult';
  if (score >= 30) return 'difficult';
  return 'very difficult';
}

export function readability(text: string, locale: Locale): ReadabilityReport | null {
  const ws = words(text).filter((t) => t.kind === 'word');
  const ss = sentences(text);
  if (!ws.length || !ss.length) return null;
  const syl = ws.reduce((n, w) => n + syllables(w.text, locale), 0);
  const W = ws.length;
  const S = ss.length;
  const wps = W / S;
  const spw = syl / W;
  const formula = profile(locale).readability;
  let raw: number;
  if (formula === 'flesch') raw = 206.835 - 1.015 * wps - 84.6 * spw;
  else if (formula === 'fernandez-huerta') raw = 206.84 - 0.6 * (spw * 100) - 1.02 * ((S / W) * 100);
  else raw = 207 - 1.015 * wps - 73.6 * spw;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
  const longest = Math.max(...ss.map((s) => words(s.text).length));
  return {
    formula,
    score,
    band: band(score),
    words: W,
    sentences: S,
    syllables: syl,
    wordsPerSentence: Math.round(wps * 10) / 10,
    syllablesPerWord: Math.round(spw * 100) / 100,
    grade: formula === 'flesch' ? Math.round((0.39 * wps + 11.8 * spw - 15.59) * 10) / 10 : null,
    longestSentenceWords: longest,
  };
}
