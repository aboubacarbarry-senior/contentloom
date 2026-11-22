import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentPrincipal, CurrentUser, hasAnyRole, Principal, Role, Roles, RolesGuard } from '../auth';
import { ForbiddenError, ValidationError } from '../errors';
import { Store, STORE } from '../repository';
import { ReviewService } from '../review';
import { formatQuery, parseQuery, QueryError } from '../search';
import { ContentService } from '../service';
import { BulkDto, CommentDto, intParam, LintDto, ReasonDto, RegenerateDto, ResolveCommentDto, ReviewDto } from './dto';

@Controller()
@UseGuards(RolesGuard)
export class ItemsController {
  constructor(
    private readonly content: ContentService,
    private readonly review: ReviewService,
    @Inject(STORE) private readonly store: Store,
  ) {}

  /** Search with the query language (see search.ts). Returns the normalised query so the UI can show it. */
  @Get('items')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  async search(@Query('q') q = '', @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    let query;
    try {
      query = parseQuery(q);
    } catch (e) {
      if (e instanceof QueryError) throw new ValidationError(e.message, { position: e.position });
      throw e;
    }
    const page = await this.store.items.query({ sort: 'updated_desc', ...query, limit: intParam(limit, 50, 1, 500), cursor: cursor ?? null });
    return { query: formatQuery(query), ...page };
  }

  /**
   * One action on many items, with the same roles as the single-item endpoints: publish and withdraw
   * need publisher, reopen needs publisher or reviewer, regenerate needs editor or reviewer.
   */
  @Post('items/bulk')
  @HttpCode(200)
  @Roles('editor', 'reviewer', 'publisher')
  bulk(@Body() dto: BulkDto, @CurrentPrincipal() p: Principal) {
    const needs: Role[] = dto.action === 'regenerate' ? ['editor', 'reviewer'] : dto.action === 'reopen' ? ['publisher', 'reviewer'] : ['publisher'];
    if (!hasAnyRole(p, needs)) throw new ForbiddenError(`${dto.action} needs the ${needs.join(' or ')} role`);
    return this.content.bulk(dto.action, dto.ids, p.user, dto.reason);
  }

  @Get('items/:id')
  get(@Param('id') id: string) {
    return this.content.get(id);
  }

  @Get('items/:id/view')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  view(@Param('id') id: string) {
    return this.review.view(id);
  }

  @Post('items/:id/review')
  @Roles('reviewer')
  decide(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() user: string) {
    return this.content.review(id, user, dto.decision, dto);
  }

  @Post('items/:id/publish')
  @Roles('publisher')
  publish(@Param('id') id: string, @CurrentUser() user: string) {
    return this.content.publish(id, user);
  }

  @Post('items/:id/withdraw')
  @HttpCode(200)
  @Roles('publisher')
  withdraw(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: string) {
    return this.content.withdraw(id, user, dto.reason);
  }

  @Post('items/:id/reopen')
  @HttpCode(200)
  @Roles('publisher', 'reviewer')
  reopen(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: string) {
    return this.content.reopen(id, user, dto.reason);
  }

  @Post('items/:id/regenerate')
  @HttpCode(200)
  @Roles('editor', 'reviewer')
  regenerate(@Param('id') id: string, @Body() dto: RegenerateDto, @CurrentUser() user: string) {
    return this.content.regenerate(id, user, dto.note);
  }

  @Post('items/:id/lint')
  @HttpCode(200)
  @Roles('reviewer', 'editor')
  lint(@Param('id') id: string, @Body() dto: LintDto) {
    return this.review.lintItem(id, dto.text);
  }

  @Get('items/:id/comments')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  comments(@Param('id') id: string) {
    return this.review.comments(id);
  }

  @Post('items/:id/comments')
  @Roles('editor', 'reviewer', 'publisher')
  comment(@Param('id') id: string, @Body() dto: CommentDto, @CurrentUser() user: string) {
    const hasStart = dto.start !== undefined;
    const hasEnd = dto.end !== undefined;
    if (hasStart !== hasEnd) throw new ValidationError('give both start and end, or neither');
    return this.review.addComment(id, user, dto.body, hasStart ? { start: dto.start!, end: dto.end! } : undefined);
  }

  @Patch('comments/:id')
  @Roles('editor', 'reviewer', 'publisher')
  resolve(@Param('id') id: string, @Body() dto: ResolveCommentDto, @CurrentUser() user: string) {
    return this.review.resolveComment(id, user, dto.resolved);
  }
}
