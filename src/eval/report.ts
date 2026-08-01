import { GATES } from '../config.js';
import type {
  ExtractionResult,
  ListingLabels,
  ListingSnapshot,
  SentimentResult,
  Split,
  Tier,
} from '../schema/index.js';
import { scoreAttributes, scoreInclusions, scoreSalience } from './scorers/attributes.js';
import { costPerListing, summarizeCost, type CostBaseline } from './scorers/cost.js';
import { scoreCalibration, scoreIdentify, type IdentifyCase } from './scorers/identify.js';
import {
  scoreAbstention,
  scoreFairValue,
  scoreLeverGrounding,
} from './scorers/negotiate.js';
import { scoreActionability, scoreGenerationScoping } from './scorers/sentiment.js';

export interface ScoredCase {
  ablation: string;
  result: ExtractionResult;
  snapshot: ListingSnapshot;
  labels: ListingLabels | null;
}

export interface GateResult {
  name: string;
  threshold: string;
  observed: string;
  passed: boolean | null; // null = not enough data
  ifFails: string;
}

export interface Report {
  runId: string;
  split: Split;
  tier: Tier;
  backend: string;
  generatedAt: string;
  listingCount: number;
  /** Run health, checked before any metric is trusted. */
  health: { stageFailures: number; modelCalls: number; extractions: number };
  byAblation: Record<string, AblationScores>;
  gates: GateResult[];
  zeroShot: {
    heldOutCategory: string;
    heldOutT1: number | null;
    seededAvgT1: number | null;
    gapPoints: number | null;
  };
  notes: string[];
}

export interface AblationScores {
  identify: ReturnType<typeof scoreIdentify>;
  calibration: ReturnType<typeof scoreCalibration>;
  attributes: ReturnType<typeof scoreAttributes>;
  inclusions: ReturnType<typeof scoreInclusions>;
  salience: ReturnType<typeof scoreSalience>;
  actionability: ReturnType<typeof scoreActionability>;
  generationScoping: ReturnType<typeof scoreGenerationScoping>;
  fairValue: ReturnType<typeof scoreFairValue>;
  leverGrounding: ReturnType<typeof scoreLeverGrounding>;
  abstention: ReturnType<typeof scoreAbstention>;
  cost: ReturnType<typeof summarizeCost>;
  perListingCost: ReturnType<typeof costPerListing>;
}

const HELD_OUT_CATEGORY = 'co2_incubator';

