import { z } from 'zod';
import type { RoutingPolicy } from './domain';

const csv = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s.trim() === '') return def;
      const n = Number(s);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: "${s}"` });
        return z.NEVER;
      }
      return n;
    });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s.trim() === '') return def;
      const v = s.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a boolean: "${s}"` });
      return z.NEVER;
    });

/** `furniture=0.9,lighting=0.88` → { furniture: 0.9, lighting: 0.88 } */
function parseThresholds(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of csv(s)) {
    const [k, v] = pair.split('=').map((x) => x.trim());
    const n = Number(v);
    if (!k || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`bad CATEGORY_THRESHOLDS entry "${pair}"`);
    out[k] = n;
  }
  return out;
}

const EnvSchema = z.object({
  PORT: num(3001),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: num(6379),
  DATABASE_URL: z.string().optional(),
  AUTO_APPROVE_AT: num(0.85),
  SAMPLE_RATE: num(0.1),
  CATEGORY_THRESHOLDS: z.string().optional(),
  ALWAYS_REVIEW_EXTRA: z.string().optional(),
  DAILY_BUDGET_USD: num(0),
  LEASE_MINUTES: num(15),
  REVIEW_SLA_HOURS: num(24),
  BATCH_RATE_PER_MINUTE: num(20),
  STUCK_GENERATING_MINUTES: num(20),
  WEBHOOK_URLS: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_MAX_ATTEMPTS: num(8),
  SCHEDULER_ENABLED: bool(false),
  SCHEDULER_INTERVAL_SECONDS: num(30),
  EXPERIMENT: z.string().optional(),
  PROMPT_CACHE: bool(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface ExperimentConfig {
  id: string;
  /** Variant ids and their share of traffic in percent. Shares must add up to 100. */
  arms: { variant: string; share: number }[];
}

export interface AppConfig {
  port: number;
  redis: { host: string; port: number };
  databaseUrl: string | null;
  policy: RoutingPolicy;
  /** 0 disables the budget guard. */
  dailyBudgetUsd: number;
  leaseMs: number;
  /** How long a draft may wait in review before it counts as overdue. */
  reviewSlaMs: number;
  /** Batch creations per user per minute (CSV imports included). 0 disables the limit. */
  batchRatePerMinute: number;
  stuckGeneratingMs: number;
  webhooks: { urls: string[]; secret: string | null; maxAttempts: number };
  scheduler: { enabled: boolean; intervalMs: number };
  experiment: ExperimentConfig | null;
  promptCache: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** `id:control=50,benefit_led=50` */
export function parseExperiment(s: string | undefined): ExperimentConfig | null {
  if (!s || !s.trim()) return null;
  const [id, armsPart] = s.split(':');
  if (!id || !armsPart) throw new Error(`EXPERIMENT must look like "id:variantA=50,variantB=50", got "${s}"`);
  const arms = csv(armsPart).map((a) => {
    const [variant, share] = a.split('=').map((x) => x.trim());
    const n = Number(share);
    if (!variant || !Number.isInteger(n) || n <= 0) throw new Error(`bad experiment arm "${a}"`);
    return { variant, share: n };
  });
  const total = arms.reduce((t, a) => t + a.share, 0);
  if (total !== 100) throw new Error(`experiment shares add up to ${total}, not 100`);
  if (new Set(arms.map((a) => a.variant)).size !== arms.length) throw new Error('experiment variants must be unique');
  return { id: id.trim(), arms };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  if (e.AUTO_APPROVE_AT < 0 || e.AUTO_APPROVE_AT > 1) throw new Error('AUTO_APPROVE_AT must be between 0 and 1');
  if (e.SAMPLE_RATE < 0 || e.SAMPLE_RATE > 1) throw new Error('SAMPLE_RATE must be between 0 and 1');
  if (e.DAILY_BUDGET_USD < 0) throw new Error('DAILY_BUDGET_USD cannot be negative');
  const urls = csv(e.WEBHOOK_URLS);
  for (const u of urls) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(u);
    } catch {
      throw new Error(`WEBHOOK_URLS entry is not a URL: "${u}"`);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
      throw new Error(`webhooks must use https (got ${u})`);
    }
  }
  if (urls.length && !e.WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is required when WEBHOOK_URLS is set');
  return {
    port: e.PORT,
    redis: { host: e.REDIS_HOST, port: e.REDIS_PORT },
    databaseUrl: e.DATABASE_URL?.trim() || null,
    policy: {
      autoApproveAt: e.AUTO_APPROVE_AT,
      sampleRate: e.SAMPLE_RATE,
      categoryThresholds: parseThresholds(e.CATEGORY_THRESHOLDS),
      alwaysReview: csv(e.ALWAYS_REVIEW_EXTRA),
    },
    dailyBudgetUsd: e.DAILY_BUDGET_USD,
    leaseMs: e.LEASE_MINUTES * 60_000,
    reviewSlaMs: e.REVIEW_SLA_HOURS * 3_600_000,
    batchRatePerMinute: e.BATCH_RATE_PER_MINUTE,
    stuckGeneratingMs: e.STUCK_GENERATING_MINUTES * 60_000,
    webhooks: { urls, secret: e.WEBHOOK_SECRET ?? null, maxAttempts: e.WEBHOOK_MAX_ATTEMPTS },
    scheduler: { enabled: e.SCHEDULER_ENABLED, intervalMs: e.SCHEDULER_INTERVAL_SECONDS * 1000 },
    experiment: parseExperiment(e.EXPERIMENT),
    promptCache: e.PROMPT_CACHE,
    logLevel: e.LOG_LEVEL,
  };
}

/** Defaults used by tests and by AppModule.forRoot when no config is passed. */
export function defaultConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), ...overrides };
}
