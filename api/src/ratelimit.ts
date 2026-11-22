import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { principalFrom } from './auth';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import { CLOCK, CONFIG } from './tokens';

/**
 * Token buckets per user. Batch creation is the expensive call (every brief costs two model calls), so
 * a script stuck in a retry loop must not be able to queue thousands of generations in a minute.
 * In-process: with several API replicas the effective limit is replicas × limit, which is acceptable
 * for a guard rail (the daily budget is the hard stop).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Take one token. Returns 0 when allowed, otherwise the milliseconds until a token is available. */
  take(now: number): number {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /** True when the bucket is full again and can be forgotten. */
  idle(now: number): boolean {
    return this.tokens + (now - this.last) * this.refillPerMs >= this.capacity;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
  ) {}

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** 0 when allowed, otherwise milliseconds to wait. */
  check(key: string): number {
    if (!this.enabled) return 0;
    const now = this.clock.now().getTime();
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.perMinute, this.perMinute / 60_000, now);
      this.buckets.set(key, b);
    }
    const wait = b.take(now);
    if (this.buckets.size > 10_000) this.prune(now);
    return wait;
  }

  private prune(now: number) {
    for (const [k, b] of this.buckets) if (b.idle(now)) this.buckets.delete(k);
  }
}

export const RATE_LIMITED = 'contentloom:rate-limited';

/** Mark a handler as counted against the per-user batch limit. */
export const RateLimited = () => SetMetadata(RATE_LIMITED, true);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) config: AppConfig,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.limiter = new RateLimiter(config.batchRatePerMinute, clock);
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.reflector.get<boolean>(RATE_LIMITED, ctx.getHandler())) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const user = principalFrom(req.headers)?.user ?? 'anonymous';
    const wait = this.limiter.check(user);
    if (wait === 0) return true;
    const res = ctx.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>();
    res.setHeader('retry-after', String(Math.ceil(wait / 1000)));
    throw new HttpException({ message: `too many batches; try again in ${Math.ceil(wait / 1000)} s`, error: 'RateLimited' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
