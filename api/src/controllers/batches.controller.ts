import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, Roles, RolesGuard } from '../auth';
import { RateLimited, RateLimitGuard } from '../ratelimit';
import { BatchService } from '../batches';
import { ContentService } from '../service';
import { Store, STORE } from '../repository';
import { parseQuery, QueryError } from '../search';
import { ValidationError } from '../errors';
import { Inject } from '@nestjs/common';
import { BatchDto, CsvBatchDto, intParam } from './dto';

@Controller('batches')
@UseGuards(RolesGuard, RateLimitGuard)
export class BatchesController {
  constructor(
    private readonly batches: BatchService,
    private readonly content: ContentService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  @Post()
  @Roles('editor')
  @RateLimited()
  create(@Body() dto: BatchDto, @CurrentUser() user: string) {
    return this.batches.create(dto.briefs, user, { name: dto.name });
  }

  @Post('csv')
  @Roles('editor')
  @RateLimited()
  importCsv(@Body() dto: CsvBatchDto, @CurrentUser() user: string) {
    return this.batches.importCsv(dto.csv, user, dto.name);
  }

  @Get()
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string, @Query('mine') mine?: string, @CurrentUser() user?: string) {
    return this.batches.list({ limit: intParam(limit, 20, 1, 100), cursor: cursor ?? null, createdBy: mine === '1' || mine === 'true' ? user : undefined });
  }

  @Get(':id')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.summary(id);
  }

  @Get(':id/report')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.report(id);
  }

  @Get(':id/items')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  async items(@Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    await this.batches.get(id);
    let filter;
    try {
      filter = q ? parseQuery(q) : {};
    } catch (e) {
      if (e instanceof QueryError) throw new ValidationError(e.message, { position: e.position });
      throw e;
    }
    return this.store.items.query({ sort: 'sku_asc', ...filter, batchId: id, limit: intParam(limit, 50, 1, 500), cursor: cursor ?? null });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('editor', 'admin')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: string) {
    return this.batches.cancel(id, user);
  }

  @Post(':id/retry-failed')
  @HttpCode(200)
  @Roles('editor')
  retryFailed(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: string) {
    return this.batches.retryFailed(id, user);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Roles('publisher')
  async publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: string) {
    await this.batches.get(id);
    return this.content.publishBatch(id, user);
  }
}
