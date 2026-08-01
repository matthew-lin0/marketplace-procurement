import { CONFIDENT_TIER_THRESHOLD } from '../../config.js';
import type { IdentifyResult } from '../../schema/index.js';
import { modelsMatchExact, modelsMatchFamily } from './text.js';

/**
 * T1 scoring.
 *
 * The headline number is NOT raw accuracy. It is precision within the
 * high-confidence tier, reported alongside that tier's coverage. A tool that
 * says "Rogue R-3" and is right 60% of the time is worse than useless. One that
 * says "Rogue-style 3x3 rack, cannot confirm model" and is right 95% of the
 * time is a product.
 */

export interface IdentifyCase {
  listingId: string;
  category: string;
  split: string;
  predicted: IdentifyResult | null;
  truth: string | null;
  /** Where the label came from. Ablation-derived labels come from sellers who
   *  state their model — not a random sample, so their numbers are an
   *  optimistic ceiling and the report must say so. */
  labelSource: 'ablation' | 'hand';
}

export interface IdentifyScore {
  n: number;
  /** Fraction where the model declined to guess. Not a failure — abstention is
   *  a rewarded output. */
  abstentionRate: number;
  /** Over attempted (non-abstained) cases. */
  exactAccuracy: number;
  familyAccuracy: number;
  /** THE headline pair. */
  confidentTierPrecision: number;
  confidentTierCoverage: number;
  /** Wrong AND confident. The number that kills the product if it is high. */
  confidentlyWrongRate: number;
  attempted: number;
  confidentN: number;
}

/**
 * Ground truth is a full "Brand Model" string ("Acme PX-1235"), but the schema
 * splits identification across `brand` and `model`, so a correct answer often
 * has model="PX-1235" with the brand in its own field.
 *
 * Comparing `model` alone against the full truth string scores those correct
 * answers as wrong — and it fails in the direction that makes the product look
 * worse than it is, so it would never look like a bug from the results alone.
 * We compare the truth against both renderings and take the better one.
 */
function candidateStrings(p: IdentifyResult): string[] {
  const out: string[] = [];
  if (p.model) {
    out.push(p.model);
    if (p.brand) out.push(`${p.brand} ${p.model}`);
  }
  return out;
}

function matchesTruth(
  p: IdentifyResult,
  truth: string,
  aliases: string[][],
): { exact: boolean; family: boolean } {
  const candidates = candidateStrings(p);
  return {
    exact: candidates.some((c) => modelsMatchExact(c, truth)),
    family: candidates.some((c) => modelsMatchFamily(c, truth, aliases)),
  };
}

export function scoreIdentify(cases: IdentifyCase[], aliases: string[][] = []): IdentifyScore {
  const scored = cases.filter((c) => c.truth !== null);
  const n = scored.length;
  if (n === 0) {
    return {
      n: 0,
      abstentionRate: 0,
      exactAccuracy: 0,
      familyAccuracy: 0,
      confidentTierPrecision: 0,
      confidentTierCoverage: 0,
      confidentlyWrongRate: 0,
      attempted: 0,
      confidentN: 0,
    };
  }

  let abstained = 0;
  let attempted = 0;
  let exact = 0;
  let family = 0;
  let confidentN = 0;
  let confidentCorrect = 0;

  for (const c of scored) {
    const p = c.predicted;
    if (!p || p.abstained || !p.model) {
      abstained++;
      continue;
    }
    attempted++;
    const m = matchesTruth(p, c.truth!, aliases);
    const isExact = m.exact;
    const isFamily = m.exact || m.family;
    if (isExact) exact++;
    if (isFamily) family++;

    if (p.confidence >= CONFIDENT_TIER_THRESHOLD) {
      confidentN++;
      if (isExact) confidentCorrect++;
    }
  }

  return {
    n,
    abstentionRate: abstained / n,
    exactAccuracy: attempted > 0 ? exact / attempted : 0,
    familyAccuracy: attempted > 0 ? family / attempted : 0,
    confidentTierPrecision: confidentN > 0 ? confidentCorrect / confidentN : 0,
    confidentTierCoverage: confidentN / n,
    confidentlyWrongRate: (confidentN - confidentCorrect) / n,
    attempted,
    confidentN,
  };
}

// --- Calibration -----------------------------------------------------------

export interface CalibrationBucket {
  lower: number;
  upper: number;
  n: number;
  meanConfidence: number;
  observedAccuracy: number;
}

export interface CalibrationScore {
  buckets: CalibrationBucket[];
  /** Expected Calibration Error. Low ECE with mediocre accuracy still makes a
   *  usable product, because the UI can gate on confidence. High ECE does not,
   *  at any accuracy. */
  ece: number;
}

export function scoreCalibration(cases: IdentifyCase[], bucketCount = 5): CalibrationScore {
  const points = cases
    .filter((c) => c.truth !== null && c.predicted && !c.predicted.abstained && c.predicted.model)
    .map((c) => ({
      confidence: c.predicted!.confidence,
      correct: matchesTruth(c.predicted!, c.truth!, []).exact,
    }));

  const buckets: CalibrationBucket[] = [];
  let ece = 0;

  for (let i = 0; i < bucketCount; i++) {
    const lower = i / bucketCount;
    const upper = (i + 1) / bucketCount;
    const inBucket = points.filter(
      (p) => p.confidence >= lower && (i === bucketCount - 1 ? p.confidence <= upper : p.confidence < upper),
    );
    if (inBucket.length === 0) {
      buckets.push({ lower, upper, n: 0, meanConfidence: 0, observedAccuracy: 0 });
      continue;
    }
    const meanConfidence = inBucket.reduce((s, p) => s + p.confidence, 0) / inBucket.length;
    const observedAccuracy = inBucket.filter((p) => p.correct).length / inBucket.length;
    buckets.push({ lower, upper, n: inBucket.length, meanConfidence, observedAccuracy });
    ece += (inBucket.length / points.length) * Math.abs(meanConfidence - observedAccuracy);
  }

  return { buckets, ece: points.length > 0 ? ece : 0 };
}
