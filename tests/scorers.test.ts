import { describe, expect, it } from 'vitest';
import { scoreAttributes, scoreInclusions, scoreSalience } from '../src/eval/scorers/attributes.js';
import { scoreCalibration, scoreIdentify, type IdentifyCase } from '../src/eval/scorers/identify.js';
import {
  scoreAbstention,
  scoreFairValue,
  scoreLeverGrounding,
} from '../src/eval/scorers/negotiate.js';
import {
  scoreActionability,
  scoreAttribution,
  scoreGenerationScoping,
  verifiableUrl,
} from '../src/eval/scorers/sentiment.js';
import { modelsMatchExact, modelsMatchFamily, quoteAppearsIn } from '../src/eval/scorers/text.js';
import type {
  Attribute,
  IdentifyResult,
  ListingLabels,
  NegotiationBrief,
  SentimentResult,
} from '../src/schema/index.js';

const id = (over: Partial<IdentifyResult> = {}): IdentifyResult => ({
  abstained: false,
  brand: 'Rogue',
  model: 'R-3',
  generation: null,
  family: null,
  confidence: 0.9,
  reasoning: '',
  evidenceImageIndices: [],
  ...over,
});

const labels = (over: Partial<ListingLabels> = {}): ListingLabels => ({
  listingId: 'x',
  trueModel: 'R-3',
  trueGeneration: null,
  trueAttributes: {},
  trueUnstatedInclusions: [],
  expertTopAttributes: [],
  logisticsCostUsd: null,
  refurbCostUsd: null,
  comps: [],
  ...over,
});

describe('text matching', () => {
  it('treats formatting variants of a model as the same model', () => {
    expect(modelsMatchExact('Rogue R-3', 'rogue r3')).toBe(true);
  });

  it('does not treat a different model number as a family match', () => {
    // The whole point of family-level partial credit is that it must not
    // reward getting the model number wrong.
    expect(modelsMatchFamily('Rogue R-4', 'Rogue R-3')).toBe(false);
  });

  it('ignores whitespace and smart quotes when matching a citation', () => {
    expect(quoteAppearsIn('the  J-cups   scratch', 'Yes, the J-cups scratch the bar.')).toBe(true);
  });

  it('rejects a quote too short to be evidence', () => {
    expect(quoteAppearsIn('it', 'it is fine')).toBe(false);
  });
});

