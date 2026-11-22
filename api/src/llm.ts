import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { combine, deterministicScore as deterministic, judgeScore } from './checks';
import type { Brief, Score, Usage, Verdict as VerdictT } from './domain';
import { DomainError } from './errors';
import type { GlossaryTerm } from './glossary';
import { buildGeneration, buildJudge, cleanDraft, generationSystem as baseSystem, PROMPT_VERSION } from './prompts';
import { UsageMeter, usageFromResponse } from './usage';

export const MODEL = 'claude-opus-5-5';

type Client = Pick<Anthropic, 'beta'>;

const COMMON = {
  model: MODEL,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default' as const,
};

/** The model declined (after server-side fallbacks). Retrying the same request will not help. */
export class ModelRefusalError extends DomainError {
  constructor(readonly category: string | null) {
    super(`generation declined${category ? ` (${category})` : ''}`);
  }
}

/** The response was cut off at max_tokens. Worth one more try. */
export class TruncatedOutputError extends Error {
  constructor() {
    super('model output hit max_tokens');
    this.name = 'TruncatedOutputError';
  }
}

export function generationSystem(locale: Brief['locale']) {
  return baseSystem(locale);
}

function textOf(res: { content: unknown[] }): string {
  return (res.content as { type: string; text?: string }[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export interface GenerateOptions {
  variant?: string | null;
  glossary?: GlossaryTerm[];
  previousDraft?: string | null;
  promptCache?: boolean;
}

export interface GeneratedDraft {
  text: string;
  usage: Usage;
  variant: string;
  promptVersion: string;
  model: string;
}

export async function generateDraft(client: Client, brief: Brief, feedback?: string, opts: GenerateOptions = {}): Promise<GeneratedDraft> {
  const prompt = buildGeneration(brief, {
    variant: opts.variant,
    glossary: opts.glossary,
    feedback: feedback ?? null,
    previousDraft: opts.previousDraft,
    cache: opts.promptCache ?? false,
  });
  const res = await client.beta.messages.create({
    ...COMMON,
    max_tokens: 2000,
    system: prompt.system,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt.user }],
  });
  if (res.stop_reason === 'refusal') throw new ModelRefusalError((res as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? null);
  if (res.stop_reason === 'max_tokens') throw new TruncatedOutputError();
  return {
    text: cleanDraft(textOf(res)),
    usage: usageFromResponse(res, MODEL),
    variant: prompt.variant,
    promptVersion: prompt.version,
    model: res.model ?? MODEL,
  };
}

/** Backwards-compatible wrapper: just the text. */
export async function generate(client: Client, brief: Brief, feedback?: string): Promise<string> {
  return (await generateDraft(client, brief, feedback)).text;
}

const Verdict = z.object({
  rationale: z.string(),
  accuracy: z.number().int().min(1).max(5),
  usefulness: z.number().int().min(1).max(5),
  tone: z.number().int().min(1).max(5),
});

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: 'Two sentences, written before the scores' },
    accuracy: { type: 'integer', description: '1-5: every claim supported by the facts' },
    usefulness: { type: 'integer', description: '1-5: helps a shopper decide' },
    tone: { type: 'integer', description: '1-5: warm and practical, no hype' },
  },
  required: ['rationale', 'accuracy', 'usefulness', 'tone'],
  additionalProperties: false,
};

export async function judgeDraft(client: Client, brief: Brief, draft: string, promptCache = false): Promise<{ verdict: VerdictT | null; usage: Usage }> {
  const prompt = buildJudge(brief, draft, promptCache);
  const res = await client.beta.messages.create({
    ...COMMON,
    max_tokens: 2000,
    system: prompt.system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: prompt.user }],
  });
  const usage = usageFromResponse(res, MODEL);
  if (res.stop_reason !== 'end_turn') return { verdict: null, usage };
  let json: unknown;
  try {
    json = JSON.parse(textOf(res));
  } catch {
    return { verdict: null, usage };
  }
  const parsed = Verdict.safeParse(json);
  return { verdict: parsed.success ? parsed.data : null, usage };
}

/** LLM judge via structured output (JSON schema on output_config.format). Returns null if no verdict. */
export async function judge(client: Client, brief: Brief, draft: string): Promise<z.infer<typeof Verdict> | null> {
  return (await judgeDraft(client, brief, draft)).verdict;
}

/** Deterministic checks first; the judge only adds what code can't check. */
export function deterministicScore(brief: Brief, draft: string, glossary: GlossaryTerm[] = []) {
  return deterministic(brief, draft, glossary);
}

export interface ScoreOptions {
  glossary?: GlossaryTerm[];
  promptCache?: boolean;
  /** Skip the judge when a blocking finding already guarantees human review (saves a model call). */
  skipJudgeWhenBlocked?: boolean;
}

export async function scoreDraft(client: Client, brief: Brief, draft: string, opts: ScoreOptions = {}): Promise<{ score: Score; usage: Usage }> {
  const d = deterministic(brief, draft, opts.glossary ?? []);
  const meter = new UsageMeter();
  let v: VerdictT | null = null;
  const blocked = d.findings.some((f) => f.severity === 'block');
  let skipped = false;
  if (opts.skipJudgeWhenBlocked && blocked) {
    skipped = true;
  } else {
    const r = await judgeDraft(client, brief, draft, opts.promptCache);
    meter.add(r.usage);
    v = r.verdict;
  }
  const js = judgeScore(v);
  const score: Score = {
    facts: d.facts,
    claims: d.claims,
    length: d.length,
    judge: js,
    total: combine(d, js),
    notes: v ? [...d.notes, `judge: ${v.rationale}`] : [...d.notes, skipped ? 'judge: skipped (blocking finding)' : 'judge: no verdict'],
    findings: d.findings,
    readability: d.readability,
    verdict: v,
  };
  return { score, usage: meter.value };
}

export async function score(client: Client, brief: Brief, draft: string): Promise<Score> {
  return (await scoreDraft(client, brief, draft)).score;
}

export { PROMPT_VERSION };
