import type { Brief, Locale } from './domain';
import { LOCALE_PROFILES } from './locales';
import { MemoryQueue } from './queue';
import { checkClaims, checkHype } from './text/claims';
import { fnv1a, mulberry32 } from './text/similarity';
import { checkMeasurements } from './text/units';

/**
 * Offline demo mode: a simulated model and a sample catalogue, so the API and the review app can be
 * tried without an API key, Redis or Postgres. The simulated writer makes the kinds of mistakes real
 * drafts get (hype, an unsupported claim, a wrong size, too short) at fixed rates, so the review queue
 * fills with realistic reasons.
 */

/* ------------------------------------------------------------------ sample catalogue */

interface ProductLine {
  category: string;
  noun: Record<Locale, string>;
  materials: Record<Locale, string>[];
  size: Record<Locale, string>;
  sizeKey: string;
  extra?: { key: string; value: Record<Locale, string> };
  care: Record<Locale, string>;
  banned: string[];
}

const LINES: ProductLine[] = [
  {
    category: 'textiles',
    noun: { 'en-US': 'Throw', 'es-US': 'Manta', 'fr-CA': 'Jeté' },
    materials: [
      { 'en-US': 'cotton', 'es-US': 'algodón', 'fr-CA': 'coton' },
      { 'en-US': 'linen', 'es-US': 'lino', 'fr-CA': 'lin' },
      { 'en-US': 'wool', 'es-US': 'lana', 'fr-CA': 'laine' },
    ],
    size: { 'en-US': '50 x 60 in', 'es-US': '50 x 60 in', 'fr-CA': '127 x 152 cm' },
    sizeKey: 'size',
    care: { 'en-US': 'machine wash cold', 'es-US': 'lavar a máquina en frío', 'fr-CA': 'lavable à la machine à froid' },
    banned: ['waterproof'],
  },
  {
    category: 'rugs',
    noun: { 'en-US': 'Rug', 'es-US': 'Alfombra', 'fr-CA': 'Tapis' },
    materials: [
      { 'en-US': 'wool', 'es-US': 'lana', 'fr-CA': 'laine' },
      { 'en-US': 'jute', 'es-US': 'yute', 'fr-CA': 'jute' },
    ],
    size: { 'en-US': '5 x 8 ft', 'es-US': '5 x 8 ft', 'fr-CA': '152 x 244 cm' },
    sizeKey: 'size',
    extra: { key: 'pile height', value: { 'en-US': '0.5 in', 'es-US': '0.5 in', 'fr-CA': '1,3 cm' } },
    care: { 'en-US': 'vacuum regularly; spot clean', 'es-US': 'aspirar con regularidad; limpiar las manchas', 'fr-CA': 'passer l’aspirateur régulièrement; nettoyer les taches' },
    banned: [],
  },
  {
    category: 'furniture',
    noun: { 'en-US': 'Side Table', 'es-US': 'Mesa auxiliar', 'fr-CA': 'Table d’appoint' },
    materials: [
      { 'en-US': 'solid oak', 'es-US': 'roble macizo', 'fr-CA': 'chêne massif' },
      { 'en-US': 'walnut veneer', 'es-US': 'chapa de nogal', 'fr-CA': 'placage de noyer' },
    ],
    size: { 'en-US': '18 x 18 x 22 in', 'es-US': '18 x 18 x 22 in', 'fr-CA': '46 x 46 x 56 cm' },
    sizeKey: 'dimensions',
    extra: { key: 'assembly', value: { 'en-US': 'legs screw in by hand', 'es-US': 'las patas se enroscan a mano', 'fr-CA': 'les pattes se vissent à la main' } },
    care: { 'en-US': 'wipe with a dry cloth', 'es-US': 'limpiar con un paño seco', 'fr-CA': 'essuyer avec un linge sec' },
    banned: [],
  },
  {
    category: 'kitchen',
    noun: { 'en-US': 'Skillet', 'es-US': 'Sartén', 'fr-CA': 'Poêle' },
    materials: [{ 'en-US': 'cast iron', 'es-US': 'hierro fundido', 'fr-CA': 'fonte' }],
    size: { 'en-US': '10 in', 'es-US': '10 in', 'fr-CA': '25 cm' },
    sizeKey: 'diameter',
    extra: { key: 'weight', value: { 'en-US': '5 lb', 'es-US': '5 lb', 'fr-CA': '2,3 kg' } },
    care: { 'en-US': 'hand wash and dry at once', 'es-US': 'lavar a mano y secar de inmediato', 'fr-CA': 'laver à la main et sécher aussitôt' },
    banned: [],
  },
  {
    category: 'decor',
    noun: { 'en-US': 'Vase', 'es-US': 'Jarrón', 'fr-CA': 'Vase' },
    materials: [
      { 'en-US': 'recycled glass', 'es-US': 'vidrio reciclado', 'fr-CA': 'verre recyclé' },
      { 'en-US': 'stoneware', 'es-US': 'gres', 'fr-CA': 'grès' },
    ],
    size: { 'en-US': '12 in', 'es-US': '12 in', 'fr-CA': '30 cm' },
    sizeKey: 'height',
    care: { 'en-US': 'hand wash', 'es-US': 'lavar a mano', 'fr-CA': 'laver à la main' },
    banned: [],
  },
  {
    category: 'baby',
    noun: { 'en-US': 'Crib Sheet', 'es-US': 'Sábana para cuna', 'fr-CA': 'Drap de berceau' },
    materials: [{ 'en-US': 'cotton', 'es-US': 'algodón', 'fr-CA': 'coton' }],
    size: { 'en-US': '28 x 52 in', 'es-US': '28 x 52 in', 'fr-CA': '71 x 132 cm' },
    sizeKey: 'size',
    extra: { key: 'age range', value: { 'en-US': '0-24 months', 'es-US': '0 a 24 meses', 'fr-CA': '0 à 24 mois' } },
    care: { 'en-US': 'machine wash warm', 'es-US': 'lavar a máquina en agua tibia', 'fr-CA': 'lavable à la machine à l’eau tiède' },
    banned: ['hypoallergenic', 'safe for babies'],
  },
  {
    category: 'outdoor',
    noun: { 'en-US': 'Planter', 'es-US': 'Maceta', 'fr-CA': 'Jardinière' },
    materials: [{ 'en-US': 'terracotta', 'es-US': 'terracota', 'fr-CA': 'terre cuite' }],
    size: { 'en-US': '14 in', 'es-US': '14 in', 'fr-CA': '36 cm' },
    sizeKey: 'diameter',
    care: { 'en-US': 'bring indoors before frost', 'es-US': 'guardar bajo techo antes de las heladas', 'fr-CA': 'rentrer avant le gel' },
    banned: ['weatherproof'],
  },
];

