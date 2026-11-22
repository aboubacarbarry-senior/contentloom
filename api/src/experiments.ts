import type { ExperimentConfig } from './config';
import { Item, reviewOutcome } from './domain';
import { VARIANTS } from './prompts';
import { fnv1a } from './text/similarity';
import { editStats } from './text/diff';

/**
 * Prompt experiments. A SKU always gets the same arm (hash of experiment id + SKU), so its locales and
 * its regenerations stay comparable. Outcomes are judged by reviewers: an arm wins when more of its
 * drafts are approved without edits.
 */

export function bucket(experimentId: string, sku: string): number {
  return fnv1a(`${experimentId}:${sku.trim().toLowerCase()}`) % 100;
}

export function assignVariant(exp: ExperimentConfig | null, sku: string): string {
  if (!exp) return 'control';
  const b = bucket(exp.id, sku);
  let acc = 0;
  for (const arm of exp.arms) {
    acc += arm.share;
    if (b < acc) return arm.variant;
  }
  return exp.arms[exp.arms.length - 1].variant;
}

export function validateExperiment(exp: ExperimentConfig): string[] {
  const problems: string[] = [];
  for (const arm of exp.arms) if (!VARIANTS[arm.variant]) problems.push(`unknown variant "${arm.variant}"`);
  if (!exp.arms.some((a) => a.variant === 'control')) problems.push('an experiment needs a control arm');
  return problems;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-((z / Math.SQRT2) ** 2));
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-sided two-proportion z-test. Returns z and p; null when either group is empty. */
export function twoProportionTest(successA: number, nA: number, successB: number, nB: number): { z: number; p: number } | null {
  if (!nA || !nB) return null;
  const pA = successA / nA;
  const pB = successB / nB;
  const pooled = (successA + successB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, p: 1 };
  const z = (pB - pA) / se;
  return { z: Math.round(z * 1000) / 1000, p: Math.round(2 * (1 - normalCdf(Math.abs(z))) * 10000) / 10000 };
}

export interface ArmStats {
  variant: string;
  items: number;
  /** Items a reviewer decided (approved, rejected, or sent back). */
  reviewed: number;
  approvedClean: number;
  approvedEdited: number;
  rejected: number;
  revised: number;
  autoApproved: number;
  meanScore: number | null;
  meanEditRatio: number | null;
  costUsd: number;
  /** Share of reviewed drafts approved without edits. */
  cleanApprovalRate: number | null;
}

export function armStats(variant: string, items: Item[]): ArmStats {
  let reviewed = 0;
  let approvedClean = 0;
  let approvedEdited = 0;
  let rejected = 0;
  let revised = 0;
  let autoApproved = 0;
  let scoreSum = 0;
  let scored = 0;
  let editSum = 0;
  let edited = 0;
  let cost = 0;
  for (const i of items) {
    cost += i.usage?.costUsd ?? 0;
    if (i.score) {
      scoreSum += i.score.total;
      scored++;
    }
    if (i.history.some((h) => h.to === 'auto_approved')) autoApproved++;
    const outcome = reviewOutcome(i);
    if (!outcome) continue;
    reviewed++;
    if (outcome === 'rejected') rejected++;
    else if (outcome === 'revised') revised++;
    else {
      const changed = i.draft !== null && i.finalText !== null && i.finalText.trim() !== i.draft.trim();
      if (changed) {
        approvedEdited++;
        editSum += editStats(i.draft!, i.finalText!).editRatio;
        edited++;
      } else approvedClean++;
    }
  }
  return {
    variant,
    items: items.length,
    reviewed,
    approvedClean,
    approvedEdited,
    rejected,
    revised,
    autoApproved,
    meanScore: scored ? Math.round((scoreSum / scored) * 1000) / 1000 : null,
    meanEditRatio: edited ? Math.round((editSum / edited) * 1000) / 1000 : null,
    costUsd: Math.round(cost * 1e4) / 1e4,
    cleanApprovalRate: reviewed ? Math.round((approvedClean / reviewed) * 1000) / 1000 : null,
  };
}

export interface ExperimentReport {
  experimentId: string | null;
  arms: ArmStats[];
  /** Each non-control arm against control, on the clean-approval rate. */
  comparisons: { variant: string; lift: number | null; z: number | null; p: number | null; significant: boolean }[];
  note: string;
}

export function experimentReport(exp: ExperimentConfig | null, items: Item[], alpha = 0.05): ExperimentReport {
  const byVariant = new Map<string, Item[]>();
  for (const i of items) {
    const v = i.variant ?? 'control';
    byVariant.set(v, [...(byVariant.get(v) ?? []), i]);
  }
  const variants = exp ? exp.arms.map((a) => a.variant) : [...byVariant.keys()].sort();
  const arms = variants.map((v) => armStats(v, byVariant.get(v) ?? []));
  const control = arms.find((a) => a.variant === 'control');
  const comparisons = arms
    .filter((a) => a.variant !== 'control')
    .map((a) => {
      if (!control || control.cleanApprovalRate === null || a.cleanApprovalRate === null) {
        return { variant: a.variant, lift: null, z: null, p: null, significant: false };
      }
      const t = twoProportionTest(control.approvedClean, control.reviewed, a.approvedClean, a.reviewed);
      return {
        variant: a.variant,
        lift: Math.round((a.cleanApprovalRate - control.cleanApprovalRate) * 1000) / 1000,
        z: t?.z ?? null,
        p: t?.p ?? null,
        significant: !!t && t.p < alpha,
      };
    });
  const minReviewed = Math.min(...arms.map((a) => a.reviewed));
  return {
    experimentId: exp?.id ?? null,
    arms,
    comparisons,
    note:
      minReviewed < 100
        ? `Fewer than 100 reviewed drafts in the smallest arm (${Number.isFinite(minReviewed) ? minReviewed : 0}); treat differences as noise for now.`
        : 'Auto-approved drafts are excluded from approval rates; only the QA sample measures them.',
  };
}