describe('scoreIdentify', () => {
  it('rewards abstention rather than counting it as a wrong answer', () => {
    const cases: IdentifyCase[] = [
      { listingId: '1', category: 'c', split: 'dev', predicted: id({ abstained: true, model: null }), truth: 'R-3', labelSource: 'ablation' },
      { listingId: '2', category: 'c', split: 'dev', predicted: id(), truth: 'R-3', labelSource: 'ablation' },
    ];
    const s = scoreIdentify(cases);
    expect(s.abstentionRate).toBe(0.5);
    // Accuracy is over ATTEMPTED cases, so abstaining doesn't drag it down.
    expect(s.exactAccuracy).toBe(1);
  });

  it('separates confident-tier precision from raw accuracy', () => {
    // Right when confident, wrong when unconfident: exactly the shape that
    // makes a usable product, and raw accuracy hides it.
    const cases: IdentifyCase[] = [
      { listingId: '1', category: 'c', split: 'dev', predicted: id({ confidence: 0.9 }), truth: 'R-3', labelSource: 'ablation' },
      { listingId: '2', category: 'c', split: 'dev', predicted: id({ model: 'WRONG', confidence: 0.3 }), truth: 'R-3', labelSource: 'ablation' },
    ];
    const s = scoreIdentify(cases);
    expect(s.exactAccuracy).toBe(0.5);
    expect(s.confidentTierPrecision).toBe(1);
    expect(s.confidentTierCoverage).toBe(0.5);
    expect(s.confidentlyWrongRate).toBe(0);
  });

  it('credits a correct answer that puts the brand in its own field', () => {
    // Regression: ground truth is "Acme PX-1235" but the schema splits
    // identification across brand and model, so a CORRECT answer arrives as
    // {brand: "ACME", model: "PX-1235"}. Comparing model alone against the
    // full truth string scored this as wrong — and it failed in the direction
    // that makes the product look worse than it is, so the results alone would
    // never have revealed the bug.
    const cases: IdentifyCase[] = [
      {
        listingId: '1',
        category: 'home_gym',
        split: 'dev',
        predicted: id({ brand: 'ACME', model: 'PX-1235', confidence: 0.95 }),
        truth: 'Acme PX-1235',
        labelSource: 'ablation',
      },
    ];
    const s = scoreIdentify(cases);
    expect(s.exactAccuracy).toBe(1);
    expect(s.confidentTierPrecision).toBe(1);
  });

  it('still counts a genuinely wrong model as wrong when the brand is right', () => {
    const cases: IdentifyCase[] = [
      {
        listingId: '1',
        category: 'home_gym',
        split: 'dev',
        predicted: id({ brand: 'Acme', model: 'PX-9999', confidence: 0.95 }),
        truth: 'Acme PX-1235',
        labelSource: 'ablation',
      },
    ];
    expect(scoreIdentify(cases).exactAccuracy).toBe(0);
  });

  it('flags confidently wrong answers, the failure that kills the product', () => {
    const cases: IdentifyCase[] = [
      { listingId: '1', category: 'c', split: 'dev', predicted: id({ model: 'WRONG', confidence: 0.95 }), truth: 'R-3', labelSource: 'ablation' },
    ];
    const s = scoreIdentify(cases);
    expect(s.confidentTierPrecision).toBe(0);
    expect(s.confidentlyWrongRate).toBe(1);
  });
});

describe('scoreCalibration', () => {
  it('gives a low ECE to an honestly calibrated model', () => {
    const cases: IdentifyCase[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        listingId: `hi${i}`,
        category: 'c',
        split: 'dev',
        predicted: id({ confidence: 0.9 }),
        truth: 'R-3',
        labelSource: 'ablation' as const,
      })),
      { listingId: 'hi-miss', category: 'c', split: 'dev', predicted: id({ model: 'WRONG', confidence: 0.9 }), truth: 'R-3', labelSource: 'ablation' },
    ];
    // Claims 0.9, right 9/10.
    expect(scoreCalibration(cases).ece).toBeLessThan(0.05);
  });

  it('gives a high ECE to an overconfident model', () => {
    const cases: IdentifyCase[] = Array.from({ length: 10 }, (_, i) => ({
      listingId: `x${i}`,
      category: 'c',
      split: 'dev',
      predicted: id({ model: i < 5 ? 'R-3' : 'WRONG', confidence: 0.95 }),
      truth: 'R-3',
      labelSource: 'ablation' as const,
    }));
    // Claims 0.95, right 5/10.
    expect(scoreCalibration(cases).ece).toBeGreaterThan(0.4);
  });
});

