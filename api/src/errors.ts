import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

/**
 * Domain errors stay free of HTTP concerns; the filter below maps them to status codes.
 * Services can throw either these or Nest's own exceptions.
 */
export class DomainError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {}
export class ConflictError extends DomainError {}
export class ValidationError extends DomainError {}
export class ForbiddenError extends DomainError {}

/** Thrown when a save loses an optimistic-concurrency race. Callers reload and retry. */
export class StaleWriteError extends ConflictError {
  constructor(readonly id: string, readonly expected: number) {
    super(`item ${id} changed since version ${expected}`, { id, expected });
  }
}

/** The daily model budget is spent; work is deferred, not failed. */
export class BudgetExceededError extends DomainError {
  constructor(readonly spentUsd: number, readonly limitUsd: number, readonly resumeAt: Date) {
    super(`daily budget of $${limitUsd.toFixed(2)} reached ($${spentUsd.toFixed(2)} spent)`, {
      spentUsd,
      limitUsd,
      resumeAt: resumeAt.toISOString(),
    });
  }
}

export function toHttp(e: unknown): HttpException | null {
  if (e instanceof HttpException) return e;
  if (!(e instanceof DomainError)) return null;
  const body = { message: e.message, error: e.name, ...(e.details ? { details: e.details } : {}) };
  if (e instanceof NotFoundError) return new NotFoundException(body);
  if (e instanceof ConflictError) return new ConflictException(body);
  if (e instanceof ValidationError) return new BadRequestException(body);
  if (e instanceof ForbiddenError) return new ForbiddenException(body);
  if (e instanceof BudgetExceededError) return new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  return new HttpException(body, HttpStatus.INTERNAL_SERVER_ERROR);
}

@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    const http = toHttp(exception)!;
    const res = host.switchToHttp().getResponse();
    res.status(http.getStatus()).json(http.getResponse());
  }
}

/** Error text that is safe to store on an item and show to reviewers (no stack, bounded length). */
export function describeError(e: unknown, max = 500): string {
  const raw = e instanceof Error ? `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}` : String(e);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Whether a model error is worth retrying. 4xx request errors (other than 408/409/429) will fail the
 * same way every time, so the worker gives up on them at once instead of burning attempts.
 */
export function isRetryable(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429) return true;
    return status >= 500;
  }
  if (e instanceof DomainError) return e instanceof BudgetExceededError;
  return true; // network errors, timeouts and unknown failures
}
