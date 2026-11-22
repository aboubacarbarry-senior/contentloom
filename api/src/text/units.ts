import type { Finding, Locale } from '../domain';
import { parseLocaleNumber, profile } from '../locales';

/**
 * Measurements in product copy: "50 x 60 in", "3,5 kg", "12-inch", "750 ml", "40 W".
 * The checker makes sure every measurement the model writes is backed by a fact, after unit
 * conversion, so a hallucinated size or weight never auto-publishes.
 */

export type Dimension = 'length' | 'mass' | 'volume' | 'temperature' | 'power' | 'voltage' | 'charge' | 'light' | 'count' | 'density';

export interface UnitDef {
  id: string;
  dimension: Dimension;
  /** Multiply by this to get the base unit (mm, g, ml, W, V, mAh, lm, items, threads). */
  toBase: number;
  aliases: string[];
  system: 'metric' | 'imperial' | 'neutral';
}

export const UNITS: UnitDef[] = [
  { id: 'mm', dimension: 'length', toBase: 1, system: 'metric', aliases: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'milímetros', 'milímetro', 'millimètres', 'millimètre'] },
  { id: 'cm', dimension: 'length', toBase: 10, system: 'metric', aliases: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres', 'centímetros', 'centímetro', 'centimètres', 'centimètre'] },
  { id: 'm', dimension: 'length', toBase: 1000, system: 'metric', aliases: ['m', 'meter', 'meters', 'metre', 'metres', 'metros', 'metro', 'mètres', 'mètre'] },
  { id: 'in', dimension: 'length', toBase: 25.4, system: 'imperial', aliases: ['in', 'inch', 'inches', '"', '″', '”', 'pulg', 'pulgada', 'pulgadas', 'po', 'pouce', 'pouces'] },
  { id: 'ft', dimension: 'length', toBase: 304.8, system: 'imperial', aliases: ['ft', 'foot', 'feet', "'", '′', 'pie', 'pies', 'pi', 'pieds', 'pied'] },
  { id: 'yd', dimension: 'length', toBase: 914.4, system: 'imperial', aliases: ['yd', 'yard', 'yards', 'yarda', 'yardas', 'verge', 'verges'] },
  { id: 'mg', dimension: 'mass', toBase: 0.001, system: 'metric', aliases: ['mg', 'milligram', 'milligrams', 'miligramos', 'milligrammes'] },
  { id: 'g', dimension: 'mass', toBase: 1, system: 'metric', aliases: ['g', 'gram', 'grams', 'gramme', 'grammes', 'gramo', 'gramos'] },
  { id: 'kg', dimension: 'mass', toBase: 1000, system: 'metric', aliases: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes', 'kilogramo', 'kilogramos'] },
  { id: 'oz', dimension: 'mass', toBase: 28.349523125, system: 'imperial', aliases: ['oz', 'ounce', 'ounces', 'onza', 'onzas', 'once', 'onces'] },
  { id: 'lb', dimension: 'mass', toBase: 453.59237, system: 'imperial', aliases: ['lb', 'lbs', 'pound', 'pounds', 'libra', 'libras', 'livre', 'livres'] },
  { id: 'ml', dimension: 'volume', toBase: 1, system: 'metric', aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'mililitro', 'mililitros'] },
  { id: 'cl', dimension: 'volume', toBase: 10, system: 'metric', aliases: ['cl', 'centiliter', 'centilitre', 'centilitres', 'centilitros'] },
  { id: 'l', dimension: 'volume', toBase: 1000, system: 'metric', aliases: ['l', 'liter', 'liters', 'litre', 'litres', 'litro', 'litros'] },
  { id: 'floz', dimension: 'volume', toBase: 29.5735295625, system: 'imperial', aliases: ['fl oz', 'fl. oz.', 'fl. oz', 'fluid ounce', 'fluid ounces', 'onzas líquidas', 'onces liquides'] },
  { id: 'qt', dimension: 'volume', toBase: 946.352946, system: 'imperial', aliases: ['qt', 'quart', 'quarts', 'cuarto', 'cuartos', 'pinte', 'pintes'] },
  { id: 'gal', dimension: 'volume', toBase: 3785.411784, system: 'imperial', aliases: ['gal', 'gallon', 'gallons', 'galón', 'galones'] },
  { id: 'C', dimension: 'temperature', toBase: 1, system: 'metric', aliases: ['°c', 'ºc', '° c', 'degrees celsius', 'grados celsius', 'degrés celsius'] },
  { id: 'F', dimension: 'temperature', toBase: 1, system: 'imperial', aliases: ['°f', 'ºf', '° f', 'degrees fahrenheit', 'grados fahrenheit', 'degrés fahrenheit'] },
  { id: 'W', dimension: 'power', toBase: 1, system: 'neutral', aliases: ['w', 'watt', 'watts', 'vatios', 'vatio'] },
  { id: 'kW', dimension: 'power', toBase: 1000, system: 'neutral', aliases: ['kw', 'kilowatt', 'kilowatts'] },
  { id: 'V', dimension: 'voltage', toBase: 1, system: 'neutral', aliases: ['v', 'volt', 'volts', 'voltios', 'voltio'] },
  { id: 'mAh', dimension: 'charge', toBase: 1, system: 'neutral', aliases: ['mah'] },
  { id: 'lm', dimension: 'light', toBase: 1, system: 'neutral', aliases: ['lm', 'lumen', 'lumens', 'lúmenes'] },
  { id: 'pcs', dimension: 'count', toBase: 1, system: 'neutral', aliases: ['pc', 'pcs', 'piece', 'pieces', 'pack', 'piezas', 'pieza', 'pièces', 'pièce', 'count', 'ct'] },
  { id: 'tc', dimension: 'density', toBase: 1, system: 'neutral', aliases: ['thread count', 'tc', 'hilos'] },
];

