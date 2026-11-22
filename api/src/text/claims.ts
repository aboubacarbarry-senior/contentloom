import type { Finding, Locale } from '../domain';
import { fold, profile } from '../locales';
import { findPhrase } from './tokenize';

/**
 * Claims a product description must not make unless the facts back them. Health, safety and
 * environmental claims carry legal risk (FTC Green Guides, Health Canada, CPSC), so an unsupported one
 * blocks auto-approval. Facts are usually supplied in English for every locale, so each concept lists
 * its wording in all three languages and is "supported" when any of them appears in the facts.
 */
export interface ClaimConcept {
  id: string;
  label: string;
  severity: 'block' | 'warn';
  phrases: { en: string[]; es: string[]; fr: string[] };
  /** Extra fact wording that supports the claim without repeating it (e.g. a certification name). */
  supportedBy?: string[];
}

export const CLAIM_CONCEPTS: ClaimConcept[] = [
  {
    id: 'hypoallergenic',
    label: 'hypoallergenic',
    severity: 'block',
    phrases: { en: ['hypoallergenic', 'allergy-free', 'allergen-free'], es: ['hipoalergénico', 'hipoalergénica', 'hipoalergénicos'], fr: ['hypoallergénique', 'hypoallergéniques'] },
  },
  {
    id: 'non-toxic',
    label: 'non-toxic',
    severity: 'block',
    phrases: { en: ['non-toxic', 'nontoxic', 'chemical-free', 'chemical free', 'toxin-free'], es: ['no tóxico', 'no tóxica', 'atóxico', 'sin químicos'], fr: ['non toxique', 'sans produits chimiques'] },
  },
  {
    id: 'antibacterial',
    label: 'antibacterial or antimicrobial',
    severity: 'block',
    phrases: { en: ['antibacterial', 'antimicrobial', 'kills germs', 'kills bacteria'], es: ['antibacteriano', 'antibacteriana', 'antimicrobiano', 'elimina gérmenes'], fr: ['antibactérien', 'antibactérienne', 'antimicrobien', 'tue les germes'] },
  },
  {
    id: 'bpa-free',
    label: 'BPA-free',
    severity: 'block',
    phrases: { en: ['bpa-free', 'bpa free', 'free of bpa'], es: ['libre de bpa', 'sin bpa'], fr: ['sans bpa'] },
  },
  {
    id: 'lead-free',
    label: 'lead-free',
    severity: 'block',
    phrases: { en: ['lead-free', 'lead free'], es: ['libre de plomo', 'sin plomo'], fr: ['sans plomb'] },
  },
  {
    id: 'organic',
    label: 'organic',
    severity: 'block',
    phrases: { en: ['organic'], es: ['orgánico', 'orgánica', 'orgánicos', 'orgánicas'], fr: ['biologique', 'biologiques', 'bio'] },
    supportedBy: ['gots', 'usda organic', 'ocs'],
  },
  {
    id: 'eco',
    label: 'eco-friendly or sustainable',
    severity: 'block',
    phrases: {
      en: ['eco-friendly', 'eco friendly', 'environmentally friendly', 'sustainable', 'green choice', 'planet-friendly', 'carbon neutral'],
      es: ['ecológico', 'ecológica', 'sostenible', 'amigable con el medio ambiente', 'carbono neutral'],
      fr: ['écologique', 'écoresponsable', 'respectueux de l’environnement', "respectueux de l'environnement", 'carboneutre'],
    },
    supportedBy: ['fsc', 'recycled', 'reciclado', 'recyclé'],
  },
  {
    id: 'biodegradable',
    label: 'biodegradable or compostable',
    severity: 'block',
    phrases: { en: ['biodegradable', 'compostable'], es: ['biodegradable', 'compostable'], fr: ['biodégradable', 'compostable'] },
  },
  {
    id: 'recyclable',
    label: 'recyclable',
    severity: 'warn',
    phrases: { en: ['recyclable'], es: ['reciclable'], fr: ['recyclable'] },
  },
  {
    id: 'flame',
    label: 'flame-retardant or fireproof',
    severity: 'block',
    phrases: { en: ['flame-retardant', 'flame retardant', 'fire-retardant', 'fireproof', 'fire-resistant', 'fire resistant'], es: ['ignífugo', 'ignífuga', 'resistente al fuego', 'a prueba de fuego'], fr: ['ignifuge', 'ignifugé', 'résistant au feu'] },
  },
  {
    id: 'waterproof',
    label: 'waterproof',
    severity: 'block',
    phrases: { en: ['waterproof', 'water-proof'], es: ['a prueba de agua', 'impermeable'], fr: ['imperméable', "à l'épreuve de l'eau", 'à l’épreuve de l’eau'] },
    supportedBy: ['ipx7', 'ipx8', 'ip67', 'ip68'],
  },
  {
    id: 'medical',
    label: 'medical or therapeutic',
    severity: 'block',
    phrases: {
      en: ['cures disease', 'heals', 'relieves pain', 'pain relief', 'therapeutic', 'clinically proven', 'doctor recommended', 'dermatologist tested', 'fda approved', 'fda-approved', 'fda cleared'],
      es: ['cura', 'alivia el dolor', 'terapéutico', 'terapéutica', 'clínicamente probado', 'recomendado por médicos', 'aprobado por la fda'],
      fr: ['guérit', 'soulage la douleur', 'thérapeutique', 'cliniquement prouvé', 'recommandé par les médecins', 'approuvé par la fda'],
    },
  },
  {
    id: 'child-safety',
    label: 'safety for babies or children',
    severity: 'block',
    phrases: {
      en: ['safe for babies', 'baby-safe', 'baby safe', 'child-safe', 'child safe', 'safe for kids', 'safe for children'],
      es: ['seguro para bebés', 'segura para bebés', 'seguro para niños'],
      fr: ['sécuritaire pour bébé', 'sans danger pour bébé', 'sécuritaire pour les enfants'],
    },
    supportedBy: ['astm f963', 'cpsc', 'en 71', 'jpma'],
  },
  {
    id: 'warranty',
    label: 'warranty or guarantee',
    severity: 'block',
    phrases: {
      en: ['lifetime warranty', 'guaranteed', 'guarantee', 'money-back', 'money back'],
      es: ['garantía de por vida', 'garantizado', 'garantizada', 'devolución del dinero'],
      fr: ['garantie à vie', 'garanti', 'garantie', 'satisfait ou remboursé'],
    },
    supportedBy: ['warranty', 'garantía', 'garantie'],
  },
  {
    id: 'origin',
    label: 'country of origin',
    severity: 'block',
    phrases: {
      en: ['made in usa', 'made in the usa', 'made in america', 'made in canada', 'handmade', 'handcrafted', 'hand-made'],
      es: ['hecho en ee. uu.', 'hecho en estados unidos', 'hecho a mano', 'hecho en canadá'],
      fr: ['fabriqué aux états-unis', 'fabriqué au canada', 'fait à la main', 'fait main'],
    },
    supportedBy: ['origin', 'country of origin', 'made in', 'handmade', 'handcrafted'],
  },
  {
    id: 'promo',
    label: 'pricing or promotion',
    severity: 'block',
    phrases: {
      en: ['on sale', 'discount', 'free shipping', 'limited time', 'best price', 'lowest price', 'buy now', '% off', 'bogo', 'clearance'],
      es: ['en oferta', 'descuento', 'envío gratis', 'por tiempo limitado', 'mejor precio', 'compre ya', 'liquidación'],
      fr: ['en solde', 'rabais', 'livraison gratuite', 'pour une durée limitée', 'meilleur prix', 'achetez maintenant', 'liquidation'],
    },
  },
  {
    id: 'comparative',
    label: 'comparison with other products',
    severity: 'warn',
    phrases: {
      en: ['than other', 'than any other', 'compared to other', 'unlike other', 'better than', 'outperforms'],
      es: ['que otros', 'que cualquier otro', 'a diferencia de otros', 'mejor que', 'supera a'],
      fr: ['que les autres', "que tout autre", 'contrairement aux autres', 'meilleur que', 'surpasse'],
    },
  },
];

