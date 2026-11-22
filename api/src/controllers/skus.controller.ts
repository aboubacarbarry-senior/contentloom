import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles, RolesGuard } from '../auth';
import { ConsistencyService } from '../consistency';
import { ValidationError } from '../errors';
import { intParam } from './dto';

@Controller('skus')
@UseGuards(RolesGuard)
export class SkusController {
  constructor(private readonly consistency: ConsistencyService) {}

  /** SKUs with locale coverage and cross-locale issues, worst first. `prefix` narrows the scan. */
  @Get()
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  list(@Query('prefix') prefix = '', @Query('limit') limit?: string) {
    if (prefix.length > 64) throw new ValidationError('prefix is longer than 64 characters');
    return this.consistency.list(prefix.trim(), intParam(limit, 100, 1, 500));
  }

  /** Every locale of one SKU side by side, with what disagrees between them. */
  @Get(':sku')
  @Roles('editor', 'reviewer', 'publisher', 'admin')
  one(@Param('sku') sku: string) {
    return this.consistency.sku(sku);
  }
}