describe('scoreAttributes — the fabrication scorer', () => {
  const attr = (over: Partial<Attribute> = {}): Attribute => ({
    key: 'upright_steel_gauge',
    value: '11 gauge',
    confidence: 0.9,
    source: 'spec_lookup',
    evidence: { imageIndex: null, bbox: null, quote: null, url: 'https://x' },
    ...over,
  });

  it('CATCHES a deliberately fabricating fixture', () => {
    // The fixture the plan calls for: a model that confidently states the
    // wrong gauge. If this ever passes, the kill metric is broken.
    const s = scoreAttributes([
      {
        attributes: { attributes: [attr({ value: '14 gauge' })], questionsForSeller: [] },
        labels: labels({ trueAttributes: { upright_steel_gauge: '11 gauge' } }),
      },
    ]);
    expect(s.fabricationRate).toBe(1);
    expect(s.contradictedClaims).toBe(1);
  });

  it('does not punish formatting differences', () => {
    const s = scoreAttributes([
      {
        attributes: { attributes: [attr({ value: '11-gauge' })], questionsForSeller: [] },
        labels: labels({ trueAttributes: { upright_steel_gauge: '11 gauge' } }),
      },
    ]);
    expect(s.fabricationRate).toBe(0);
  });

  it('attributes fabrication to its source so grounding can be evaluated', () => {
    const s = scoreAttributes([
      {
        attributes: {
          attributes: [
            attr({ key: 'a', value: 'wrong', source: 'model_prior', evidence: null }),
            attr({ key: 'b', value: 'right', source: 'spec_lookup' }),
          ],
          questionsForSeller: [],
        },
        labels: labels({ trueAttributes: { a: 'right', b: 'right' } }),
      },
    ]);
    expect(s.bySource['model_prior']!.contradicted).toBe(1);
    expect(s.bySource['spec_lookup']!.contradicted).toBe(0);
  });

  it('does not count an unverifiable claim as a fabrication', () => {
    // No ground truth for this key: it is unchecked, not wrong. Counting it
    // either way would be dishonest.
    const s = scoreAttributes([
      {
        attributes: { attributes: [attr({ key: 'unlabeled' })], questionsForSeller: [] },
        labels: labels({ trueAttributes: { other: 'x' } }),
      },
    ]);
    expect(s.checkedClaims).toBe(0);
    expect(s.fabricationRate).toBe(0);
  });
});

describe('scoreInclusions', () => {
  it('only credits inclusions the listing text did not mention', () => {
    const s = scoreInclusions([
      {
        inclusions: {
          inclusions: [
            { label: 'dumbbells', kind: 'bundled_item', imageIndex: 3, confidence: 0.8, mentionedInText: false, estimatedValueUsd: 100 },
            // Already in the text — finding it is not a discovery.
            { label: 'barbell', kind: 'bundled_item', imageIndex: 1, confidence: 0.9, mentionedInText: true, estimatedValueUsd: 150 },
          ],
        },
        labels: labels({
          trueUnstatedInclusions: [{ label: 'pair of dumbbells', kind: 'bundled_item', imageIndex: 3 }],
        }),
      },
    ]);
    expect(s.truePositives).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.recall).toBe(1);
  });

  it('counts an invented inclusion as a false positive', () => {
    const s = scoreInclusions([
      {
        inclusions: {
          inclusions: [
            { label: 'gold bars', kind: 'bundled_item', imageIndex: 0, confidence: 0.9, mentionedInText: false, estimatedValueUsd: 99999 },
          ],
        },
        labels: labels({ trueUnstatedInclusions: [] }),
      },
    ]);
    expect(s.falsePositives).toBe(1);
    expect(s.precision).toBe(0);
  });
});

describe('scoreSalience', () => {
  it('rewards getting the most important attribute first', () => {
    const expert = ['a', 'b', 'c'];
    const good = scoreSalience([
      { salience: { rankedKeys: ['a', 'b', 'c'], rationale: '' }, labels: labels({ expertTopAttributes: expert }) },
    ]);
    const reversed = scoreSalience([
      { salience: { rankedKeys: ['c', 'b', 'a'], rationale: '' }, labels: labels({ expertTopAttributes: expert }) },
    ]);
    expect(good.rankWeightedOverlap).toBe(1);
    // Same set, worse order: plain overlap can't tell these apart.
    expect(reversed.plainTop5Overlap).toBe(1);
    expect(reversed.rankWeightedOverlap).toBeLessThanOrEqual(good.rankWeightedOverlap);
  });
});