function factsText(facts: Record<string, string>): string {
  return fold(Object.entries(facts).map(([k, v]) => `${k} ${v}`).join(' \n '));
}

/** Is a concept backed by the facts, in any language? */
export function conceptSupported(concept: ClaimConcept, facts: Record<string, string>): boolean {
  const ft = factsText(facts);
  const all = [...concept.phrases.en, ...concept.phrases.es, ...concept.phrases.fr, ...(concept.supportedBy ?? [])];
  return all.some((p) => findPhrase(ft, fold(p)).length > 0);
}

export function checkClaims(facts: Record<string, string>, draft: string, locale: Locale): Finding[] {
  const lang = profile(locale).language;
  const out: Finding[] = [];
  for (const concept of CLAIM_CONCEPTS) {
    const hits = concept.phrases[lang].flatMap((p) => findPhrase(draft, p).map((h) => ({ ...h, phrase: p })));
    // "% off" starts with a symbol, so word-boundary search misses it; look for it directly.
    if (concept.id === 'promo') {
      for (const m of draft.matchAll(/\d+\s?%\s?(?:off|de descuento|de rabais)/gi)) hits.push({ start: m.index!, end: m.index! + m[0].length, phrase: m[0] });
    }
    if (!hits.length) continue;
    if (concept.id !== 'promo' && concept.id !== 'comparative' && conceptSupported(concept, facts)) continue;
    hits.sort((a, b) => a.start - b.start);
    const first = hits[0];
    out.push({
      code: `claim.${concept.id}`,
      severity: concept.severity,
      message:
        concept.id === 'promo'
          ? `pricing or promotional language ("${draft.slice(first.start, first.end)}") does not belong in evergreen copy`
          : concept.id === 'comparative'
            ? `compares the product with others ("${draft.slice(first.start, first.end)}")`
            : `${concept.label} claim ("${draft.slice(first.start, first.end)}") is not supported by the facts`,
      start: first.start,
      end: first.end,
    });
  }
  return out;
}

