import { categoryRule } from './categories';
import type { Brief, Locale } from './domain';
import { glossaryInstructions, GlossaryTerm } from './glossary';
import { profile } from './locales';

/**
 * Prompt templates. Everything that is the same across a batch (instructions, style guide, category
 * guidance, glossary, examples) goes in the system prompt so it can be cached; the per-SKU facts go in
 * the user message. Bump PROMPT_VERSION whenever the wording changes, so metrics can be split by it.
 */
export const PROMPT_VERSION = '2026-11.2';

export interface PromptVariant {
  id: string;
  label: string;
  description: string;
  /** Instruction appended to the system prompt. */
  instruction: string;
  words: [number, number];
}

export const VARIANTS: Record<string, PromptVariant> = {
  control: {
    id: 'control',
    label: 'Control',
    description: 'The current production prompt.',
    instruction: '',
    words: [50, 90],
  },
  benefit_led: {
    id: 'benefit_led',
    label: 'Benefit-led',
    description: 'Opens with the everyday situation the product is for, then the facts.',
    instruction: 'Open with one sentence about the everyday situation the product is for, grounded in the facts, then give the facts.',
    words: [50, 90],
  },
  concise: {
    id: 'concise',
    label: 'Concise',
    description: 'Shorter copy for mobile listings.',
    instruction: 'Keep it tight: short sentences, no more than three of them.',
    words: [40, 60],
  },
};

export function variant(id: string | null | undefined): PromptVariant {
  return (id && VARIANTS[id]) || VARIANTS.control;
}

export function generationSystem(locale: Locale, words: [number, number] = [50, 90]): string {
  return `You write product descriptions for a home-goods retailer, in ${profile(locale).name}. Write ${words[0]}-${words[1]} words in a warm, \
practical voice. Use only the facts given; state material and dimensions exactly as provided. Don't make claims the facts don't \
support, and avoid superlatives and exclamation marks. Return only the description text.`;
}

/** Two short house examples per locale: they anchor tone and length better than adjectives do. */
const EXAMPLES: Record<Locale, string[]> = {
  'en-US': [
    'Facts: name: Harbor Stripe Towel; material: 100% cotton terry; size: 30 x 56 in; care: machine wash warm\nDescription: The Harbor Stripe Towel is cut from 100% cotton terry and measures 30 x 56 in, enough to wrap up after a shower or lay out at the pool. Its classic stripe works with plain tiles and patterned ones alike. Machine wash warm and tumble dry as usual; the loops loosen a little with each wash.',
    'Facts: name: Alder Side Table; material: solid oak; dimensions: 18 x 18 x 22 in; assembly: legs screw in\nDescription: A small table with a big job, the Alder Side Table holds a lamp, a book and a mug beside the sofa. It is made of solid oak and measures 18 x 18 x 22 in. The legs screw in by hand, so it is ready in a few minutes with no tools.',
  ],
  'es-US': [
    'Facts: name: Toalla Harbor Stripe; material: rizo 100% algodón; size: 30 x 56 in; care: lavar a máquina en agua tibia\nDescription: La toalla Harbor Stripe está hecha de rizo 100% algodón y mide 30 x 56 in, suficiente para envolverse después de la ducha o tenderse junto a la piscina. Sus rayas clásicas combinan con azulejos lisos o estampados. Lávela a máquina en agua tibia.',
  ],
  'fr-CA': [
    "Facts: name: Serviette Harbor Stripe; material: ratine 100 % coton; size: 76 x 142 cm; care: lavable à la machine à l'eau tiède\nDescription: La serviette Harbor Stripe est taillée dans une ratine 100 % coton et mesure 76 x 142 cm : de quoi s'envelopper après la douche ou s'étendre au bord de la piscine. Ses rayures classiques s'accordent aux carreaux unis comme aux motifs. Lavez-la à la machine à l'eau tiède.",
  ],
};

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface BuiltPrompt {
  system: SystemBlock[];
  user: string;
  variant: string;
  version: string;
}

function factLines(facts: Record<string, string>): string {
  // Keys keep their order: merchandisers put the important facts first.
  return Object.entries(facts)
    .filter(([, v]) => v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

export interface GenerationOptions {
  variant?: string | null;
  glossary?: GlossaryTerm[];
  feedback?: string | null;
  previousDraft?: string | null;
  cache?: boolean;
}

export function buildGeneration(brief: Brief, opts: GenerationOptions = {}): BuiltPrompt {
  const v = variant(opts.variant);
  const p = profile(brief.locale);
  const cat = categoryRule(brief.category);
  const parts = [
    generationSystem(brief.locale, v.words),
    `Style guide for ${p.name}:\n${p.styleGuide.map((s) => `- ${s}`).join('\n')}`,
    `Category: ${cat.label}. ${cat.guidance}`,
  ];
  if (v.instruction) parts.push(v.instruction);
  const terms = glossaryInstructions(opts.glossary ?? [], brief);
  if (terms.length) parts.push(`House terminology:\n${terms.map((t) => `- ${t}`).join('\n')}`);
  parts.push(`Examples of the house style:\n\n${EXAMPLES[brief.locale].join('\n\n')}`);
  const system: SystemBlock[] = [{ type: 'text', text: parts.join('\n\n'), ...(opts.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }];

  const lines = [factLines(brief.facts)];
  if (brief.title) lines.push(`\nUse this product name: ${brief.title}`);
  if (brief.mustMention.length) lines.push(`\nInclude these exactly as written: ${brief.mustMention.join('; ')}`);
  if (brief.keywords?.length) lines.push(`\nWork in these search terms once each, only where natural: ${brief.keywords.join('; ')}`);
  const banned = brief.banned.filter((b) => b.trim());
  if (banned.length) lines.push(`\nNever say or imply: ${banned.join('; ')}`);
  if (opts.feedback) {
    if (opts.previousDraft) lines.push(`\n<previous_draft>\n${opts.previousDraft}\n</previous_draft>`);
    lines.push(`\nA reviewer asked for changes to the previous draft: ${opts.feedback.replace(/\s+/g, ' ').trim()}`);
  }
  return { system, user: lines.join('\n'), variant: v.id, version: PROMPT_VERSION };
}

export function buildJudge(brief: Brief, draft: string, cache = false): { system: SystemBlock[]; user: string } {
  const p = profile(brief.locale);
  const text = [
    'You grade product descriptions against the product facts. Be strict about accuracy: any claim not in the facts caps accuracy at 2.',
    `The description is written in ${p.name}. Judge tone against this style guide:\n${p.styleGuide.map((s) => `- ${s}`).join('\n')}`,
    'Usefulness: does it help a shopper decide (what it is, what it is for, size, material, care)? Tone: warm and practical, never pushy.',
  ].join('\n\n');
  return {
    system: [{ type: 'text', text, ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }],
    user: `Facts:\n${factLines(brief.facts)}\n\n<description>\n${draft}\n</description>`,
  };
}

/** Strip wrappers models occasionally add despite instructions: quotes around the whole text, a label. */
export function cleanDraft(text: string): string {
  let t = text.trim();
  t = t.replace(/^(?:description|descripción|description du produit)\s*:\s*/i, '');
  const pairs: [string, string][] = [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
  ];
  for (const [o, c] of pairs) {
    if (t.startsWith(o) && t.endsWith(c) && t.length > 2 && !t.slice(1, -1).includes(c)) t = t.slice(o.length, t.length - c.length).trim();
  }
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
