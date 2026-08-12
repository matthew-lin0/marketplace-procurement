import { z } from 'zod';

/**
 * Provenance is the load-bearing idea in this schema.
 *
 * `model_prior` means "the model recalled this and nothing verified it." The
 * eval reports fabrication rate per source, and any future UI must visually
 * mark model_prior as unverified. A confidently wrong chamber-lining spec is
 * worse than a blank field.
 */
export const AttributeSource = z.enum([
  'listing_text', // stated in the listing itself
  'photo_inference', // read off an image, must carry evidence
  'spec_lookup', // from a manufacturer spec sheet, must carry a URL
  'model_prior', // model recall, nothing verified it
]);
export type AttributeSource = z.infer<typeof AttributeSource>;

export const Evidence = z.object({
  imageIndex: z.number().int().nonnegative().nullable(),
  /** Optional [x0,y0,x1,y1] in normalized 0..1 coordinates. */
  bbox: z.array(z.number()).length(4).nullable(),
  /** Verbatim quote from listing text or a spec sheet. */
  quote: z.string().nullable(),
  /** Source URL for spec_lookup attributes. */
  url: z.string().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Attribute = z.object({
  key: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  source: AttributeSource,
  evidence: Evidence.nullable(),
});
export type Attribute = z.infer<typeof Attribute>;

// --- T1: identify ----------------------------------------------------------

export const IdentifyResult = z.object({
  /** True when the model declines to guess. Abstention is a first-class,
   *  rewarded output — never an error case. */
  abstained: z.boolean(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  /** e.g. "pre-2019", "gen 2", "2014-2018". Null when unknown. */
  generation: z.string().nullable(),
  /** Family-level fallback for when exact ID isn't possible:
   *  "Rogue-style 3x3 11-gauge power rack". */
  family: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  /** Which images carried the identifying evidence. */
  evidenceImageIndices: z.array(z.number().int().nonnegative()),
});
export type IdentifyResult = z.infer<typeof IdentifyResult>;

// --- T2 / T3: attributes and inclusions ------------------------------------

export const AttributeSet = z.object({
  attributes: z.array(Attribute),
  /** Questions to ask the seller for things that could not be determined.
   *  This is the fallback path when inference fails, and it is a real
   *  product surface, not an error state. */
  questionsForSeller: z.array(z.string()),
});
export type AttributeSet = z.infer<typeof AttributeSet>;

export const InclusionKind = z.enum([
  'bundled_item', // dumbbells visible in photo 4
  'accessory', // J-cups, rotor, shelf
  'damage', // rust, tear, crack
  'wear', // scuffing, fading
  'missing_part', // absent hardware
  'modification', // repaint, aftermarket part
]);
export type InclusionKind = z.infer<typeof InclusionKind>;

export const Inclusion = z.object({
  label: z.string(),
  kind: InclusionKind,
  /** Required. A claim with no image cited is dropped at validation. */
  imageIndex: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  /** True when the listing text never mentions this. Those are the ones
   *  that matter — T3 scores exactly this subset. */
  mentionedInText: z.boolean(),
  estimatedValueUsd: z.number().nullable(),
});
export type Inclusion = z.infer<typeof Inclusion>;

export const InclusionSet = z.object({
  inclusions: z.array(Inclusion),
});
export type InclusionSet = z.infer<typeof InclusionSet>;

// --- T4: salience ----------------------------------------------------------

export const SalienceRanking = z.object({
  rankedKeys: z.array(z.string()),
  rationale: z.string(),
});
export type SalienceRanking = z.infer<typeof SalienceRanking>;

// --- T5: community sentiment ----------------------------------------------

export const SentimentKind = z.enum([
  'wear_item',
  'known_defect',
  'inspect_before_buying',
  'parts_availability',
  'replacement_cost',
  'generation_caveat',
  'praise',
]);
export type SentimentKind = z.infer<typeof SentimentKind>;

/** Actionable kinds are the ones that change a pre-purchase decision.
 *  `praise` is the explicit non-actionable case. The T5 actionability
 *  scorer is defined against this set. */
export const ACTIONABLE_SENTIMENT_KINDS: ReadonlySet<SentimentKind> = new Set([
  'wear_item',
  'known_defect',
  'inspect_before_buying',
  'parts_availability',
  'replacement_cost',
  'generation_caveat',
]);

export const Citation = z.object({
  url: z.string(),
  /** Verbatim. No quote, drop the finding. This is what makes the
   *  attribution scorer mechanical rather than a matter of opinion. */
  quote: z.string(),
});
export type Citation = z.infer<typeof Citation>;

export const SentimentFinding = z.object({
  id: z.string(),
  claim: z.string(),
  kind: SentimentKind,
  /** Explicit "unknown" is required rather than omitted — advice about a
   *  2014 unit routinely does not apply to the 2023 revision, and threads
   *  rarely date themselves. */
  appliesToGeneration: z.string(),
  citations: z.array(Citation).min(1),
  consensusStrength: z.enum(['single_report', 'several', 'widespread']),
});
export type SentimentFinding = z.infer<typeof SentimentFinding>;

export const SentimentResult = z.object({
  findings: z.array(SentimentFinding),
  /** The ID this was conditioned on. Must be displayed to the user so they
   *  can reject the premise — sentiment for a misidentified model launders
   *  the error inside credible-looking owner testimony. */
  conditionedOnModel: z.string(),
});
export type SentimentResult = z.infer<typeof SentimentResult>;

// --- T6: negotiation -------------------------------------------------------

export const FairValueBasis = z.enum([
  'ebay_sold', // real transaction prices; preferred
  'corpus_asking', // asking prices; biased high, see docs
  'msrp_depreciated', // retail price minus visible-condition estimate; last
  // resort — no market signal at all, wide uncertainty by construction
  'insufficient_data', // fewer than MIN_COMPS and no usable retail reference.
  // A valid, often correct output.
]);
export type FairValueBasis = z.infer<typeof FairValueBasis>;

/** T6 fallback pricing input: a real, sourced retail/MSRP price, looked up
 *  only when comps are too thin to price from directly. found=false (rather
 *  than a recalled number) is required whenever no citable source exists. */
export const MsrpLookup = z.object({
  found: z.boolean(),
  msrpUsd: z.number().nullable(),
  url: z.string().nullable(),
  asOf: z.string().nullable(),
});
export type MsrpLookup = z.infer<typeof MsrpLookup>;

export const Comp = z.object({
  id: z.string(),
  source: z.enum(['ebay_sold', 'corpus']),
  url: z.string().nullable(),
  model: z.string(),
  isExactModel: z.boolean(),
  conditionTier: z.enum(['parts', 'rough', 'used', 'good', 'excellent', 'new']),
  priceUsd: z.number(),
  /** Miles from the buyer. Null for shippable/online comps. A cross-country
   *  comp is not a comp for something that needs a U-Haul. */
  distanceMiles: z.number().nullable(),
  observedAt: z.string(),
});
export type Comp = z.infer<typeof Comp>;

export const Lever = z.object({
  claim: z.string(),
  /** Must resolve to a real T2/T3/T5 finding id. Enforced at validation
   *  time, not judged later — this makes lever grounding mechanical. */
  sourceFindingId: z.string(),
  estimatedValueUsd: z.number().nullable(),
});
export type Lever = z.infer<typeof Lever>;

export const SellerMotivation = z.object({
  daysListed: z.number().nullable(),
  priceDrops: z.number().nullable(),
  relistCount: z.number().nullable(),
  confidence: z.number().min(0).max(1),
});
export type SellerMotivation = z.infer<typeof SellerMotivation>;

export const NegotiationBrief = z.object({
  fairValue: z.object({
    low: z.number().nullable(),
    point: z.number().nullable(),
    high: z.number().nullable(),
    basis: FairValueBasis,
  }),
  /** Asking price minus fair value point. Signed: positive = overpriced. */
  askingPremiumUsd: z.number().nullable(),
  levers: z.array(Lever),
  walkAwayUsd: z.number().nullable(),
  batna: z
    .object({
      listingId: z.string(),
      allInCostUsd: z.number(),
      note: z.string(),
    })
    .nullable(),
  sellerMotivation: SellerMotivation,
  openingOfferUsd: z.number().nullable(),
  /** What to resolve before offering at all. */
  unknowns: z.array(z.string()),
});
export type NegotiationBrief = z.infer<typeof NegotiationBrief>;

// --- Listing / capture -----------------------------------------------------

export const Marketplace = z.enum(['facebook', 'craigslist', 'ebay', 'other']);
export type Marketplace = z.infer<typeof Marketplace>;

export const CategoryKey = z.enum([
  'home_gym',
  'bicycle',
  'power_tool',
  'sofa',
  'laptop',
  'co2_incubator',
]);
export type CategoryKey = z.infer<typeof CategoryKey>;

/**
 * Split assignment.
 *
 * `dev` is where prompts and taxonomy get iterated. `holdout` is never looked
 * at until the final run. The holdout exists because a human editing prompts
 * against the same 30 listings overfits them just as reliably as gradient
 * descent would — there is no model training anywhere in this project.
 */
export const Split = z.enum(['dev', 'holdout']);
export type Split = z.infer<typeof Split>;

export const CapturedImage = z.object({
  index: z.number().int().nonnegative(),
  /** Path relative to the listing's snapshot dir. Images are stored to disk
   *  immediately — listings get deleted within days and hotlinked CDN URLs
   *  expire. A dataset of dead links is worthless. */
  path: z.string(),
  sourceUrl: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  sha256: z.string(),
});
export type CapturedImage = z.infer<typeof CapturedImage>;

export const ListingSnapshot = z.object({
  id: z.string(),
  marketplace: Marketplace,
  category: CategoryKey,
  split: Split,
  sourceUrl: z.string(),
  capturedAt: z.string(),
  title: z.string(),
  description: z.string(),
  priceUsd: z.number().nullable(),
  locationText: z.string().nullable(),
  /** Rendered page text, minus nav chrome. Kept because normalization is the
   *  thing under test and must be re-runnable against the original bytes. */
  renderedText: z.string(),
  jsonLd: z.array(z.unknown()),
  images: z.array(CapturedImage),
  /** Present only for model-stated listings. This is the ground truth we
   *  ablate away and score against. */
  statedModel: z.string().nullable(),
  /** Every string that must be scrubbed before the extractor sees anything:
   *  model name plus known aliases and paraphrases. */
  ablationStrings: z.array(z.string()),
  /** Longitudinal re-observations. Free from passive indexing, and the
   *  source of the T6 timing signals. */
  observations: z.array(
    z.object({
      at: z.string(),
      priceUsd: z.number().nullable(),
      stillListed: z.boolean(),
    }),
  ),
});
export type ListingSnapshot = z.infer<typeof ListingSnapshot>;

// --- Taxonomy --------------------------------------------------------------

export const TaxonomyAttribute = z.object({
  key: z.string(),
  mattersBecause: z.string(),
  /** The field doing the real work: the difference between a model that
   *  guesses and a model that knows where to look. The held-out incubator
   *  category deliberately has no taxonomy file, to measure what this
   *  field is worth. */
  visualTells: z.string().nullable(),
  askSeller: z.string(),
  decisionWeight: z.enum(['low', 'medium', 'high']),
});
export type TaxonomyAttribute = z.infer<typeof TaxonomyAttribute>;

export const CategoryTaxonomy = z.object({
  category: CategoryKey,
  communities: z.array(z.string()),
  attributes: z.array(TaxonomyAttribute),
});
export type CategoryTaxonomy = z.infer<typeof CategoryTaxonomy>;

// --- Labels ----------------------------------------------------------------

export const ListingLabels = z.object({
  listingId: z.string(),
  /** Hand-labeled true model, for listings where it isn't ablation-derived. */
  trueModel: z.string().nullable(),
  trueGeneration: z.string().nullable(),
  /** True specs, for scoring T2 fabrication. Key -> value. */
  trueAttributes: z.record(z.string(), z.string()),
  /** Things visible in photos that the text does not mention. T3 ground truth. */
  trueUnstatedInclusions: z.array(
    z.object({ label: z.string(), kind: InclusionKind, imageIndex: z.number() }),
  ),
  /** Expert top-5 for this category, rank-ordered. T4 ground truth. */
  expertTopAttributes: z.array(z.string()),
  /** Hand-supplied per-listing costs — inputs, not things we compute. Keeps
   *  the eval measuring reasoning quality instead of retrieval plumbing. */
  logisticsCostUsd: z.number().nullable(),
  refurbCostUsd: z.number().nullable(),
  /** Real sold-price comps, for T6 fair-value calibration. */
  comps: z.array(Comp),
});
export type ListingLabels = z.infer<typeof ListingLabels>;

// --- Pipeline output -------------------------------------------------------

export const Tier = z.enum(['triage', 'full']);
export type Tier = z.infer<typeof Tier>;

export const UsageRecord = z.object({
  stage: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  /** Raw cost reported by the backend. For the CLI backend this includes
   *  Claude Code's own ~25k-token system prompt, which is harness overhead
   *  and must be baseline-subtracted before it means anything. */
  rawCostUsd: z.number(),
  wallClockMs: z.number(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

export const ExtractionResult = z.object({
  listingId: z.string(),
  tier: Tier,
  identify: IdentifyResult.nullable(),
  attributes: AttributeSet.nullable(),
  inclusions: InclusionSet.nullable(),
  salience: SalienceRanking.nullable(),
  sentiment: SentimentResult.nullable(),
  negotiation: NegotiationBrief.nullable(),
  usage: z.array(UsageRecord),
  /** Stages that were skipped and why — e.g. T5 gated off by low T1
   *  confidence. Skips are expected behavior, not failures. */
  skipped: z.array(z.object({ stage: z.string(), reason: z.string() })),
  errors: z.array(z.object({ stage: z.string(), message: z.string() })),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;
