import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from './audit';
import type { RoutingPolicy } from './domain';
import { ValidationError } from './errors';
import { POLICY } from './tokens';

export interface PolicyPatch {
  autoApproveAt?: number;
  sampleRate?: number;
  categoryThresholds?: Record<string, number | null>;
  alwaysReview?: string[];
}

/** Validate and apply a partial update. A null category threshold removes the override. */
export function applyPolicyPatch(current: RoutingPolicy, patch: PolicyPatch): RoutingPolicy {
  const next: RoutingPolicy = {
    autoApproveAt: current.autoApproveAt,
    sampleRate: current.sampleRate,
    categoryThresholds: { ...(current.categoryThresholds ?? {}) },
    alwaysReview: [...(current.alwaysReview ?? [])],
  };
  const unit = (name: string, v: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new ValidationError(`${name} must be a number between 0 and 1`);
    return v;
  };
  if (patch.autoApproveAt !== undefined) next.autoApproveAt = unit('autoApproveAt', patch.autoApproveAt);
  if (patch.sampleRate !== undefined) {
    next.sampleRate = unit('sampleRate', patch.sampleRate);
    // Without a sample there is no precision measurement, and then no way to justify the threshold.
    if (next.sampleRate < 0.01) throw new ValidationError('sampleRate below 0.01 leaves auto-approval unmeasured');
  }
  for (const [cat, v] of Object.entries(patch.categoryThresholds ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(cat)) throw new ValidationError(`bad category id "${cat}"`);
    if (v === null) delete next.categoryThresholds![cat];
    else next.categoryThresholds![cat] = unit(`categoryThresholds.${cat}`, v);
  }
  if (patch.alwaysReview) {
    for (const c of patch.alwaysReview) if (!/^[a-z][a-z0-9_-]{0,40}$/.test(c)) throw new ValidationError(`bad category id "${c}"`);
    next.alwaysReview = [...new Set(patch.alwaysReview)].sort();
  }
  return next;
}

/**
 * The live routing policy. Starts from configuration; admins can change it at runtime and every change
 * is audited with before and after values. (With several API processes, persist it; here it is per process.)
 */
@Injectable()
export class PolicyService {
  private policy: RoutingPolicy;

  constructor(
    @Inject(POLICY) initial: RoutingPolicy,
    private readonly audit: AuditService,
  ) {
    this.policy = { categoryThresholds: {}, alwaysReview: [], ...initial };
  }

  get current(): RoutingPolicy {
    return this.policy;
  }

  async update(by: string, patch: PolicyPatch): Promise<RoutingPolicy> {
    const before = this.policy;
    const after = applyPolicyPatch(before, patch);
    this.policy = after;
    await this.audit.record(by, 'policy.update', 'policy', { before, after });
    return after;
  }
}
