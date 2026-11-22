import { effectiveBanned, categoryRule, missingRequiredFacts } from './categories';
import type { Brief, Finding, Score, Severity } from './domain';
import { checkGlossary, GlossaryTerm } from './glossary';
import { fold, profile } from './locales';
import { checkClaims, checkEmphasis, checkHype } from './text/claims';
import { readability, ReadabilityReport } from './text/readability';
import { findPhrase, normalizeForCompare, wordCount } from './text/tokenize';
import { checkTypography } from './text/typography';
import { checkMeasurements } from './text/units';

/**
 * Deterministic checks: cheap, explainable, and run before the LLM judge. Each check returns findings;
 * `block` findings send the draft to a human whatever the score.
 */
export interface CheckContext {
  brief: Brief;
  draft: string;
  glossary: GlossaryTerm[];
}

export interface Check {
  id: string;
  description: string;
  run(ctx: CheckContext): Finding[];
}

/** Text normalisation for "must mention" matching: case, accents, spacing, × vs x, curly quotes. */
export function mentionKey(s: string): string {
  return fold(normalizeForCompare(s))
    .replace(/×/g, 'x')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 x ');
}

export function missingMentions(brief: Brief, draft: string): string[] {
  const hay = mentionKey(draft);
  return brief.mustMention.filter((m) => !hay.includes(mentionKey(m)));
}

export function bannedHits(brief: Brief, draft: string): { phrase: string; start: number; end: number }[] {
  return effectiveBanned(brief.category, brief.banned).flatMap((b) => findPhrase(draft, b).map((h) => ({ phrase: b, ...h })));
}

export const CHECKS: Check[] = [
  {
    id: 'mentions',
    description: 'Every "must mention" phrase appears in the draft.',
    run: ({ brief, draft }) =>
      missingMentions(brief, draft).map((m) => ({ code: 'fact.missing', severity: 'block' as Severity, message: `missing "${m}"` })),
  },
  {
    id: 'banned',
    description: "No banned claim from the brief or the category's list.",
    run: ({ brief, draft }) => {
      const seen = new Set<string>();
      return bannedHits(brief, draft)
        .filter((h) => !seen.has(h.phrase.toLowerCase()) && seen.add(h.phrase.toLowerCase()))
        .map((h) => ({ code: 'claim.banned', severity: 'block' as Severity, message: `banned claim "${h.phrase}"`, start: h.start, end: h.end }));
    },
  },
  {
    id: 'length',
    description: "Word count inside the category's range.",
    run: ({ brief, draft }) => {
      const [min, max] = categoryRule(brief.category).words;
      const n = wordCount(draft);
      if (n >= min && n <= max) return [];
      return [{ code: 'length', severity: 'warn', message: `${n} words (expected ${min}–${max})` }];
    },
  },
  {
    id: 'units',
    description: 'Every measurement in the draft is backed by a fact.',
    run: ({ brief, draft }) => checkMeasurements(brief.facts, draft, brief.locale),
  },
  {
    id: 'claims',
    description: 'No unsupported health, safety, environmental, origin, warranty or promotional claims.',
    run: ({ brief, draft }) => checkClaims(brief.facts, draft, brief.locale),
  },
  {
    id: 'hype',
    description: 'No hype words or unsupported superlatives.',
    run: ({ brief, draft }) => checkHype(brief.facts, draft, brief.locale),
  },
  {
    id: 'emphasis',
    description: 'No exclamation marks or words in capitals.',
    run: ({ brief, draft }) => checkEmphasis(draft, brief.brand),
  },
  {
    id: 'typography',
    description: 'Locale typography: spacing, quotes, decimals, inverted marks, no markup.',
    run: ({ brief, draft }) => checkTypography(draft, brief.locale),
  },
  {
    id: 'glossary',
    description: 'House terminology: forbidden and preferred terms, names kept verbatim.',
    run: ({ brief, draft, glossary }) => checkGlossary(glossary, brief, draft),
  },
  {
    id: 'keywords',
    description: 'Search keywords used naturally: at least once, never stuffed.',
    run: ({ brief, draft }) => {
      const out: Finding[] = [];
      for (const k of brief.keywords ?? []) {
        const hits = findPhrase(draft, k);
        if (!hits.length) out.push({ code: 'seo.keyword-missing', severity: 'info', message: `keyword "${k}" not used` });
        else if (hits.length > 2) out.push({ code: 'seo.keyword-stuffing', severity: 'warn', message: `keyword "${k}" used ${hits.length} times`, start: hits[2].start, end: hits[2].end });
      }
      return out;
    },
  },
  {
    id: 'brief',
    description: "The brief carries the facts its category needs.",
    run: ({ brief }) =>
      missingRequiredFacts(brief.category, brief.facts).map((k) => ({
        code: 'brief.incomplete',
        severity: 'warn' as Severity,
        message: `brief has no "${k}" fact, which ${categoryRule(brief.category).label.toLowerCase()} copy needs`,
      })),
  },
  {
    id: 'repetition',
    description: 'No word-for-word repetition of a sentence opening.',
    run: ({ draft }) => {
      const starts = new Map<string, number>();
      const out: Finding[] = [];
      for (const m of draft.matchAll(/(?:^|[.!?]\s+)([\p{L}]+\s+[\p{L}]+\s+[\p{L}]+)/gu)) {
        const k = m[1].toLowerCase();
        const seen = starts.get(k);
        if (seen !== undefined) {
          const start = m.index! + m[0].length - m[1].length;
          out.push({ code: 'style.repetition', severity: 'warn', message: `two sentences start with "${m[1]}"`, start, end: start + m[1].length });
        } else starts.set(k, m.index!);
      }
      return out;
    },
  },
];