const ALIAS_INDEX: { alias: string; unit: UnitDef }[] = UNITS.flatMap((u) => u.aliases.map((alias) => ({ alias, unit: u }))).sort(
  (a, b) => b.alias.length - a.alias.length,
);

/** Words that, right after a bare "in", show it is a unit and not the preposition. */
const DIMENSION_WORDS = new Set(['wide', 'long', 'tall', 'high', 'deep', 'thick', 'diameter', 'length', 'width', 'height', 'depth', 'square', 'sq', 'across', 'each']);

export function unitById(id: string): UnitDef {
  const u = UNITS.find((x) => x.id === id);
  if (!u) throw new Error(`unknown unit ${id}`);
  return u;
}

export interface Measurement {
  /** Values as written, in the stated unit. Dimensions like 50 x 60 have two values. */
  values: number[];
  /** Decimal places each value was written with (1,3 → 1), so comparisons allow for rounding. */
  decimals?: number[];
  unit: UnitDef;
  text: string;
  start: number;
  end: number;
}

const NUM = /(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,  ]\d{3})*(?:[.,]\d+)?)/y;
const SEP = /\s*(?:x|×|X|by|por|par|sur)\s*(?=\d)/y;

function isLetter(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{M}]/u.test(ch);
}

/**
 * Try to read a unit at `pos` (after optional space or hyphen). `inDimension` is true after "50 x 60",
 * where a bare "in" can only mean inches.
 */
function matchUnit(text: string, pos: number, inDimension = false): { unit: UnitDef; end: number } | null {
  let p = pos;
  if (text[p] === '-' || text[p] === ' ' || text[p] === ' ' || text[p] === ' ') p++;
  const rest = text.slice(p, p + 24).toLowerCase();
  for (const { alias, unit } of ALIAS_INDEX) {
    if (!rest.startsWith(alias)) continue;
    const after = text[p + alias.length];
    const symbolic = !/[\p{L}]/u.test(alias[0]);
    // Symbol units (", ', °C) may touch the number; word units must end at a word boundary.
    if (!symbolic && isLetter(after)) continue;
    const degree = alias.startsWith('°') || alias.startsWith('º');
    if (symbolic && p !== pos && !degree) continue; // 50 " is not an inch mark, but 40 °C is how French writes it
    if (symbolic && !degree && isLetter(after)) continue; // the 90's, "Model 5"s
    if (unit.id === 'in' && alias === 'in' && !inDimension) {
      // "fits 2 in a drawer": only treat "in" as inches before punctuation, the end, or a dimension word.
      const next = text.slice(p + 2).match(/^\s*([\p{L}]+)?/u)?.[1]?.toLowerCase();
      const punctOrEnd = /^\s*([^\p{L}\s]|$)/u.test(text.slice(p + 2));
      if (!punctOrEnd && !(next && DIMENSION_WORDS.has(next))) continue;
    }
    return { unit, end: p + alias.length };
  }
  return null;
}

