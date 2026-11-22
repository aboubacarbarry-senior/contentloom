import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Brief } from '../domain';
import { LOCALES } from '../domain';

export class BriefDto implements Brief {
  @IsString() @Length(1, 64) sku: string;
  @IsIn(LOCALES as string[]) locale: Brief['locale'];
  @IsObject() facts: Record<string, string>;
  @IsArray() @IsString({ each: true }) mustMention: string[];
  @IsArray() @IsString({ each: true }) banned: string[];
  @IsString() @Length(1, 48) category: string;
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsString() @Length(1, 80) brand?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) keywords?: string[];
}

export class BatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BriefDto) briefs: BriefDto[];
  @IsOptional() @IsString() @Length(1, 120) name?: string;
}

export class CsvBatchDto {
  /** The spreadsheet as text (the review app reads the file in the browser). 2 MB is ~5,000 rows. */
  @IsString() @Length(1, 2_000_000) csv: string;
  @IsOptional() @IsString() @Length(1, 120) name?: string;
}

export class ReviewDto {
  @IsIn(['approve', 'reject', 'revise']) decision: 'approve' | 'reject' | 'revise';
  @IsOptional() @IsString() @Length(1, 4000) editedText?: string;
  @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

export class ReasonDto {
  @IsString() @Length(1, 1000) reason: string;
}

export class RegenerateDto {
  @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

export class CommentDto {
  @IsString() @Length(1, 2000) body: string;
  @IsOptional() @IsInt() @Min(0) start?: number;
  @IsOptional() @IsInt() @Min(0) end?: number;
}

export class BulkDto {
  @IsIn(['publish', 'regenerate', 'reopen', 'withdraw']) action: 'publish' | 'regenerate' | 'reopen' | 'withdraw';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids: string[];
  @IsOptional() @IsString() @Length(1, 1000) reason?: string;
}

export class ResolveCommentDto {
  @IsBoolean() resolved: boolean;
}

export class LintDto {
  @IsString() @Length(1, 4000) text: string;
}

export class ClaimDto {
  /** Optional search-language filter, e.g. `locale:fr-CA category:rugs`. */
  @IsOptional() @IsString() @MaxLength(500) query?: string;
  /** Item ids the reviewer skipped in this session. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) skip?: string[];
}

export class GlossaryTermDto {
  @IsIn(['*', ...LOCALES]) locale: '*' | Brief['locale'];
  @IsString() @Length(1, 80) term: string;
  @IsIn(['forbidden', 'preferred', 'keep']) kind: 'forbidden' | 'preferred' | 'keep';
  @IsOptional() @IsString() @Length(1, 80) replacement?: string;
  @IsOptional() @IsString() @Length(1, 300) note?: string;
  @IsOptional() @IsBoolean() caseSensitive?: boolean;
}

export class GlossaryImportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => GlossaryTermDto) terms: GlossaryTermDto[];
}

export class GlossaryPreviewDto {
  @ValidateNested() @Type(() => BriefDto) brief: BriefDto;
  @IsString() @Length(1, 4000) text: string;
}

export class PolicyDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1) autoApproveAt?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) sampleRate?: number;
  @IsOptional() @IsObject() categoryThresholds?: Record<string, number | null>;
  @IsOptional() @IsArray() @IsString({ each: true }) alwaysReview?: string[];
}

/** Query-string helpers: Nest passes strings, these turn them into typed values or undefined. */
export function intParam(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function listParam(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const out = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}