const SEVERITY_ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

export function sortFindings(fs: Finding[]): Finding[] {
  return fs.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.start ?? 1e9) - (b.start ?? 1e9) || a.code.localeCompare(b.code));
}

export interface ChecksResult {
  findings: Finding[];
  readability: ReadabilityReport | null;
}

export function runChecks(ctx: CheckContext, disabled: ReadonlySet<string> = new Set()): ChecksResult {
  const findings: Finding[] = [];
  for (const c of CHECKS) {
    if (disabled.has(c.id)) continue;
    try {
      findings.push(...c.run(ctx));
    } catch (e) {
      // A broken check must not take scoring down; surface it so someone fixes it.
      findings.push({ code: `check.error.${c.id}`, severity: 'warn', message: `check failed: ${(e as Error).message}` });
    }
  }
  const r = readability(ctx.draft, ctx.brief.locale);
  if (r && r.score < 30) {
    findings.push({ code: 'readability', severity: 'warn', message: `hard to read (${r.formula} ${r.score}, ${r.band})` });
  } else if (r && r.longestSentenceWords > 35) {
    findings.push({ code: 'readability.long-sentence', severity: 'info', message: `a sentence runs to ${r.longestSentenceWords} words` });
  }
  return { findings: sortFindings(findings), readability: r };
}

/** The old score components, kept so the total stays comparable with drafts scored before findings existed. */
export function deterministicScore(brief: Brief, draft: string, glossary: GlossaryTerm[] = []): Omit<Score, 'judge' | 'total'> & { findings: Finding[]; readability: number | null } {
  const missing = missingMentions(brief, draft);
  const banned = [...new Set(bannedHits(brief, draft).map((h) => h.phrase))];
  const words = wordCount(draft);
  // The score's length component keeps the original 40–120 band; the category range is a finding.
  const lengthOk = words >= 40 && words <= 120;
  const { findings, readability: r } = runChecks({ brief, draft, glossary });
  const notes = [
    ...missing.map((m) => `missing "${m}"`),
    ...banned.map((b) => `banned claim "${b}"`),
    ...(lengthOk ? [] : [`${words} words`]),
    ...findings.filter((f) => f.code !== 'fact.missing' && f.code !== 'claim.banned' && f.code !== 'length' && f.severity !== 'info').map((f) => `${f.code}: ${f.message}`),
  ];
  return {
    facts: brief.mustMention.length ? 1 - missing.length / brief.mustMention.length : 1,
    claims: banned.length ? 0 : 1,
    length: lengthOk ? 1 : 0,
    notes,
    findings,
    readability: r?.score ?? null,
  };
}

/** Weighted total. Accuracy counts double inside the judge component. */
export function combine(d: { facts: number; claims: number; length: number }, judge: number | null): number {
  if (judge === null) return 0;
  return Math.round((0.25 * d.facts + 0.25 * d.claims + 0.1 * d.length + 0.4 * judge) * 1000) / 1000;
}

export function judgeScore(v: { accuracy: number; usefulness: number; tone: number } | null): number | null {
  return v ? ((v.accuracy - 1) * 2 + (v.usefulness - 1) + (v.tone - 1)) / 16 : null;
}

export function describeChecks(): { id: string; description: string }[] {
  return CHECKS.map((c) => ({ id: c.id, description: c.description }));
}

/** Locale-aware label for UIs and prompts. */
export function localeName(brief: Brief): string {
  return profile(brief.locale).name;
}