export const COLLECTIONS = ['Harbor', 'Alder', 'Juniper', 'Marlow', 'Wren', 'Hollis', 'Calder', 'Linden', 'Sable', 'Tamsin'];

function productName(line: ProductLine, collection: string, locale: Locale): string {
  // Spanish and French put the noun first: "Manta Harbor", "Jeté Harbor".
  return locale === 'en-US' ? `${collection} ${line.noun[locale]}` : `${line.noun[locale]} ${collection}`;
}

/**
 * `count` SKUs, each in all three locales. Every 25th SKU gets a French size that disagrees with the
 * English one, so the cross-locale check has something to find.
 */
export function demoBriefs(count: number, seed = 7): Brief[] {
  const rnd = mulberry32(seed);
  const out: Brief[] = [];
  for (let n = 0; n < count; n++) {
    const line = LINES[n % LINES.length];
    const collection = COLLECTIONS[Math.floor(rnd() * COLLECTIONS.length)];
    const material = line.materials[Math.floor(rnd() * line.materials.length)];
    const sku = `${line.category.slice(0, 3).toUpperCase()}-${collection.toUpperCase()}-${String(100 + n).padStart(3, '0')}`;
    for (const locale of ['en-US', 'es-US', 'fr-CA'] as Locale[]) {
      let size = line.size[locale];
      if (locale === 'fr-CA' && n % 25 === 24) size = size.replace(/(\d+)/, (d) => String(Number(d) + 20));
      const facts: Record<string, string> = { name: productName(line, collection, locale), material: material[locale], [line.sizeKey]: size };
      if (line.extra) facts[line.extra.key] = line.extra.value[locale];
      facts.care = line.care[locale];
      out.push({ sku, locale, category: line.category, facts, mustMention: [material[locale], size], banned: [...line.banned] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ simulated model */

const CATEGORY_LINE: Record<string, Record<Locale, string>> = {
  textiles: {
    'en-US': 'It adds a soft, layered look to a sofa or the foot of a bed and is easy to fold away when you need the space.',
    'es-US': 'Aporta un aspecto suave y acogedor al sofá o a los pies de la cama, y se dobla con facilidad cuando necesita espacio.',
    'fr-CA': 'Il apporte une touche douce au canapé ou au pied du lit, et se plie facilement quand vous avez besoin de place.',
  },
  rugs: {
    'en-US': 'It suits a living room or bedroom and gives the furniture around it a clear place to sit.',
    'es-US': 'Va bien en una sala o un dormitorio y le da a los muebles a su alrededor un lugar definido.',
    'fr-CA': 'Il convient au salon comme à la chambre et donne aux meubles qui l’entourent un point d’ancrage.',
  },
  furniture: {
    'en-US': 'Its simple lines fit a range of rooms, with room on top for a lamp, a book and a cup.',
    'es-US': 'Sus líneas sencillas encajan en muchos espacios, con lugar arriba para una lámpara, un libro y una taza.',
    'fr-CA': 'Ses lignes simples s’intègrent à bien des pièces, avec assez de place pour une lampe, un livre et une tasse.',
  },
  kitchen: {
    'en-US': 'It is made for everyday cooking, from a quick breakfast to a slow Sunday dinner.',
    'es-US': 'Está hecha para cocinar a diario, desde un desayuno rápido hasta una cena tranquila de domingo.',
    'fr-CA': 'Elle est faite pour cuisiner au quotidien, du déjeuner rapide au souper du dimanche.',
  },
  decor: {
    'en-US': 'It brings a quiet accent to a shelf, a mantel or the middle of the table.',
    'es-US': 'Aporta un toque discreto a un estante, la repisa o el centro de la mesa.',
    'fr-CA': 'Il apporte une touche discrète à une étagère, au manteau de cheminée ou au centre de la table.',
  },
  baby: {
    'en-US': 'It is sized for a standard crib mattress and is easy to change in the middle of the night.',
    'es-US': 'Tiene el tamaño de un colchón de cuna estándar y se cambia fácilmente en mitad de la noche.',
    'fr-CA': 'Il est conçu pour un matelas de berceau standard et se change facilement en pleine nuit.',
  },
  outdoor: {
    'en-US': 'It is made for patios and balconies, with room for herbs or a small shrub.',
    'es-US': 'Está pensada para patios y balcones, con espacio para hierbas o un arbusto pequeño.',
    'fr-CA': 'Elle est pensée pour les terrasses et les balcons, avec de la place pour des fines herbes ou un petit arbuste.',
  },
};

/** Grammatical gender of each category's noun in Spanish and French (la manta, el jarrón; le jeté, la poêle). */
const GENDER: Record<string, { es: 'm' | 'f'; fr: 'm' | 'f' }> = {
  textiles: { es: 'f', fr: 'm' },
  rugs: { es: 'f', fr: 'm' },
  furniture: { es: 'f', fr: 'f' },
  kitchen: { es: 'f', fr: 'f' },
  decor: { es: 'm', fr: 'm' },
  baby: { es: 'f', fr: 'm' },
  outdoor: { es: 'f', fr: 'f' },
};

function opening(locale: Locale, category: string, name: string, material: string): string {
  const g = GENDER[category] ?? { es: 'm', fr: 'm' };
  if (locale === 'es-US') return g.es === 'f' ? `La ${name} está hecha de ${material}.` : `El ${name} está hecho de ${material}.`;
  if (locale === 'fr-CA') return g.fr === 'f' ? `La ${name} est faite de ${material}.` : `Le ${name} est fait de ${material}.`;
  return `The ${name} is made from ${material}.`;
}

function sizeSentence(locale: Locale, category: string, size: string): string {
  if (locale === 'es-US') return `Mide ${size}.`;
  if (locale === 'fr-CA') return `${(GENDER[category]?.fr ?? 'm') === 'f' ? 'Elle' : 'Il'} mesure ${size}.`;
  return `It measures ${size}.`;
}

const TEMPLATES: Record<Locale, { care: string; close: string; extra: string }> = {
  'en-US': {
    care: 'Care is simple: {care}.',
    extra: 'The {key} is {value}.',
    close: 'A practical choice for daily use that should look good for years.',
  },
  'es-US': {
    care: 'Su cuidado es sencillo: {care}.',
    extra: 'Además: {value}.',
    close: 'Una opción práctica para el uso diario que se verá bien durante años.',
  },
  'fr-CA': {
    care: 'Son entretien est simple : {care}.',
    extra: 'À noter : {value}.',
    close: 'Un choix pratique pour tous les jours, qui restera beau pendant des années.',
  },
};

const FLAWS: Record<Locale, { hype: string; claim: string }> = {
  'en-US': { hype: 'It is an amazing addition to any home!', claim: 'It is hypoallergenic and eco-friendly.' },
  'es-US': { hype: '¡Es una incorporación increíble para cualquier hogar!', claim: 'Es hipoalergénica y ecológica.' },
  'fr-CA': { hype: 'C’est un ajout incroyable à tout intérieur !', claim: 'Il est hypoallergénique et écologique.' },
};

function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
}

function localeFromSystem(system: string): Locale {
  for (const p of Object.values(LOCALE_PROFILES)) if (system.includes(`in ${p.name}`)) return p.locale;
  return 'en-US';
}

function parseFacts(text: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([^:\n]{1,40}):\s(.+)$/.exec(line.trim());
    if (m && !/^(Use this|Include these|Work in|Never say|A reviewer|Facts)/.test(m[1])) facts[m[1].trim()] = m[2].trim();
  }
  return facts;
}

export type Flaw = 'hype' | 'claim' | 'size' | 'short' | null;

/** Which mistake (if any) the simulated writer makes for a product. Revisions are always clean. */
export function flawFor(name: string, revision: boolean): Flaw {
  if (revision) return null;
  const h = fnv1a(name) % 100;
  if (h < 10) return 'hype';
  if (h < 17) return 'claim';
  if (h < 22) return 'size';
  if (h < 26) return 'short';
  return null;
}

export function simulateDraft(locale: Locale, category: string, facts: Record<string, string>, revision: boolean): string {
  const t = TEMPLATES[locale];
  const name = facts.name ?? 'product';
  const sizeKey = ['size', 'dimensions', 'diameter', 'height'].find((k) => facts[k]);
  const size = sizeKey ? facts[sizeKey] : '';
  const flaw = flawFor(name, revision);
  const parts = [opening(locale, category, name, facts.material ?? '')];
  if (size) parts.push(sizeSentence(locale, category, flaw === 'size' ? size.replace(/(\d+)/, (d) => String(Number(d) + 10)) : size));
  if (flaw !== 'short') {
    parts.push(CATEGORY_LINE[category]?.[locale] ?? CATEGORY_LINE.decor[locale]);
    for (const [k, v] of Object.entries(facts)) {
      if (['name', 'material', 'care', sizeKey].includes(k)) continue;
      parts.push(fill(t.extra, { key: k, value: v }));
    }
  }
  if (facts.care) parts.push(fill(t.care, { care: facts.care }));
  if (flaw === 'hype') parts.push(FLAWS[locale].hype);
  if (flaw === 'claim') parts.push(FLAWS[locale].claim);
  parts.push(t.close);
  return parts.join(' ');
}

/** Grades a careful judge would give: accuracy drops for every unsupported claim or wrong measurement. */
export function simulateVerdict(locale: Locale, facts: Record<string, string>, draft: string) {
  const blocking = [...checkClaims(facts, draft, locale), ...checkMeasurements(facts, draft, locale)].filter((f) => f.severity === 'block').length;
  const hype = checkHype(facts, draft, locale).length + (draft.includes('!') ? 1 : 0);
  const words = draft.split(/\s+/).filter(Boolean).length;
  return {
    rationale: blocking ? 'The description makes claims the facts do not support.' : hype ? 'Accurate, but the tone leans on hype.' : 'Accurate and useful; the tone fits the house style.',
    accuracy: blocking ? 2 : 5,
    usefulness: words < 40 ? 3 : words > 60 ? 5 : 4,
    tone: Math.max(1, 5 - hype * 2),
  };
}

interface SimRequest {
  system?: { text: string; cache_control?: unknown }[] | string;
  messages: { content: string }[];
  output_config?: { format?: unknown };
}

/** Drop-in for the Anthropic client's `beta.messages.create`, with token usage and prompt-cache hits. */
export class SimulatedClient {
  private readonly seenPrefixes = new Set<number>();
  calls = 0;

  constructor(private readonly latencyMs = 120) {}

  readonly beta = {
    messages: {
      create: (req: SimRequest) => this.create(req),
    },
  };

  private async create(req: SimRequest) {
    this.calls++;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs * (0.5 + Math.random())));
    const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n');
    const cached = Array.isArray(req.system) && req.system.some((b) => b.cache_control);
    const user = String(req.messages[0]?.content ?? '');
    const locale = localeFromSystem(system);
    let text: string;
    if (req.output_config?.format) {
      const facts = parseFacts(user.split('<description>')[0]);
      const draft = /<description>\n([\s\S]*)\n<\/description>/.exec(user)?.[1] ?? '';
      text = JSON.stringify(simulateVerdict(locale, facts, draft));
    } else {
      const category = Object.entries({ textiles: 'Bedding', rugs: 'Rugs', furniture: 'Furniture', kitchen: 'Kitchen', decor: 'Home decor', baby: 'Baby', outdoor: 'Outdoor' }).find(([, label]) => system.includes(`Category: ${label}`))?.[0] ?? 'decor';
      text = simulateDraft(locale, category, parseFacts(user), user.includes('A reviewer asked for changes'));
    }
    const systemTokens = Math.ceil(system.length / 4);
    const prefixKey = fnv1a(system);
    const hit = cached && this.seenPrefixes.has(prefixKey);
    if (cached) this.seenPrefixes.add(prefixKey);
    return {
      id: `sim_${this.calls}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: Math.ceil(user.length / 4) + (cached ? 0 : systemTokens),
        output_tokens: Math.ceil(text.length / 4),
        cache_read_input_tokens: hit ? systemTokens : 0,
        cache_creation_input_tokens: cached && !hit ? systemTokens : 0,
      },
    };
  }
}

/**
 * A MemoryQueue that works through its jobs by itself, like a worker process would: added jobs run on
 * the next tick, and delayed ones once their time comes.
 */
export class AutoDrainQueue extends MemoryQueue {
  private draining = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(now?: () => number, tickMs = 1000) {
    super(now);
    this.timer = setInterval(() => void this.kick(), tickMs);
    this.timer.unref();
  }

  async add(itemId: string, opts: { delayMs?: number; priority?: number } = {}) {
    await super.add(itemId, opts);
    setImmediate(() => void this.kick());
  }

  private async kick() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain();
    } finally {
      this.draining = false;
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
