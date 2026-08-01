import type {
  Attribute,
  AttributeSet,
  InclusionSet,
  ListingLabels,
  SalienceRanking,
} from '../../schema/index.js';
import { keysMatch, valuesAgree } from './text.js';

/**
 * T2 scoring. Fabrication rate is the kill metric: a claim contradicted by the
 * true spec sheet is worse than a blank field, because the buyer acts on it.
 *
 * Reported per source so we can see whether spec-lookup grounding does what we
 * think. `model_prior` claims are expected to fabricate more; if they do not,
 * grounding is buying less than assumed.
 */

export interface AttributeScore {
  n: number;
  /** Of the labeled decision-relevant attributes, how many did we surface. */
  recall: number;
  /** Of the claims we made about labeled attributes, how many were right. */
  precision: number;
  /** THE kill metric: claims contradicted by ground truth, over all claims
   *  that could be checked. */
  fabricationRate: number;
  bySource: Record<string, { claims: number; checked: number; contradicted: number }>;
  checkedClaims: number;
  contradictedClaims: number;
}

export function scoreAttributes(
  results: { attributes: AttributeSet | null; labels: ListingLabels | null }[],
): AttributeScore {
  const bySource: AttributeScore['bySource'] = {};
  let truthTotal = 0;
  let recalled = 0;
  let checked = 0;
  let correct = 0;
  let contradicted = 0;

  const bump = (src: string, field: 'claims' | 'checked' | 'contradicted') => {
    bySource[src] ??= { claims: 0, checked: 0, contradicted: 0 };
    bySource[src][field]++;
  };

  for (const { attributes, labels } of results) {
    if (!labels) continue;
    const truth = Object.entries(labels.trueAttributes);
    truthTotal += truth.length;

    const claims: Attribute[] = attributes?.attributes ?? [];
    for (const c of claims) bump(c.source, 'claims');

    for (const [key, trueValue] of truth) {
      const claim = claims.find((c) => keysMatch(c.key, key));
      if (!claim) continue;

      recalled++;
      checked++;
      bump(claim.source, 'checked');

      if (valuesAgree(claim.value, trueValue)) {
        correct++;
      } else {
        // Contradicted by ground truth. Not "unverified" — actually wrong.
        contradicted++;
        bump(claim.source, 'contradicted');
      }
    }
  }

  return {
    n: results.length,
    recall: truthTotal > 0 ? recalled / truthTotal : 0,
    precision: checked > 0 ? correct / checked : 0,
    fabricationRate: checked > 0 ? contradicted / checked : 0,
    bySource,
    checkedClaims: checked,
    contradictedClaims: contradicted,
  };
}

// --- T3 --------------------------------------------------------------------

export interface InclusionScore {
  n: number;
  /** Scored ONLY over inclusions absent from the listing text. Things the text
   *  already says are not the product. */
  recall: number;
  precision: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export function scoreInclusions(
  results: { inclusions: InclusionSet | null; labels: ListingLabels | null }[],
): InclusionScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const { inclusions, labels } of results) {
    if (!labels) continue;
    const truth = labels.trueUnstatedInclusions;
    // Only unmentioned predictions count — a model that re-reports what the
    // listing already said has found nothing.
    const preds = (inclusions?.inclusions ?? []).filter((i) => !i.mentionedInText);

    const matchedTruth = new Set<number>();
    for (const p of preds) {
      const idx = truth.findIndex(
        (t, i) => !matchedTruth.has(i) && labelsOverlap(p.label, t.label) && p.kind === t.kind,
      );
      if (idx >= 0) {
        matchedTruth.add(idx);
        tp++;
      } else {
        fp++;
      }
    }
    fn += truth.length - matchedTruth.size;
  }

  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  return {
    n: results.length,
    recall,
    precision,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
  };
}

/** "pair of 25lb dumbbells" should match "dumbbells". Token overlap with a
 *  content-word requirement, so "the" alone never matches. */
function labelsOverlap(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const ta = norm(a);
  const tb = norm(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const shared = [...ta].filter((t) => tb.has(t));
  return shared.length > 0;
}

// --- T4 --------------------------------------------------------------------

export interface SalienceScore {
  n: number;
  /** Rank-weighted overlap with the expert top-5. Credit decays with position
   *  so getting the single most important attribute right matters most. */
  rankWeightedOverlap: number;
  plainTop5Overlap: number;
}

export function scoreSalience(
  results: { salience: SalienceRanking | null; labels: ListingLabels | null }[],
): SalienceScore {
  let weighted = 0;
  let plain = 0;
  let scored = 0;

  for (const { salience, labels } of results) {
    if (!labels || labels.expertTopAttributes.length === 0) continue;
    scored++;

    const expert = labels.expertTopAttributes.slice(0, 5);
    const predicted = (salience?.rankedKeys ?? []).slice(0, 5);

    // DCG-style: credit for a hit decays by predicted rank, normalized by the
    // best achievable score for this many expert items.
    let dcg = 0;
    let ideal = 0;
    for (let i = 0; i < expert.length; i++) ideal += 1 / Math.log2(i + 2);
    for (let i = 0; i < predicted.length; i++) {
      if (expert.some((e) => keysMatch(e, predicted[i]!))) {
        dcg += 1 / Math.log2(i + 2);
      }
    }
    weighted += ideal > 0 ? dcg / ideal : 0;

    const hits = predicted.filter((p) => expert.some((e) => keysMatch(e, p))).length;
    plain += hits / expert.length;
  }

  return {
    n: scored,
    rankWeightedOverlap: scored > 0 ? weighted / scored : 0,
    plainTop5Overlap: scored > 0 ? plain / scored : 0,
  };
}
