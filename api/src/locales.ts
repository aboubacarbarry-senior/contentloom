import type { Locale } from './domain';

/**
 * Per-locale writing conventions. The writer prompt quotes the style guide; the typography and
 * number checks use the separators and spacing rules.
 */
export interface LocaleProfile {
  locale: Locale;
  language: 'en' | 'es' | 'fr';
  name: string;
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ';
  /** Preferred measurement system for copy written in this locale. */
  units: 'imperial' | 'metric' | 'both';
  /** Opening and closing quotation marks. */
  quotes: [string, string];
  /** French typography puts a (narrow) non-breaking space before ; : ! ? and inside guillemets. */
  spaceBeforeHighPunctuation: boolean;
  /** Spanish opens questions and exclamations with ¿ and ¡. */
  invertedOpeners: boolean;
  styleGuide: string[];
  /** Words and phrases that read as hype in this language. Checked case-insensitively on word boundaries. */
  hype: string[];
  /** Absolute superlatives that need support from the facts. */
  superlatives: string[];
  /** Readability formula used for the info finding. */
  readability: 'flesch' | 'fernandez-huerta' | 'kandel-moles';
  /** Words that never start a dimension unit even though they look like one ("in" the preposition). */
  falseUnits: string[];
}

export const LOCALE_PROFILES: Record<Locale, LocaleProfile> = {
  'en-US': {
    locale: 'en-US',
    language: 'en',
    name: 'US English',
    decimalSeparator: '.',
    thousandsSeparator: ',',
    units: 'imperial',
    quotes: ['“', '”'],
    spaceBeforeHighPunctuation: false,
    invertedOpeners: false,
    styleGuide: [
      'Use sentence case and the Oxford comma.',
      'Write dimensions as given in the facts, for example 50 x 60 in.',
      'Prefer concrete verbs over adjectives; one adjective per noun at most.',
      'Do not address the reader as "you guys" or use slang.',
    ],
    hype: [
      'amazing',
      'awesome',
      'incredible',
      'stunning',
      'game-changer',
      'game changer',
      'must-have',
      'must have',
      'revolutionary',
      'jaw-dropping',
      'unbeatable',
      'luxurious',
      'insanely',
      'epic',
    ],
    superlatives: ['best', 'finest', 'softest', 'strongest', 'perfect', 'ultimate', 'world-class', 'number one', '#1', 'unrivaled'],
    readability: 'flesch',
    falseUnits: ['in'],
  },
  'es-US': {
    locale: 'es-US',
    language: 'es',
    name: 'US Spanish',
    decimalSeparator: '.',
    thousandsSeparator: ',',
    units: 'both',
    quotes: ['«', '»'],
    spaceBeforeHighPunctuation: false,
    invertedOpeners: true,
    styleGuide: [
      'Usa "usted" de forma consistente, nunca "tú".',
      'Abre las preguntas y exclamaciones con ¿ y ¡.',
      'Escribe las medidas tal como aparecen en los datos; si están en pulgadas, no las conviertas.',
      'Evita anglicismos cuando exista una palabra común en español.',
    ],
    hype: ['increíble', 'espectacular', 'asombroso', 'asombrosa', 'revolucionario', 'revolucionaria', 'imprescindible', 'de lujo', 'alucinante'],
    superlatives: ['el mejor', 'la mejor', 'los mejores', 'las mejores', 'perfecto', 'perfecta', 'insuperable', 'número uno', 'el más', 'la más'],
    readability: 'fernandez-huerta',
    falseUnits: [],
  },
  'fr-CA': {
    locale: 'fr-CA',
    language: 'fr',
    name: 'Canadian French',
    decimalSeparator: ',',
    thousandsSeparator: ' ',
    units: 'metric',
    quotes: ['« ', ' »'],
    spaceBeforeHighPunctuation: true,
    invertedOpeners: false,
    styleGuide: [
      'Respecte la typographie québécoise : espace insécable avant le deux-points, et guillemets français.',
      'Vouvoie le lecteur.',
      'Écris les décimales avec une virgule (2,5 cm).',
      "Privilégie le vocabulaire de l'Office québécois de la langue française (courriel, magasiner).",
    ],
    hype: ['incroyable', 'époustouflant', 'époustouflante', 'révolutionnaire', 'génial', 'géniale', 'sensationnel', 'sensationnelle', 'luxueux', 'luxueuse'],
    superlatives: ['le meilleur', 'la meilleure', 'les meilleurs', 'parfait', 'parfaite', 'ultime', 'inégalé', 'inégalée', 'numéro un'],
    readability: 'kandel-moles',
    falseUnits: [],
  },
};

export function profile(locale: Locale): LocaleProfile {
  const p = LOCALE_PROFILES[locale];
  if (!p) throw new Error(`unsupported locale ${locale}`);
  return p;
}

export function isLocale(s: string): s is Locale {
  return Object.prototype.hasOwnProperty.call(LOCALE_PROFILES, s);
}

/**
 * Parse a number written in a locale's convention. Accepts both separators when unambiguous, so
 * "2.5" in fr-CA still reads as 2.5 (writers copy facts verbatim).
 */
export function parseLocaleNumber(raw: string, locale: Locale): number | null {
  const p = profile(locale);
  let s = raw.trim().replace(/[  ]/g, ' ');
  if (!s) return null;
  // Fractions such as 1/2 or 1 1/2.
  const frac = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(s);
  if (frac) {
    const whole = frac[1] ? Number(frac[1]) : 0;
    const den = Number(frac[3]);
    return den === 0 ? null : whole + Number(frac[2]) / den;
  }
  if (p.thousandsSeparator === ' ') s = s.replace(/(\d) (?=\d{3}\b)/g, '$1');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // Whichever comes last is the decimal separator.
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (hasComma) {
    // "1,250" is a thousands separator in en/es-US, "2,5" a decimal in fr-CA.
    const thousandsLike = /^\d{1,3}(,\d{3})+$/.test(s);
    s = p.decimalSeparator === ',' && !thousandsLike ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Format a number the way copy in this locale should show it. */
export function formatLocaleNumber(n: number, locale: Locale, maxDecimals = 2): string {
  const p = profile(locale);
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(maxDecimals).replace(/\.?0+$/, '');
  const [int, dec] = fixed.split('.');
  const neg = int.startsWith('-');
  const digits = neg ? int.slice(1) : int;
  const grouped = digits.length > 4 ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, p.thousandsSeparator === ' ' ? ' ' : p.thousandsSeparator) : digits;
  return `${neg ? '-' : ''}${grouped}${dec ? p.decimalSeparator + dec : ''}`;
}

/** Fold case and strip diacritics, so "Coton" matches "coton" and "algodón" matches "algodon". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