describe('T5 scorers', () => {
  const sentiment = (over: Partial<SentimentResult['findings'][number]>): SentimentResult => ({
    conditionedOnModel: 'Rogue R-3',
    findings: [
      {
        id: 'f1',
        claim: 'c',
        kind: 'wear_item',
        appliesToGeneration: 'unknown',
        citations: [{ url: 'https://x', quote: 'q' }],
        consensusStrength: 'several',
        ...over,
      },
    ],
  });

  it('scores generic praise as non-actionable', () => {
    // Ten flavors of "great rack, love it" is a failed feature even at 100%
    // attribution accuracy.
    expect(scoreActionability([sentiment({ kind: 'praise' })]).actionableFraction).toBe(0);
    expect(scoreActionability([sentiment({ kind: 'known_defect' })]).actionableFraction).toBe(1);
  });

  it('treats honest "unknown" scoping as correct', () => {
    const s = scoreGenerationScoping([
      { findings: sentiment({ appliesToGeneration: 'unknown' }).findings, trueGeneration: '2019' },
    ]);
    expect(s.correctlyScopedRate).toBe(1);
    expect(s.misscopedRate).toBe(0);
  });

  it('counts confident misscoping as an error, not a miss', () => {
    const s = scoreGenerationScoping([
      { findings: sentiment({ appliesToGeneration: '2014' }).findings, trueGeneration: '2023' },
    ]);
    expect(s.misscopedRate).toBe(1);
  });
});

describe('T6 scorers', () => {
  const brief = (over: Partial<NegotiationBrief> = {}): NegotiationBrief => ({
    fairValue: { low: 400, point: 500, high: 600, basis: 'ebay_sold' },
    askingPremiumUsd: 0,
    levers: [],
    walkAwayUsd: 350,
    batna: null,
    sellerMotivation: { daysListed: null, priceDrops: null, relistCount: null, confidence: 0 },
    openingOfferUsd: 450,
    unknowns: [],
    ...over,
  });

  it('reports fair-value error signed, so overpaying is distinguishable', () => {
    const overpay = scoreFairValue([
      {
        brief: brief({ fairValue: { low: 0, point: 600, high: 0, basis: 'ebay_sold' } }),
        labels: labels({
          comps: [{ id: 'c', source: 'ebay_sold', url: null, model: 'R-3', isExactModel: true, conditionTier: 'used', priceUsd: 500, distanceMiles: null, observedAt: '2026-01-01' }],
        }),
      },
    ]);
    // +20%: advises the buyer to overpay. Must not be hidden by an absolute value.
    expect(overpay.bias).toBeCloseTo(0.2);
    expect(overpay.meanAbsoluteError).toBeCloseTo(0.2);
  });

  it('does not let opposite-direction errors cancel in the bias metric alone', () => {
    const mixed = scoreFairValue([
      {
        brief: brief({ fairValue: { low: 0, point: 600, high: 0, basis: 'ebay_sold' } }),
        labels: labels({ comps: [{ id: 'c', source: 'ebay_sold', url: null, model: 'R-3', isExactModel: true, conditionTier: 'used', priceUsd: 500, distanceMiles: null, observedAt: '2026-01-01' }] }),
      },
      {
        brief: brief({ fairValue: { low: 0, point: 400, high: 0, basis: 'ebay_sold' } }),
        labels: labels({ comps: [{ id: 'c', source: 'ebay_sold', url: null, model: 'R-3', isExactModel: true, conditionTier: 'used', priceUsd: 500, distanceMiles: null, observedAt: '2026-01-01' }] }),
      },
    ]);
    expect(mixed.bias).toBeCloseTo(0);
    // Which is exactly why MAE is reported alongside it.
    expect(mixed.meanAbsoluteError).toBeCloseTo(0.2);
  });

  it('credits correct abstention on starved input', () => {
    const s = scoreAbstention([
      {
        brief: brief({ fairValue: { low: null, point: null, high: null, basis: 'insufficient_data' } }),
        compCount: 1,
      },
    ]);
    expect(s.correctAbstentionRate).toBe(1);
  });

  it('fails a brief that invents a number from one comp', () => {
    const s = scoreAbstention([{ brief: brief(), compCount: 1 }]);
    expect(s.correctAbstentionRate).toBe(0);
  });

  it('flags an ungrounded lever', () => {
    const s = scoreLeverGrounding([
      {
        brief: brief({ levers: [{ claim: 'rust', sourceFindingId: 'nonexistent', estimatedValueUsd: 50 }] }),
        validFindingIds: ['t3-0'],
      },
    ]);
    expect(s.groundedRate).toBe(0);
    expect(s.ungroundedCount).toBe(1);
  });
});