/** Hype words and unsupported superlatives: style problems, not legal ones, so they only warn. */
export function checkHype(facts: Record<string, string>, draft: string, locale: Locale): Finding[] {
  const p = profile(locale);
  const ft = factsText(facts);
  const out: Finding[] = [];
  for (const word of p.hype) {
    for (const h of findPhrase(draft, word)) {
      out.push({ code: 'style.hype', severity: 'warn', message: `hype word "${draft.slice(h.start, h.end)}"`, start: h.start, end: h.end });
    }
  }
  for (const word of p.superlatives) {
    const hits = word.startsWith('#') ? [...draft.matchAll(/#1\b/g)].map((m) => ({ start: m.index!, end: m.index! + 2 })) : findPhrase(draft, word);
    for (const h of hits) {
      // "Best-selling" style facts (e.g. an award) can back a superlative.
      if (findPhrase(ft, fold(word)).length) continue;
      out.push({ code: 'style.superlative', severity: 'warn', message: `superlative "${draft.slice(h.start, h.end)}" without support in the facts`, start: h.start, end: h.end });
    }
  }
  return out;
}

const ACRONYMS = new Set(['BPA', 'LED', 'USB', 'UV', 'UL', 'FSC', 'GOTS', 'OEKO', 'TEX', 'USA', 'US', 'EE', 'UU', 'HDMI', 'AC', 'DC', 'XL', 'XXL', 'XS', 'TV', 'PVC', 'ABS', 'IPX', 'II', 'III', 'IV', 'CPSC', 'ASTM', 'FDA', 'ETL', 'CSA', 'OQLF']);

/** Exclamation marks and shouting. */
export function checkEmphasis(draft: string, brand?: string): Finding[] {
  const out: Finding[] = [];
  const excl = [...draft.matchAll(/!/g)];
  if (excl.length) {
    out.push({
      code: 'style.exclamation',
      severity: 'warn',
      message: `${excl.length} exclamation mark${excl.length === 1 ? '' : 's'}`,
      start: excl[0].index!,
      end: excl[0].index! + 1,
    });
  }
  const brandWords = new Set((brand ?? '').split(/\s+/).filter(Boolean));
  for (const m of draft.matchAll(/(?<![\p{L}\d])\p{Lu}{3,}(?![\p{L}\d])/gu)) {
    const w = m[0];
    if (ACRONYMS.has(w) || brandWords.has(w)) continue;
    out.push({ code: 'style.caps', severity: 'warn', message: `shouting in capitals ("${w}")`, start: m.index!, end: m.index! + w.length });
  }
  return out;
}
