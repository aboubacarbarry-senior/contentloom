import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit';
import { CurrentUser, Roles, RolesGuard } from '../auth';
import { isKnownCategory, knownCategories } from '../categories';
import type { Locale } from '../domain';
import { NotFoundError, ValidationError } from '../errors';
import { ExportFormat, ExportService } from '../exports';
import { GlossaryService } from '../glossary.service';
import { isLocale } from '../locales';
import { MetricsService } from '../metrics';
import { OutboxService } from '../outbox';
import { PolicyService } from '../policy';
import type { OutboxStatus } from '../repository';
import { SchedulerService } from '../scheduler';
import { GlossaryImportDto, GlossaryPreviewDto, GlossaryTermDto, intParam, listParam, PolicyDto } from './dto';

@Controller()
@UseGuards(RolesGuard)
export class AdminController {
  constructor(
    private readonly glossary: GlossaryService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly scheduler: SchedulerService,
    private readonly metrics: MetricsService,
    @Inject(ExportService) private readonly exportsSvc: ExportService,
  ) {}

  /* ---------------- glossary ---------------- */

  @Get('glossary')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  listTerms(@Query('locale') locale?: string) {
    if (locale && locale !== '*' && !isLocale(locale)) throw new ValidationError(`unknown locale "${locale}"`);
    return this.glossary.list(locale as Locale | '*' | undefined);
  }

  @Post('glossary')
  @Roles('admin')
  addTerm(@Body() dto: GlossaryTermDto, @CurrentUser() user: string) {
    return this.glossary.add(dto, user);
  }

  @Post('glossary/import')
  @HttpCode(200)
  @Roles('admin')
  importTerms(@Body() dto: GlossaryImportDto, @CurrentUser() user: string) {
    return this.glossary.importMany(dto.terms, user);
  }

  @Delete('glossary/:id')
  @HttpCode(204)
  @Roles('admin')
  async removeTerm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: string) {
    await this.glossary.remove(id, user);
  }

  @Post('glossary/preview')
  @HttpCode(200)
  @Roles('editor', 'reviewer', 'admin')
  preview(@Body() dto: GlossaryPreviewDto) {
    return this.glossary.preview(dto.brief, dto.text);
  }

  /* ---------------- routing policy ---------------- */

  @Get('policy')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  getPolicy() {
    const categories = knownCategories().map((c) => c.id);
    return { policy: this.policy.current, effectiveThresholds: this.metrics.thresholds(categories) };
  }

  @Patch('policy')
  @Roles('admin')
  async updatePolicy(@Body() dto: PolicyDto, @CurrentUser() user: string) {
    const unknown = Object.keys(dto.categoryThresholds ?? {}).filter((c) => !isKnownCategory(c));
    const policy = await this.policy.update(user, dto);
    return { policy, warnings: unknown.map((c) => `"${c}" is not a known category; the override applies only if briefs use it`) };
  }

  /* ---------------- audit ---------------- */

  @Get('audit')
  @Roles('admin')
  auditLog(@Query('subject') subject?: string, @Query('actor') actor?: string, @Query('action') action?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.audit.list({ subject, actor, action, limit: intParam(limit, 50, 1, 500), cursor: cursor ?? null });
  }

  /* ---------------- outbox ---------------- */

  @Get('outbox')
  @Roles('admin')
  async outboxList(@Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (status && !['pending', 'delivered', 'dead'].includes(status)) throw new ValidationError('status must be pending, delivered or dead');
    const [page, counts] = await Promise.all([this.outbox.list({ status: status as OutboxStatus | undefined, limit: intParam(limit, 50, 1, 500), cursor: cursor ?? null }), this.outbox.counts()]);
    return { counts, ...page };
  }

  @Post('outbox/:id/retry')
  @HttpCode(200)
  @Roles('admin')
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: string) {
    const m = await this.outbox.retry(id);
    if (!m) throw new NotFoundError(`outbox message ${id} not found`);
    await this.audit.record(user, 'outbox.retry', `outbox:${id}`, { event: m.event, target: m.target });
    return m;
  }

  @Post('admin/sweep')
  @HttpCode(200)
  @Roles('admin')
  sweep() {
    return this.scheduler.sweep();
  }

  /* ---------------- exports ---------------- */

  @Get('exports/published')
  @Roles('publisher', 'admin')
  async exportPublished(
    @Res({ passthrough: true }) res: Response,
    @Query('format') format?: string,
    @Query('locale') locale?: string,
    @Query('batch') batchId?: string,
    @Query('category') category?: string,
    @Query('since') since?: string,
  ) {
    const out = await this.exportsSvc.published(this.exportOptions(format, locale, batchId, category, since));
    return this.send(res, out, 'published');
  }

  @Get('exports/reviews')
  @Roles('admin')
  async exportReviews(@Res({ passthrough: true }) res: Response, @Query('format') format?: string, @Query('locale') locale?: string, @Query('batch') batchId?: string, @Query('since') since?: string) {
    const out = await this.exportsSvc.reviewLog(this.exportOptions(format, locale, batchId, undefined, since));
    return this.send(res, out, 'reviews');
  }

  private exportOptions(format?: string, locale?: string, batchId?: string, category?: string, since?: string) {
    const f = (format ?? 'csv') as ExportFormat;
    if (f !== 'csv' && f !== 'jsonl') throw new ValidationError('format must be csv or jsonl');
    const locales = listParam(locale);
    for (const l of locales ?? []) if (!isLocale(l)) throw new ValidationError(`unknown locale "${l}"`);
    if (since && Number.isNaN(Date.parse(since))) throw new ValidationError('since must be an ISO date');
    return { format: f, locale: locales as Locale[] | undefined, batchId, category: listParam(category), since: since ? new Date(since).toISOString() : undefined };
  }

  private send(res: Response, out: { contentType: string; body: string; count: number }, name: string) {
    const ext = out.contentType.startsWith('text/csv') ? 'csv' : 'jsonl';
    res.setHeader('content-type', out.contentType);
    res.setHeader('content-disposition', `attachment; filename="contentloom-${name}.${ext}"`);
    res.setHeader('x-row-count', String(out.count));
    return out.body;
  }
}