/** Find every measurement in a text. Numbers without a unit are ignored. */
export function findMeasurements(text: string, locale: Locale): Measurement[] {
  const out: Measurement[] = [];
  const starts = /(?<![\p{L}\d.,/])\d/gu;
  let lastEnd = 0;
  for (const m of text.matchAll(starts)) {
    const start = m.index!;
    if (start < lastEnd) continue;
    const values: number[] = [];
    const decimals: number[] = [];
    const units: (UnitDef | null)[] = [];
    let pos = start;
    let end = start;
    for (;;) {
      NUM.lastIndex = pos;
      const nm = NUM.exec(text);
      if (!nm) break;
      const raw = nm[0].trim();
      const value = parseLocaleNumber(raw, locale);
      if (value === null) break;
      values.push(value);
      decimals.push(decimalsOf(raw));
      pos += nm[0].trimEnd().length;
      const u = matchUnit(text, pos, values.length > 1);
      units.push(u?.unit ?? null);
      if (u) pos = u.end;
      end = pos;
      SEP.lastIndex = pos;
      const sep = SEP.exec(text);
      if (!sep) break;
      pos = SEP.lastIndex;
    }
    const unit = [...units].reverse().find((u): u is UnitDef => u !== null);
    if (!values.length || !unit) {
      lastEnd = Math.max(lastEnd, start + 1);
      continue;
    }
    // Mixed dimensions ("5 lb x 3 in") are not one measurement.
    if (units.some((u) => u && u.dimension !== unit.dimension)) {
      lastEnd = end;
      continue;
    }
    out.push({ values, decimals, unit, text: text.slice(start, end), start, end });
    lastEnd = end;
  }
  return out;
}

/** Decimal places in a written number: "1,3" → 1, "2.25" → 2, "1,250" (thousands) → 0, "1/2" → 2. */
export function decimalsOf(raw: string): number {
  if (raw.includes('/')) return 2;
  const m = /[.,](\d+)$/.exec(raw.trim());
  if (!m || m[1].length === 3) return 0;
  return m[1].length;
}

/** Half of the smallest step a value was written with, in base units: "152 cm" could be anything from 151.5 to 152.5 cm. */
function roundingSlack(m: Measurement, index: number): number {
  const d = m.decimals?.[index] ?? 0;
  if (m.unit.dimension === 'temperature') return 0.5 * 10 ** -d;
  return 0.5 * 10 ** -d * m.unit.toBase;
}

export function toBase(value: number, unit: UnitDef): number {
  if (unit.dimension === 'temperature') return unit.id === 'F' ? ((value - 32) * 5) / 9 : value;
  return value * unit.toBase;
}

export function convert(value: number, from: UnitDef, to: UnitDef): number {
  if (from.dimension !== to.dimension) throw new Error(`cannot convert ${from.id} to ${to.id}`);
  if (from.dimension === 'temperature') {
    const c = toBase(value, from);
    return to.id === 'F' ? (c * 9) / 5 + 32 : c;
  }
  return (value * from.toBase) / to.toBase;
}

/**
 * Do two measurements describe the same quantity? Dimension order is ignored (60 x 50 = 50 x 60),
 * and a single value may name one side of a multi-value fact ("60 in long" for 50 x 60 in).
 * Tolerance covers rounding after conversion (60 in = 152.4 cm, written 152 cm).
 */