describe('T5 attribution — fetch verification', () => {
  it('rewrites reddit.com to old.reddit.com, which actually serves comment text', () => {
    // Measured: www.reddit.com comment threads return HTTP 200 with ~37 usable
    // chars (JS shell); old.reddit.com returns ~49,689 for the same thread.
    expect(verifiableUrl('https://www.reddit.com/r/homegym/comments/abc/x/')).toBe(
      'https://old.reddit.com/r/homegym/comments/abc/x/',
    );
    expect(verifiableUrl('https://reddit.com/r/homegym/')).toContain('old.reddit.com');
  });

  it('leaves non-reddit URLs untouched', () => {
    expect(verifiableUrl('https://forum.example.com/t/1')).toBe('https://forum.example.com/t/1');
  });

  it('counts a thin HTTP 200 as a fetch failure, not as a missing quote', async () => {
    // The distinction that matters: a bot-check page or JS shell must not be
    // scored as "the model cited a quote that is not there". Conflating them
    // drives T5 to ~0% and blames the model for a broken verifier.
    const score = await scoreAttribution(
      [
        {
          conditionedOnModel: 'Rogue R-3',
          findings: [
            {
              id: 'f1',
              claim: 'J-cups scratch the bar',
              kind: 'known_defect',
              appliesToGeneration: 'unknown',
              citations: [{ url: 'https://www.reddit.com/r/homegym/comments/x/', quote: 'the J-cups scratch the bar sleeve' }],
              consensusStrength: 'several',
            },
          ],
        },
      ],
      { fetcher: async () => null },
    );
    expect(score.fetchFailures).toBe(1);
    // Excluded from the denominator rather than counted as a miss.
    expect(score.quoteMatchRate).toBe(0);
    expect(score.totalCitations).toBe(1);
  });

  it('confirms a quote that really appears in the fetched page', async () => {
    const score = await scoreAttribution(
      [
        {
          conditionedOnModel: 'Rogue R-3',
          findings: [
            {
              id: 'f1',
              claim: 'J-cups scratch the bar',
              kind: 'known_defect',
              appliesToGeneration: 'unknown',
              citations: [{ url: 'https://old.reddit.com/x', quote: 'the J-cups scratch the bar sleeve' }],
              consensusStrength: 'several',
            },
          ],
        },
      ],
      { fetcher: async () => 'Honestly the J-cups scratch the bar sleeve after a few months.' },
    );
    expect(score.fetchFailures).toBe(0);
    expect(score.quoteMatchRate).toBe(1);
  });

  it('catches a fabricated quote that is not on the page', async () => {
    const score = await scoreAttribution(
      [
        {
          conditionedOnModel: 'Rogue R-3',
          findings: [
            {
              id: 'f1',
              claim: 'known bearing defect',
              kind: 'known_defect',
              appliesToGeneration: 'unknown',
              citations: [{ url: 'https://old.reddit.com/x', quote: 'this is a known bearing defect across all units' }],
              consensusStrength: 'widespread',
            },
          ],
        },
      ],
      { fetcher: async () => 'Mine squeaked once but it was fine after some grease. Love this rack otherwise.' },
    );
    expect(score.fetchFailures).toBe(0);
    expect(score.quoteMatchRate).toBe(0);
  });
});
