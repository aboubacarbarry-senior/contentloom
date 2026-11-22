import { Controller, Get, Inject, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { concat, from, map, Observable } from 'rxjs';
import { CurrentPrincipal, Principal, Roles, RolesGuard } from '../auth';
import { knownCategories } from '../categories';
import { describeChecks } from '../checks';
import { LOCALES, STATUSES } from '../domain';
import { EventBus, parseEventTypes } from '../events';
import { LOCALE_PROFILES } from '../locales';
import { MetricsService } from '../metrics';
import { PROMPT_VERSION, VARIANTS } from '../prompts';
import type { JobQueue } from '../queue';
import { Store, STORE } from '../repository';
import { BUDGET, JOB_QUEUE } from '../tokens';
import { BudgetGuard } from '../usage';
import { MODEL } from '../llm';

@Controller()
@UseGuards(RolesGuard)
export class SystemController {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(BUDGET) private readonly budget: BudgetGuard,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness and dependencies, for the load balancer and the on-call dashboard. */
  @Get('health')
  async health() {
    const [store, queue, budget] = await Promise.all([this.store.health(), this.queue.stats?.().catch(() => null) ?? Promise.resolve(null), this.budget.status()]);
    return { ok: store.ok, store, queue, budget, model: MODEL, promptVersion: PROMPT_VERSION };
  }

  /** Who the gateway says is calling, so the review app can show the user and hide what they can't do. */
  @Get('whoami')
  whoami(@CurrentPrincipal() p: Principal | null) {
    return { user: p?.user ?? null, roles: p ? [...p.roles].sort() : [] };
  }

  /** Static reference data the review app needs to render filters and explanations. */
  @Get('meta')
  meta() {
    return {
      statuses: STATUSES,
      locales: LOCALES.map((l) => ({ id: l, name: LOCALE_PROFILES[l].name })),
      categories: knownCategories().map((c) => ({ id: c.id, label: c.label, regulated: c.regulated, words: c.words, requiredFacts: c.requiredFacts })),
      checks: describeChecks(),
      variants: Object.values(VARIANTS).map((v) => ({ id: v.id, label: v.label, description: v.description })),
      promptVersion: PROMPT_VERSION,
      model: MODEL,
    };
  }

  @Get('metrics')
  metricsOverview() {
    return this.metrics.overview();
  }

  @Get('metrics/calibration')
  @Roles('reviewer', 'admin')
  calibration(@Query('target') target?: string) {
    const t = target === undefined ? 0.95 : Number(target);
    return this.metrics.calibration(Number.isFinite(t) && t > 0 && t < 1 ? t : 0.95);
  }

  @Get('metrics/daily')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  daily(@Query('days') days?: string) {
    return this.metrics.daily(days ? Number(days) || 14 : 14);
  }

  @Get('metrics/experiments')
  @Roles('editor', 'admin')
  experiments() {
    return this.metrics.experiments();
  }

  /**
   * Server-Sent Events for the review app. Replays recent events first so a reconnecting client catches
   * up. EventSource can't send headers, but the SSO gateway adds x-user / x-roles on the way in.
   */
  @Sse('events')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  stream(@Query('types') types?: string): Observable<MessageEvent> {
    const wanted = parseEventTypes(types);
    const backlog = from(this.events.replay(wanted, 20)).pipe(map((e) => ({ type: e.type, data: e }) as MessageEvent));
    return concat(backlog, this.events.sse(wanted) as Observable<MessageEvent>);
  }
}
