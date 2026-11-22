import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Roles, RolesGuard } from '../auth';
import { ValidationError } from '../errors';
import type { ItemFilter } from '../repository';
import { ReviewService } from '../review';
import { parseQuery, QueryError } from '../search';
import { ContentService } from '../service';
import { ClaimDto, intParam } from './dto';

function filterFrom(q: string | undefined): ItemFilter {
  if (!q) return {};
  try {
    const { status: _ignored, sort: _sort, limit: _limit, cursor: _cursor, ...rest } = parseQuery(q);
    return rest;
  } catch (e) {
    if (e instanceof QueryError) throw new ValidationError(e.message, { position: e.position });
    throw e;
  }
}

@Controller()
@UseGuards(RolesGuard)
export class ReviewController {
  constructor(
    private readonly content: ContentService,
    private readonly review: ReviewService,
  ) {}

  /** The original endpoint: drafts in review, worst score first. */
  @Get('review')
  @Roles('reviewer')
  queue() {
    return this.content.reviewQueue();
  }

  /** Richer queue for the review app: reasons, open comments and who holds each item. */
  @Get('review/queue')
  @Roles('reviewer')
  detailed(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.review.queue(filterFrom(q), intParam(limit, 100, 1, 500));
  }

  /** Lease the next item to review. 204 when the queue is empty. */
  @Post('review/claim')
  @Roles('reviewer')
  async claim(@Body() dto: ClaimDto, @CurrentUser() user: string, @Res({ passthrough: true }) res: Response) {
    const item = await this.review.claim(user, { ...filterFrom(dto.query), excludeIds: dto.skip });
    if (!item) {
      res.status(204);
      return undefined;
    }
    res.status(200);
    return item;
  }

  @Post('items/:id/heartbeat')
  @HttpCode(200)
  @Roles('reviewer')
  heartbeat(@Param('id') id: string, @CurrentUser() user: string) {
    return this.review.heartbeat(id, user);
  }

  @Post('items/:id/release')
  @HttpCode(200)
  @Roles('reviewer')
  release(@Param('id') id: string, @CurrentUser() user: string) {
    return this.review.release(id, user);
  }
}
