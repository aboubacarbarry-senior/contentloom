import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ManualClock } from '../src/clock';
import { AppConfig, defaultConfig } from '../src/config';
import type { Brief } from '../src/domain';
import { MemoryStore } from '../src/memory';
import { MemoryQueue } from '../src/queue';
import { ContentService } from '../src/service';
import type { FetchFn } from '../src/tokens';
import { MODEL } from '../src/llm';

/**
 * Fake Anthropic client. Generation writes a description from the facts in the prompt; the judge
 * returns scripted grades. Usage numbers are included so cost accounting can be checked.
 */
export function fakeClient() {
  const calls: any[] = [];
  const state = {
    judge: { accuracy: 5, usefulness: 5, tone: 5 } as { accuracy: number; usefulness: number; tone: number } | null,
    failNextGenerations: 0,
    failWith: null as null | (() => Error),
    generatorAddsClaim: '',
    /** Replace the generated text entirely (per call, first in first out). */
    scripted: [] as string[],
    refuseNext: false,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Record<string, number> | null,
  };
  const client = {
    beta: {
      messages: {
        create: async (req: any) => {
          calls.push(req);
          const usage = state.usage ? { ...state.usage } : undefined;
          if (req.output_config?.format) {
            if (!state.judge) return { stop_reason: 'max_tokens', model: MODEL, content: [], usage };
            return { stop_reason: 'end_turn', model: MODEL, content: [{ type: 'text', text: JSON.stringify({ rationale: 'ok', ...state.judge }) }], usage };
          }
          if (state.failNextGenerations > 0) {
            state.failNextGenerations--;
            throw state.failWith ? state.failWith() : new Error('529 overloaded');
          }
          if (state.refuseNext) {
            state.refuseNext = false;
            return { stop_reason: 'refusal', model: MODEL, content: [], usage, stop_details: { type: 'refusal', category: 'cyber' } };
          }
          if (state.scripted.length) return { stop_reason: 'end_turn', model: MODEL, content: [{ type: 'text', text: state.scripted.shift() }], usage };
          const facts = Object.fromEntries(
            String(req.messages[0].content)
              .split('\n')
              .filter((l: string) => l.includes(': '))
              .map((l: string) => l.split(': ')),
          );
          const text =
            `Meet the ${facts.name}, made from ${facts.material} and measuring ${facts.size}. It is easy to live with and suits most rooms, ` +
            `bringing quiet texture to everyday spaces without demanding attention. Care is simple: ${facts.care}. ${state.generatorAddsClaim}` +
            `A practical choice for daily use that should look good for years with very little effort from you.`;
          return { stop_reason: 'end_turn', model: MODEL, content: [{ type: 'text', text }], usage };
        },
      },
    },
  };
  return { client, calls, state };
}

export const brief = (sku: string, category = 'textiles', extra: Partial<Brief> = {}): Brief => ({
  sku,
  locale: 'en-US',
  category,
  facts: { name: `Sage Throw ${sku}`, material: 'cotton', size: '50 x 60 in', care: 'machine wash cold' },
  mustMention: ['cotton', '50 x 60 in'],
  banned: ['waterproof'],
  ...extra,
});

export const EDITOR = { 'x-user': 'ed', 'x-roles': 'editor' };
export const REVIEWER = { 'x-user': 'rita', 'x-roles': 'reviewer' };
export const REVIEWER2 = { 'x-user': 'raj', 'x-roles': 'reviewer' };
export const PUBLISHER = { 'x-user': 'pat', 'x-roles': 'publisher' };
export const ADMIN = { 'x-user': 'ada', 'x-roles': 'admin,editor' };

export interface TestApp {
  app: INestApplication;
  http: any;
  queue: MemoryQueue;
  store: MemoryStore;
  clock: ManualClock;
  fake: ReturnType<typeof fakeClient>;
  svc: ContentService;
  rolls: number[];
  webhookCalls: { url: string; headers: Record<string, string>; body: string }[];
  webhookStatus: number[];
  close(): Promise<void>;
}

/** Boot the whole Nest app with in-memory infrastructure and a hand-driven clock. */
export async function bootApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const fake = fakeClient();
  const clock = new ManualClock('2026-03-02T09:00:00.000Z');
  const queue = new MemoryQueue(() => clock.now().getTime());
  const store = new MemoryStore();
  const rolls: number[] = [];
  const webhookCalls: TestApp['webhookCalls'] = [];
  const webhookStatus: number[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    webhookCalls.push({ url, headers: init.headers, body: init.body });
    const status = webhookStatus.length ? webhookStatus.shift()! : 200;
    return { status, text: async () => (status >= 400 ? 'nope' : 'ok') };
  };
  const config = defaultConfig(overrides);
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        client: fake.client,
        queue,
        store,
        clock,
        config,
        policy: config.policy,
        random: () => rolls.shift() ?? 0.99,
        fetch: fetchFn,
      }),
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return {
    app,
    http: app.getHttpServer(),
    queue,
    store,
    clock,
    fake,
    svc: app.get(ContentService),
    rolls,
    webhookCalls,
    webhookStatus,
    close: () => app.close(),
  };
}
