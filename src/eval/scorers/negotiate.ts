import { MIN_COMPS } from '../../config.js';
import type { Comp, ListingLabels, NegotiationBrief } from '../../schema/index.js';

/**
 * T6 scoring.
 *
 * Fair-value error is measured SIGNED, and bias is reported separately from
 * spread. Direction matters asymmetrically: over-estimating fair value costs
 * the buyer real money, under-estimating just costs them a deal. A tool with
 * ±10% absolute error that skews consistently high fails the gate even though
 * the absolute number looks acceptable.
 */

export interface FairValueScore {
  n: number;
  /** Mean signed relative error. Positive = over-estimates fair value =
   *  advises the buyer to overpay. This is the gated number. */
  bias: number;
  /** Spread, reported separately so a wide-but-unbiased estimator is
   *  distinguishable from a tight-but-skewed one. */
  meanAbsoluteError: number;
  stdDev: number;
  /** Correctly declined to produce a number. */
  abstentionRate: number;
  scoredN: number;
}

export function scoreFairValue(
  cases: { brief: NegotiationBrief | null; labels: ListingLabels | null }[],
): FairValueScore {
  const errors: number[] = [];
  let abstained = 0;
  let n = 0;

  for (const { brief, labels } of cases) {
    if (!brief) continue;
    n++;

    if (brief.fairValue.basis === 'insufficient_data' || brief.fairValue.point === null) {
      abstained++;
      continue;
    }

    // Only real sold prices can ground a calibration check. Comparing an
    // estimate against asking-price comps would validate the bias we are
    // trying to detect.
    const sold = (labels?.comps ?? []).filter((c) => c.source === 'ebay_sold');
    if (sold.length === 0) continue;

    const truth = median(sold.map((c) => c.priceUsd));
    if (truth <= 0) continue;

    errors.push((brief.fairValue.point - truth) / truth);
  }

  const bias = errors.length > 0 ? mean(errors) : 0;
  const mae = errors.length > 0 ? mean(errors.map(Math.abs)) : 0;
  const variance =
    errors.length > 1 ? mean(errors.map((e) => (e - bias) ** 2)) : 0;

  return {
    n,
    bias,
    meanAbsoluteError: mae,
    stdDev: Math.sqrt(variance),
    abstentionRate: n > 0 ? abstained / n : 0,
    scoredN: errors.length,
  };
}

// --- Comp validity ---------------------------------------------------------

export interface CompValidityScore {
  totalComps: number;
  /** Must be zero. A bogus comp is the failure most likely to embarrass a
   *  buyer in front of a seller who knows their own market. */
  fabricatedRate: number;
  fabricatedCount: number;
}

/**
 * Checks every comp the brief relied on against the supplied comp set. Any
 * comp the model produced that is not in the labeled set is fabricated.
 *
 * Note the current pipeline hands comps TO the model rather than letting it
 * invent them, so this should be structurally zero — this scorer exists to
 * catch a regression if that ever changes.
 */
export function scoreCompValidity(
  cases: { usedComps: Comp[]; suppliedComps: Comp[] }[],
): CompValidityScore {
  let total = 0;
  let fabricated = 0;

  for (const { usedComps, suppliedComps } of cases) {
    const supplied = new Set(suppliedComps.map(compKey));
    for (const c of usedComps) {
      total++;
      if (!supplied.has(compKey(c))) fabricated++;
    }
  }

  return {
    totalComps: total,
    fabricatedRate: total > 0 ? fabricated / total : 0,
    fabricatedCount: fabricated,
  };
}

function compKey(c: Comp): string {
  return `${c.source}|${c.model.toLowerCase().trim()}|${c.priceUsd}`;
}

// --- Lever grounding -------------------------------------------------------

export interface LeverGroundingScore {
  totalLevers: number;
  /** Should be 1.0 by construction — the pipeline drops unresolvable levers
   *  before they reach the output. Anything below 1.0 means the validator is
   *  broken, not that the model behaved badly. */
  groundedRate: number;
  ungroundedCount: number;
}

export function scoreLeverGrounding(
  cases: { brief: NegotiationBrief | null; validFindingIds: string[] }[],
): LeverGroundingScore {
  let total = 0;
  let ungrounded = 0;

  for (const { brief, validFindingIds } of cases) {
    if (!brief) continue;
    const valid = new Set(validFindingIds);
    for (const lever of brief.levers) {
      total++;
      if (!valid.has(lever.sourceFindingId)) ungrounded++;
    }
  }

  return {
    totalLevers: total,
    groundedRate: total > 0 ? (total - ungrounded) / total : 1,
    ungroundedCount: ungrounded,
  };
}

// --- Abstention ------------------------------------------------------------

export interface AbstentionScore {
  starvedCases: number;
  /** Of cases given fewer than MIN_COMPS, how many avoided producing an
   *  UNGROUNDED point estimate. Two ways to do that: refuse outright
   *  (insufficient_data / null point), or fall back to msrp_depreciated —
   *  which is not abstention, but is not a violation either. That basis is
   *  mechanically gated in negotiate.ts to only ever fire when a real,
   *  sourced retail price backed it, so "starved of comps" there doesn't
   *  mean "starved of grounding." Treating it as a failure here would
   *  penalize the code for successfully using its designed fallback. */
  correctAbstentionRate: number;
}

export function scoreAbstention(
  cases: { brief: NegotiationBrief | null; compCount: number }[],
): AbstentionScore {
  const starved = cases.filter((c) => c.compCount < MIN_COMPS);
  if (starved.length === 0) return { starvedCases: 0, correctAbstentionRate: 1 };

  const correct = starved.filter(
    (c) =>
      c.brief === null ||
      c.brief.fairValue.basis === 'insufficient_data' ||
      c.brief.fairValue.basis === 'msrp_depreciated' ||
      c.brief.fairValue.point === null,
  ).length;

  return {
    starvedCases: starved.length,
    correctAbstentionRate: correct / starved.length,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
