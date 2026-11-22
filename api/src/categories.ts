import { ALWAYS_REVIEW } from './domain';

/**
 * What the copy team knows about each merchandise category: which facts a brief must carry, how long
 * the copy should be, claims that are never allowed there, and a line of guidance for the writer.
 * Briefs for unknown categories fall back to DEFAULT_CATEGORY.
 */
export interface CategoryRule {
  id: string;
  label: string;
  /** Fact keys a brief must provide before generation is worth paying for. */
  requiredFacts: string[];
  /** Recommended (min, max) word range. Drafts outside it get a length finding. */
  words: [number, number];
  /** Claims banned in this category on top of the brief's own list. */
  bannedClaims: string[];
  /** Short guidance appended to the writer's system prompt. */
  guidance: string;
  regulated: boolean;
}

export const DEFAULT_CATEGORY: CategoryRule = {
  id: 'default',
  label: 'General merchandise',
  requiredFacts: ['name'],
  words: [40, 120],
  bannedClaims: [],
  guidance: 'Lead with what the product is and what it is for, then materials and size, then care.',
  regulated: false,
};

const RULES: CategoryRule[] = [
  {
    id: 'textiles',
    label: 'Bedding & throws',
    requiredFacts: ['name', 'material', 'size'],
    words: [40, 120],
    bannedClaims: ['wrinkle-free', 'stain-proof'],
    guidance: 'Describe the hand-feel and weave only as the facts allow; always give the exact size and the care instructions.',
    regulated: false,
  },
  {
    id: 'rugs',
    label: 'Rugs',
    requiredFacts: ['name', 'material', 'size'],
    words: [50, 130],
    bannedClaims: ['non-slip', 'stain-proof', 'pet-proof'],
    guidance: 'Say which rooms the size suits; mention pile height and backing only when given. Never promise it will not slip.',
    regulated: false,
  },
  {
    id: 'furniture',
    label: 'Furniture',
    requiredFacts: ['name', 'material', 'dimensions'],
    words: [60, 150],
    bannedClaims: ['indestructible', 'scratch-proof'],
    guidance: 'Give overall dimensions and weight capacity exactly; mention assembly if the facts say so.',
    regulated: false,
  },
  {
    id: 'kitchen',
    label: 'Kitchen & dining',
    requiredFacts: ['name', 'material'],
    words: [40, 120],
    bannedClaims: ['non-toxic', 'unbreakable', 'dishwasher safe'],
    guidance: 'Mention dishwasher, oven or microwave use only when the facts state it.',
    regulated: false,
  },
  {
    id: 'lighting',
    label: 'Lighting',
    requiredFacts: ['name', 'bulb'],
    words: [40, 120],
    bannedClaims: ['energy-saving', 'never needs replacing'],
    guidance: 'Give bulb type, wattage and lumens as stated; do not estimate running costs.',
    regulated: false,
  },
  {
    id: 'electrical',
    label: 'Electrical appliances',
    requiredFacts: ['name', 'voltage', 'certification'],
    words: [50, 130],
    bannedClaims: ['fireproof', 'shock-proof', 'safe to leave unattended'],
    guidance: 'State voltage, wattage and certification marks exactly; never imply it is safe to leave running unattended.',
    regulated: true,
  },
  {
    id: 'baby',
    label: 'Baby & nursery',
    requiredFacts: ['name', 'material', 'age range'],
    words: [40, 110],
    bannedClaims: ['safe for babies', 'prevents SIDS', 'hypoallergenic', 'non-toxic'],
    guidance: 'Give the age range and any safety standard exactly as stated; make no safety or health promises.',
    regulated: true,
  },
  {
    id: 'supplements',
    label: 'Supplements',
    requiredFacts: ['name', 'serving size', 'ingredients'],
    words: [40, 110],
    bannedClaims: ['cures', 'treats', 'prevents disease', 'clinically proven', 'detox', 'boosts immunity'],
    guidance: 'Describe ingredients and serving size only. No health, disease or performance claims of any kind.',
    regulated: true,
  },
  {
    id: 'outdoor',
    label: 'Outdoor & garden',
    requiredFacts: ['name', 'material'],
    words: [40, 130],
    bannedClaims: ['weatherproof', 'rustproof', 'uv-proof'],
    guidance: 'Mention weather or UV resistance only in the words the facts use (resistant, not proof).',
    regulated: false,
  },
  {
    id: 'decor',
    label: 'Home decor',
    requiredFacts: ['name', 'material'],
    words: [35, 100],
    bannedClaims: [],
    guidance: 'Keep it short; describe finish and colour as named in the facts.',
    regulated: false,
  },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function categoryRule(id: string): CategoryRule {
  const known = BY_ID.get(id);
  if (known) return known;
  return { ...DEFAULT_CATEGORY, id, regulated: ALWAYS_REVIEW.has(id) };
}

export function knownCategories(): CategoryRule[] {
  return [...RULES];
}

export function isKnownCategory(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Fact keys are free text from merchandisers ("Material", "material ", "materials"), so match them
 * loosely: case, spacing, underscores and a trailing plural "s" are ignored.
 */
export function normalizeFactKey(k: string): string {
  return k
    .trim()
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/(?<=\w{3})s$/, '');
}

export function missingRequiredFacts(category: string, facts: Record<string, string>): string[] {
  const have = new Set(
    Object.entries(facts)
      .filter(([, v]) => v !== undefined && String(v).trim() !== '')
      .map(([k]) => normalizeFactKey(k)),
  );
  // "dimensions" is satisfied by "size" and the other way round.
  const aliases: Record<string, string[]> = { dimension: ['size'], size: ['dimension'] };
  return categoryRule(category).requiredFacts.filter((k) => {
    const n = normalizeFactKey(k);
    return !have.has(n) && !(aliases[n] ?? []).some((a) => have.has(a));
  });
}

/** Banned claims for a brief: its own list plus the category's, without duplicates (case-insensitive). */
export function effectiveBanned(category: string, briefBanned: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [...briefBanned, ...categoryRule(category).bannedClaims]) {
    const k = b.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(b.trim());
  }
  return out;
}
