import { addMs, Clock, DAY, utcDay } from './clock';
import { addUsage, EMPTY_USAGE, Usage } from './domain';
import { BudgetExceededError } from './errors';

/**
 * Token accounting and the daily budget guard. Prices are USD per million tokens. Cache writes are
 * billed at 1.25× the input price (5-minute TTL), cache reads at the model's cache-read price.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function priceFor(model: string | undefined, fallback = 'claude-opus-5-5'): ModelPrice {
  return (model && PRICES[model]) || PRICES[fallback];
}

export function costUsd(u: Omit<Usage, 'costUsd' | 'calls'>, price: ModelPrice): number {
  const c = (u.inputTokens * price.input + u.outputTokens * price.output + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite) / 1_000_000;
  return Math.round(c * 1e6) / 1e6;
}

/** Shape of `response.usage` on a Messages API response (fields may be absent or null). */
export interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Usage for one API call. A response with no usage block (as from test fakes) counts as one free call. */
export function usageFromResponse(res: { model?: string; usage?: RawUsage | null }, requestedModel?: string): Usage {
  const u = res.usage ?? {};
  const tokens = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  return { calls: 1, ...tokens, costUsd: costUsd(tokens, priceFor(res.model, requestedModel)) };
}

/** Rough pre-flight estimate for a batch: about 4 characters per token for prompts and outputs. */
export function estimateBatchCost(briefCount: number, avgPromptChars = 2400, avgOutputTokens = 260, model = 'claude-opus-5-5'): number {
  const p = priceFor(model);
  // Each item costs one generation and one judge call; the judge reads the draft as well.
  const inputTokens = briefCount * 2 * (avgPromptChars / 4) + briefCount * avgOutputTokens;
  const outputTokens = briefCount * (avgOutputTokens + 120);
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 100) / 100;
}

/** Where daily spend is recorded. The store implements it; a Map is enough for one process. */
export interface UsageLedger {
  record(day: string, usage: Usage): Promise<void>;
  spent(day: string): Promise<Usage>;
  /** Spend per day in [from, to], inclusive, missing days omitted. */
  range(from: string, to: string): Promise<{ day: string; usage: Usage }[]>;
}

export class MemoryLedger implements UsageLedger {
  private readonly days = new Map<string, Usage>();

  async record(day: string, usage: Usage): Promise<void> {
    this.days.set(day, addUsage(this.days.get(day) ?? { ...EMPTY_USAGE }, usage));
  }

  async spent(day: string): Promise<Usage> {
    return this.days.get(day) ?? { ...EMPTY_USAGE };
  }

  async range(from: string, to: string): Promise<{ day: string; usage: Usage }[]> {
    return [...this.days.entries()]
      .filter(([d]) => d >= from && d <= to)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, usage]) => ({ day, usage }));
  }
}

/**
 * Stops new model calls once the day's spend reaches the limit. Work that is refused is deferred to the
 * next UTC day rather than failed, so a runaway batch can't burn the month's budget overnight.
 */
export class BudgetGuard {
  constructor(
    private readonly ledger: UsageLedger,
    private readonly clock: Clock,
    private readonly dailyLimitUsd: number,
  ) {}

  get enabled(): boolean {
    return this.dailyLimitUsd > 0;
  }

  async assertAvailable(): Promise<void> {
    if (!this.enabled) return;
    const now = this.clock.now();
    const spent = await this.ledger.spent(utcDay(now));
    if (spent.costUsd >= this.dailyLimitUsd) {
      throw new BudgetExceededError(spent.costUsd, this.dailyLimitUsd, nextUtcMidnight(now));
    }
  }

  async record(usage: Usage): Promise<void> {
    if (usage.calls === 0) return;
    await this.ledger.record(utcDay(this.clock.now()), usage);
  }

  async status(): Promise<{ day: string; spentUsd: number; limitUsd: number | null; remainingUsd: number | null }> {
    const day = utcDay(this.clock.now());
    const spent = await this.ledger.spent(day);
    return {
      day,
      spentUsd: spent.costUsd,
      limitUsd: this.enabled ? this.dailyLimitUsd : null,
      remainingUsd: this.enabled ? Math.max(0, Math.round((this.dailyLimitUsd - spent.costUsd) * 1e6) / 1e6) : null,
    };
  }
}

export function nextUtcMidnight(now: Date): Date {
  const start = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  return addMs(new Date(start), DAY);
}

/** Collects usage across the calls one unit of work makes. */
export class UsageMeter {
  private total: Usage = { ...EMPTY_USAGE };

  add(u: Usage): void {
    this.total = addUsage(this.total, u);
  }

  get value(): Usage {
    return this.total;
  }
}