export function sameQuantity(draft: Measurement, fact: Measurement, tolerance = 0.005): 'exact' | 'converted' | false {
  if (draft.unit.dimension !== fact.unit.dimension) return false;
  // Values in base units, each with the slack its written precision allows, sorted by size.
  const d = draft.values.map((v, i) => ({ v: toBase(v, draft.unit), slack: roundingSlack(draft, i) })).sort((a, b) => a.v - b.v);
  const f = fact.values.map((v, i) => ({ v: toBase(v, fact.unit), slack: roundingSlack(fact, i) })).sort((a, b) => a.v - b.v);
  const sameUnit = draft.unit.id === fact.unit.id;
  const close = (a: { v: number; slack: number }, b: { v: number; slack: number }) => {
    const diff = Math.abs(a.v - b.v);
    const scale = Math.max(Math.abs(a.v), Math.abs(b.v), 1e-9);
    // In the same unit the numbers must agree: 61 in is not 60 in.
    if (sameUnit) return diff / scale < 1e-9;
    if (draft.unit.dimension === 'temperature') return diff <= Math.max(0.5, a.slack);
    // A converted value may be rounded to the precision it is written with (0.5 in = 1.27 cm, written
    // "1,3 cm"), but only the converted side's rounding counts: the fact is the exact value.
    return diff <= a.slack + 1e-9 || diff / scale <= tolerance;
  };
  let ok: boolean;
  if (d.length === f.length) ok = d.every((v, i) => close(v, f[i]));
  else if (d.length === 1) ok = f.some((v) => close(d[0], v));
  else ok = false;
  if (!ok) return false;
  if (draft.unit.id !== fact.unit.id) return 'converted';
  const raw = (xs: number[]) => xs.slice().sort((a, b) => a - b);
  const dv = raw(draft.values);
  const fv = raw(fact.values);
  const same = dv.length === fv.length ? dv.every((v, i) => Math.abs(v - fv[i]) < 1e-9) : fv.some((v) => Math.abs(v - dv[0]) < 1e-9);
  return same ? 'exact' : 'converted';
}

function describe(ms: Measurement[]): string {
  return ms.map((m) => `"${m.text.trim()}"`).join(', ');
}

/**
 * Compare every measurement in the draft with the measurements in the facts.
 *  - block `units.mismatch`: the facts give this kind of measurement, but not this value.
 *  - block `units.unsupported`: the facts never give this kind of measurement.
 *  - warn  `units.converted`: the value matches only after converting units (style guides say copy them as given).
 */
export function checkMeasurements(facts: Record<string, string>, draft: string, locale: Locale): Finding[] {
  const factMs = Object.values(facts).flatMap((v) => findMeasurements(v, locale));
  const draftMs = findMeasurements(draft, locale);
  const findings: Finding[] = [];
  for (const dm of draftMs) {
    const sameDim = factMs.filter((f) => f.unit.dimension === dm.unit.dimension);
    if (!sameDim.length) {
      findings.push({
        code: 'units.unsupported',
        severity: 'block',
        message: `states a ${dm.unit.dimension} (${dm.text.trim()}) that the facts do not give`,
        start: dm.start,
        end: dm.end,
      });
      continue;
    }
    const matches = sameDim.map((f) => sameQuantity(dm, f)).filter(Boolean);
    if (!matches.length) {
      findings.push({
        code: 'units.mismatch',
        severity: 'block',
        message: `says ${dm.text.trim()} but the facts say ${describe(sameDim)}`,
        start: dm.start,
        end: dm.end,
        suggestion: sameDim[0].text.trim(),
      });
    } else if (!matches.includes('exact')) {
      const wanted = profile(locale).units;
      const fits = wanted === 'both' || dm.unit.system === 'neutral' || dm.unit.system === wanted;
      findings.push({
        code: 'units.converted',
        severity: fits ? 'info' : 'warn',
        message: `converted ${describe(sameDim)} to ${dm.text.trim()}; copy measurements as the facts give them`,
        start: dm.start,
        end: dm.end,
        suggestion: sameDim[0].text.trim(),
      });
    }
  }
  return findings;
}

/** Render a measurement in another unit, e.g. for a bilingual label preview. */
export function formatAs(m: Measurement, target: UnitDef, decimals = 1): string {
  const vals = m.values.map((v) => {
    const c = convert(v, m.unit, target);
    return Number.isInteger(c) ? String(c) : c.toFixed(decimals).replace(/\.0+$/, '');
  });
  const unit = target.aliases[0];
  const symbolic = !/[a-z]/i.test(unit[0]);
  return `${vals.join(' x ')}${symbolic ? '' : ' '}${unit}`;
}