export async function buildReport(
  cases: ScoredCase[],
  meta: {
    split: Split;
    tier: Tier;
    backend: string;
    baseline: CostBaseline | null;
    runId: string;
  },
): Promise<Report> {
  const byAblationCases = new Map<string, ScoredCase[]>();
  for (const c of cases) {
    const list = byAblationCases.get(c.ablation) ?? [];
    list.push(c);
    byAblationCases.set(c.ablation, list);
  }

  const byAblation: Record<string, AblationScores> = {};
  for (const [name, group] of byAblationCases) {
    byAblation[name] = scoreGroup(group, meta.baseline);
  }

  const primary = byAblation['full'] ?? Object.values(byAblation)[0];
  const fullCases = byAblationCases.get('full') ?? [...byAblationCases.values()][0] ?? [];

  const zeroShot = computeZeroShot(fullCases, meta.baseline);
  const gates = buildGates(primary, zeroShot);

  const notes: string[] = [];

  // Surface stage failures loudly. A run where every extraction errored
  // otherwise renders as a tidy table of "no data" gates, which reads like a
  // clean result rather than a broken run — the exact failure mode an eval
  // harness must never have.
  const errorCounts = new Map<string, number>();
  for (const c of cases) {
    for (const e of c.result.errors) {
      const key = `${e.stage}: ${e.message.slice(0, 160)}`;
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
  }
  if (errorCounts.size > 0) {
    const totalErrors = [...errorCounts.values()].reduce((s, n) => s + n, 0);
    notes.unshift(
      `${totalErrors} stage failure(s) across ${cases.length} extraction(s). Every metric below is computed only over stages that SUCCEEDED, so a high failure count makes the numbers unrepresentative rather than merely noisy:\n` +
        [...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([msg, n]) => `    ${n}x ${msg}`)
          .join('\n'),
    );
  }

  const ablationDerived = fullCases.filter((c) => c.snapshot.statedModel !== null).length;
  if (ablationDerived > 0) {
    notes.push(
      `${ablationDerived}/${fullCases.length} T1 labels are ablation-derived. Sellers who state their model are not a random sample — they tend to have better photos and nicer gear — so T1 numbers from that subset are an OPTIMISTIC CEILING, not an estimate.`,
    );
  }
  if (meta.backend === 'cli') {
    notes.push(
      meta.baseline
        ? `CLI backend: harness overhead measured at ${meta.baseline.overheadCacheTokensPerCall.toLocaleString()} cached tokens ($${meta.baseline.overheadCostUsdPerCall.toFixed(4)}) per call and subtracted. Use the API-equivalent column for the cost gate.`
        : `CLI backend with NO cost baseline. Reported cost includes Claude Code's own ~25k-token system prompt on every call. Run \`npm run baseline\` before trusting any cost number.`,
    );
    notes.push(
      `CLI runs are an agent loop, not one API call per stage. Latency and token counts are not directly comparable to a shipped extension — re-measure with \`--backend=api\` before setting the cost gate.`,
    );
  }
  if (meta.split === 'dev') {
    notes.push(
      `Dev split: prompts and taxonomy were iterated against these listings. These numbers are optimistic by construction. Only the holdout run decides the gates.`,
    );
  }

  return {
    runId: meta.runId,
    split: meta.split,
    tier: meta.tier,
    backend: meta.backend,
    generatedAt: new Date().toISOString(),
    listingCount: fullCases.length,
    health: {
      stageFailures: [...errorCounts.values()].reduce((s, n) => s + n, 0),
      modelCalls: cases.reduce((s, c) => s + c.result.usage.length, 0),
      extractions: cases.length,
    },
    byAblation,
    gates,
    zeroShot,
    notes,
  };
}

function scoreGroup(cases: ScoredCase[], baseline: CostBaseline | null): AblationScores {
  const identifyCases: IdentifyCase[] = cases.map((c) => ({
    listingId: c.result.listingId,
    category: c.snapshot.category,
    split: c.snapshot.split,
    predicted: c.result.identify,
    truth: c.snapshot.statedModel ?? c.labels?.trueModel ?? null,
    labelSource: c.snapshot.statedModel ? 'ablation' : 'hand',
  }));

  const sentiments = cases
    .map((c) => c.result.sentiment)
    .filter((s): s is SentimentResult => s !== null);

  return {
    identify: scoreIdentify(identifyCases),
    calibration: scoreCalibration(identifyCases),
    attributes: scoreAttributes(
      cases.map((c) => ({ attributes: c.result.attributes, labels: c.labels })),
    ),
    inclusions: scoreInclusions(
      cases.map((c) => ({ inclusions: c.result.inclusions, labels: c.labels })),
    ),
    salience: scoreSalience(cases.map((c) => ({ salience: c.result.salience, labels: c.labels }))),
    actionability: scoreActionability(sentiments),
    generationScoping: scoreGenerationScoping(
      cases.map((c) => ({
        findings: c.result.sentiment?.findings ?? [],
        trueGeneration: c.labels?.trueGeneration ?? null,
      })),
    ),
    fairValue: scoreFairValue(
      cases.map((c) => ({ brief: c.result.negotiation, labels: c.labels })),
    ),
    leverGrounding: scoreLeverGrounding(
      cases.map((c) => ({
        brief: c.result.negotiation,
        validFindingIds: collectFindingIds(c),
      })),
    ),
    abstention: scoreAbstention(
      cases.map((c) => ({
        brief: c.result.negotiation,
        compCount: c.labels?.comps.length ?? 0,
      })),
    ),
    cost: summarizeCost(cases.flatMap((c) => c.result.usage), baseline),
    perListingCost: costPerListing(
      cases.map((c) => c.result),
      baseline,
    ),
  };
}

function collectFindingIds(c: ScoredCase): string[] {
  const ids: string[] = [];
  c.result.attributes?.attributes.forEach((_, i) => ids.push(`t2-${i}`));
  c.result.inclusions?.inclusions.forEach((_, i) => ids.push(`t3-${i}`));
  c.result.sentiment?.findings.forEach((f) => ids.push(f.id));
  return ids;
}

/**
 * The most decision-relevant number in the exercise. The held-out category has
 * no taxonomy file; if it tracks the seeded average, "general consumer goods"
 * is real. If it collapses, the taxonomy files are doing the work and this is
 * a hand-curation business.
 */
function computeZeroShot(
  cases: ScoredCase[],
  baseline: CostBaseline | null,
): Report['zeroShot'] {
  const heldOut = cases.filter((c) => c.snapshot.category === HELD_OUT_CATEGORY);
  const seeded = cases.filter((c) => c.snapshot.category !== HELD_OUT_CATEGORY);

  if (heldOut.length === 0 || seeded.length === 0) {
    return {
      heldOutCategory: HELD_OUT_CATEGORY,
      heldOutT1: null,
      seededAvgT1: null,
      gapPoints: null,
    };
  }

  const h = scoreGroup(heldOut, baseline).identify.confidentTierPrecision;
  const s = scoreGroup(seeded, baseline).identify.confidentTierPrecision;
  return {
    heldOutCategory: HELD_OUT_CATEGORY,
    heldOutT1: h,
    seededAvgT1: s,
    gapPoints: (s - h) * 100,
  };
}

function buildGates(scores: AblationScores | undefined, zeroShot: Report['zeroShot']): GateResult[] {
  if (!scores) return [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  return [
    {
      name: 'T1 confident-tier precision',
      threshold: `>= ${pct(GATES.t1ConfidentPrecision)} at >= ${pct(GATES.t1MinCoverage)} coverage`,
      observed: `${pct(scores.identify.confidentTierPrecision)} at ${pct(scores.identify.confidentTierCoverage)} coverage (n=${scores.identify.confidentN})`,
      passed:
        scores.identify.confidentN === 0
          ? null
          : scores.identify.confidentTierPrecision >= GATES.t1ConfidentPrecision &&
            scores.identify.confidentTierCoverage >= GATES.t1MinCoverage,
      ifFails: 'Drop identification-led design. Reposition as a structured-questions tool.',
    },
    {
      name: 'T2 fabrication rate',
      threshold: `<= ${pct(GATES.t2MaxFabricationRate)}`,
      observed: `${pct(scores.attributes.fabricationRate)} (${scores.attributes.contradictedClaims}/${scores.attributes.checkedClaims} checked)`,
      passed:
        scores.attributes.checkedClaims === 0
          ? null
          : scores.attributes.fabricationRate <= GATES.t2MaxFabricationRate,
      ifFails: 'Never surface inferred specs. Show only "ask the seller about X".',
    },
    {
      name: 'T3 inclusion recall',
      threshold: `>= ${pct(GATES.t3MinRecall)} recall at >= ${pct(GATES.t3MinPrecision)} precision`,
      observed: `${pct(scores.inclusions.recall)} recall, ${pct(scores.inclusions.precision)} precision`,
      passed:
        scores.inclusions.truePositives + scores.inclusions.falseNegatives === 0
          ? null
          : scores.inclusions.recall >= GATES.t3MinRecall &&
            scores.inclusions.precision >= GATES.t3MinPrecision,
      ifFails: 'Cut the bundled-items feature.',
    },
    {
      name: 'T5 actionability',
      threshold: `>= ${pct(GATES.t5MinActionableFraction)} of findings pre-purchase actionable`,
      observed: `${pct(scores.actionability.actionableFraction)} (n=${scores.actionability.totalFindings})`,
      passed:
        scores.actionability.totalFindings === 0
          ? null
          : scores.actionability.actionableFraction >= GATES.t5MinActionableFraction,
      ifFails: 'Feature is decoration. Cut it.',
    },
    {
      name: 'T6 lever grounding',
      threshold: '100% (mechanical, by construction)',
      observed: `${pct(scores.leverGrounding.groundedRate)} (${scores.leverGrounding.ungroundedCount} ungrounded)`,
      passed: scores.leverGrounding.totalLevers === 0 ? null : scores.leverGrounding.groundedRate >= 1,
      ifFails: 'The validator is broken — this should be impossible, not merely rare.',
    },
    {
      name: 'T6 fair-value bias vs eBay sold',
      threshold: `within ±${pct(GATES.t6MaxFairValueBiasAbs)}, and not skewed high`,
      observed: `bias ${(scores.fairValue.bias * 100).toFixed(1)}%, MAE ${pct(scores.fairValue.meanAbsoluteError)} (n=${scores.fairValue.scoredN})`,
      passed:
        scores.fairValue.scoredN === 0
          ? null
          : Math.abs(scores.fairValue.bias) <= GATES.t6MaxFairValueBiasAbs,
      ifFails:
        'Drop point estimates. Show only the timing signals and evidence-backed levers, which stand on their own.',
    },
    {
      name: 'T6 abstention on starved input',
      threshold: '100% correct abstention below MIN_COMPS',
      observed: `${pct(scores.abstention.correctAbstentionRate)} (n=${scores.abstention.starvedCases} starved)`,
      passed: scores.abstention.starvedCases === 0 ? null : scores.abstention.correctAbstentionRate >= 1,
      ifFails: 'The abstention guard is not firing. Fix before any user sees a number.',
    },
    {
      name: 'Zero-shot held-out category',
      threshold: `within ${GATES.zeroShotMaxGapPoints} points of the seeded average`,
      observed:
        zeroShot.gapPoints === null
          ? 'not enough data (need both held-out and seeded listings)'
          : `${zeroShot.gapPoints.toFixed(1)} point gap (held-out ${pct(zeroShot.heldOutT1 ?? 0)} vs seeded ${pct(zeroShot.seededAvgT1 ?? 0)})`,
      passed:
        zeroShot.gapPoints === null ? null : zeroShot.gapPoints <= GATES.zeroShotMaxGapPoints,
      ifFails:
        '"General consumer goods" is not viable. Pivot to curated verticals — likely lab equipment, where willingness to pay is higher anyway.',
    },
  ];
}

export function renderReport(r: Report): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(`# Eval report — ${r.split} split, ${r.tier} tier`);
  lines.push('');
  lines.push(`Run: \`${r.runId}\`  |  Backend: \`${r.backend}\`  |  Listings: ${r.listingCount}`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push('');

  // Health check before anything else, so a broken run can't be mistaken for
  // a clean one at a glance.
  if (r.health.stageFailures > 0) {
    lines.push(
      `> **${r.health.stageFailures} stage failure(s)** and ${r.health.modelCalls} successful model call(s). ` +
        (r.health.modelCalls === 0
          ? 'NOTHING RAN — every metric below is vacuous. See Caveats.'
          : 'Metrics are computed only over stages that succeeded. See Caveats.'),
    );
    lines.push('');
  }

  lines.push('## Decision gates');
  lines.push('');
  lines.push('| Gate | Threshold | Observed | Result |');
  lines.push('|---|---|---|---|');
  for (const g of r.gates) {
    const mark = g.passed === null ? 'no data' : g.passed ? 'PASS' : '**FAIL**';
    lines.push(`| ${g.name} | ${g.threshold} | ${g.observed} | ${mark} |`);
  }
  lines.push('');

  const failed = r.gates.filter((g) => g.passed === false);
  if (failed.length > 0) {
    lines.push('### Failed gates — what each one means');
    lines.push('');
    for (const g of failed) lines.push(`- **${g.name}**: ${g.ifFails}`);
    lines.push('');
  }

  const primary = r.byAblation['full'] ?? Object.values(r.byAblation)[0];
  if (primary) {
    lines.push('## Detail (default config)');
    lines.push('');
    lines.push('### T1 — identify');
    lines.push(`- abstention rate: ${pct(primary.identify.abstentionRate)}`);
    lines.push(`- exact accuracy (of attempted): ${pct(primary.identify.exactAccuracy)}`);
    lines.push(`- family accuracy (of attempted): ${pct(primary.identify.familyAccuracy)}`);
    lines.push(
      `- **confident-tier precision: ${pct(primary.identify.confidentTierPrecision)} at ${pct(primary.identify.confidentTierCoverage)} coverage**`,
    );
    lines.push(`- confidently wrong: ${pct(primary.identify.confidentlyWrongRate)}`);
    lines.push('');

    lines.push('### Calibration');
    lines.push(`- ECE: ${primary.calibration.ece.toFixed(3)}`);
    lines.push('');
    lines.push('| confidence bucket | n | mean confidence | observed accuracy |');
    lines.push('|---|---|---|---|');
    for (const b of primary.calibration.buckets) {
      if (b.n === 0) continue;
      lines.push(
        `| ${b.lower.toFixed(1)}-${b.upper.toFixed(1)} | ${b.n} | ${b.meanConfidence.toFixed(2)} | ${b.observedAccuracy.toFixed(2)} |`,
      );
    }
    lines.push('');

    lines.push('### T2 — attributes');
    lines.push(`- recall: ${pct(primary.attributes.recall)}`);
    lines.push(`- precision: ${pct(primary.attributes.precision)}`);
    lines.push(`- **fabrication rate: ${pct(primary.attributes.fabricationRate)}**`);
    lines.push('');
    lines.push('| source | claims | checked | contradicted |');
    lines.push('|---|---|---|---|');
    for (const [src, s] of Object.entries(primary.attributes.bySource)) {
      lines.push(`| ${src} | ${s.claims} | ${s.checked} | ${s.contradicted} |`);
    }
    lines.push('');

    lines.push('### T3 — inclusions (unstated only)');
    lines.push(
      `- recall ${pct(primary.inclusions.recall)}, precision ${pct(primary.inclusions.precision)}, F1 ${pct(primary.inclusions.f1)}`,
    );
    lines.push(
      `- TP ${primary.inclusions.truePositives} / FP ${primary.inclusions.falsePositives} / FN ${primary.inclusions.falseNegatives}`,
    );
    lines.push('');

    lines.push('### T4 — salience');
    lines.push(`- rank-weighted overlap with expert top-5: ${pct(primary.salience.rankWeightedOverlap)}`);
    lines.push('');

    lines.push('### T5 — sentiment');
    lines.push(
      `- actionable fraction: ${pct(primary.actionability.actionableFraction)} of ${primary.actionability.totalFindings} findings`,
    );
    lines.push(`- by kind: ${JSON.stringify(primary.actionability.byKind)}`);
    lines.push(
      `- generation scoping: ${pct(primary.generationScoping.correctlyScopedRate)} correct, ${pct(primary.generationScoping.misscopedRate)} misscoped, ${pct(primary.generationScoping.unknownRate)} honest-unknown`,
    );
    lines.push(
      `- attribution: run \`scoreAttribution\` separately (it fetches cited pages over the network)`,
    );
    lines.push('');

    lines.push('### T6 — negotiation');
    lines.push(
      `- fair value bias ${(primary.fairValue.bias * 100).toFixed(1)}% (positive = advises overpaying), MAE ${pct(primary.fairValue.meanAbsoluteError)}, sd ${pct(primary.fairValue.stdDev)}`,
    );
    lines.push(`- abstained on thin data: ${pct(primary.fairValue.abstentionRate)}`);
    lines.push(`- lever grounding: ${pct(primary.leverGrounding.groundedRate)}`);
    lines.push('');

    lines.push('### Cost');
    lines.push(`- calls: ${primary.cost.calls}, mean wall clock ${Math.round(primary.cost.meanWallClockMs)}ms`);
    lines.push(`- raw reported: $${primary.cost.rawCostUsd.toFixed(4)}`);
    if (primary.cost.adjustedCostUsd !== null) {
      lines.push(`- adjusted (harness overhead removed): $${primary.cost.adjustedCostUsd.toFixed(4)}`);
    }
    lines.push(`- **API-equivalent (use this for the gate): $${primary.cost.apiEquivalentCostUsd.toFixed(4)}**`);
    lines.push('');
    for (const t of primary.perListingCost) {
      lines.push(
        `- ${t.tier} tier: $${t.meanApiEquivalentUsd.toFixed(4)}/listing, ${Math.round(t.meanWallClockMs)}ms/listing`,
      );
    }
    lines.push('');
  }

  const ablationNames = Object.keys(r.byAblation);
  if (ablationNames.length > 1) {
    lines.push('## Ablations');
    lines.push('');
    lines.push('| config | T1 confident precision | T1 coverage | T2 fabrication | T3 F1 | API-equiv cost |');
    lines.push('|---|---|---|---|---|---|');
    for (const [name, s] of Object.entries(r.byAblation)) {
      lines.push(
        `| ${name} | ${pct(s.identify.confidentTierPrecision)} | ${pct(s.identify.confidentTierCoverage)} | ${pct(s.attributes.fabricationRate)} | ${pct(s.inclusions.f1)} | $${s.cost.apiEquivalentCostUsd.toFixed(4)} |`,
      );
    }
    lines.push('');
  }

  if (r.notes.length > 0) {
    lines.push('## Caveats');
    lines.push('');
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}
