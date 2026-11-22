import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * The SSO gateway authenticates users and forwards `x-user` and `x-roles` (comma-separated). The API
 * trusts those headers only because it is not reachable except through the gateway.
 *
 * Roles: editors create batches, reviewers review, publishers publish, admins manage the glossary,
 * routing policy and webhook outbox. Roles are not hierarchical: an admin who reviews also needs the
 * reviewer role, so review metrics stay attributable to people who actually review.
 */
export type Role = 'editor' | 'reviewer' | 'publisher' | 'admin';
export const ROLES: readonly Role[] = ['editor', 'reviewer', 'publisher', 'admin'];

export interface Principal {
  user: string;
  roles: ReadonlySet<Role>;
}

const USER_RE = /^[\w.@+-]{1,128}$/;

export function principalFrom(headers: Record<string, string | string[] | undefined>): Principal | null {
  const rawUser = headers['x-user'];
  const user = (Array.isArray(rawUser) ? rawUser[0] : rawUser)?.trim();
  if (!user || !USER_RE.test(user)) return null;
  const rawRoles = headers['x-roles'];
  const roles = new Set<Role>();
  for (const r of (Array.isArray(rawRoles) ? rawRoles.join(',') : (rawRoles ?? '')).split(',')) {
    const role = r.trim().toLowerCase();
    if ((ROLES as string[]).includes(role)) roles.add(role as Role);
  }
  return { user, roles };
}

export function hasAnyRole(p: Principal | null, roles: readonly Role[]): boolean {
  return !!p && roles.some((r) => p.roles.has(r));
}

/** Throws 401 like the original controller did; the gateway turns it into a "not allowed" page. */
export function requireRole(headers: Record<string, string | string[] | undefined>, ...roles: Role[]): Principal {
  const p = principalFrom(headers);
  if (!hasAnyRole(p, roles)) throw new UnauthorizedException(`requires ${roles.join(' or ')}`);
  return p!;
}

export const ROLES_KEY = 'contentloom:roles';

/** Declare the roles a handler accepts; any one of them is enough. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; principal?: Principal | null }>();
    req.principal = principalFrom(req.headers);
    if (!roles?.length) return true;
    if (!hasAnyRole(req.principal, roles)) throw new UnauthorizedException(`requires ${roles.join(' or ')}`);
    return true;
  }
}

/** The authenticated user's name, or 'anonymous' on routes that don't require a role. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal | null; headers: Record<string, string> }>();
  return (req.principal ?? principalFrom(req.headers))?.user ?? 'anonymous';
});

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal | null => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal | null; headers: Record<string, string> }>();
  return req.principal ?? principalFrom(req.headers);
});
