import { MODELS } from '../config.js';
import { ablate, verifyAblation, verifyImagePaths } from '../capture/ablate.js';
import { imagePaths, loadLabels } from '../capture/store.js';
import {
  type ExtractionResult,
  type ListingSnapshot,
  type Tier,
  type UsageRecord,
} from '../schema/index.js';
import { loadTaxonomy } from '../taxonomy/index.js';
import type { ModelClient } from './client/types.js';
import { runAttributes, runInclusions, runSalience } from './stages/attributes.js';
import { runIdentify } from './stages/identify.js';
import { runNegotiate } from './stages/negotiate.js';
import { runSentiment } from './stages/sentiment.js';

/**
 * The staged extractor. Each stage is independently ablatable, because the
 * point of the eval is to find out which design decisions actually matter
 * rather than to ship a black box that works for unclear reasons.
 *
 * Two tiers exist because passive corpus indexing means processing every
 * listing browsed, not just the interesting ones:
 *   - triage: cheap, small model, text + first image, category and rough ID
 *   - full:   everything, on explicit compare only
 */

export interface AblationConfig {
  name: string;
  includeText: boolean;
  includeImages: boolean;
  /** false = first image only. Tests whether the gallery is worth the tokens. */
  allImages: boolean;
  useNameplateZoom: boolean;
  useSpecLookup: boolean;
  /** The field hypothesized to be the difference between a model that guesses
   *  and a model that knows where to look. */
  includeVisualTells: boolean;
  useCommunitySeeding: boolean;
  compSources: 'corpus_only' | 'ebay_only' | 'both';
  includeSentimentLevers: boolean;
  /** Overrides MODELS.full for the model-tier ablation. */
  modelOverride?: string;
}

export const DEFAULT_ABLATION: AblationConfig = {
  name: 'full',
  includeText: true,
  includeImages: true,
  allImages: true,
  useNameplateZoom: true,
  useSpecLookup: true,
  includeVisualTells: true,
  useCommunitySeeding: true,
  compSources: 'both',
  includeSentimentLevers: true,
};

/** Each isolates exactly one design decision. Run on the dev split only. */
export const ABLATIONS: AblationConfig[] = [
  DEFAULT_ABLATION,
  { ...DEFAULT_ABLATION, name: 'text_only', includeImages: false },
  { ...DEFAULT_ABLATION, name: 'images_only', includeText: false },
  { ...DEFAULT_ABLATION, name: 'first_image_only', allImages: false },
  { ...DEFAULT_ABLATION, name: 'no_nameplate_zoom', useNameplateZoom: false },
  { ...DEFAULT_ABLATION, name: 'no_spec_lookup', useSpecLookup: false },
  { ...DEFAULT_ABLATION, name: 'no_visual_tells', includeVisualTells: false },
  { ...DEFAULT_ABLATION, name: 'no_community_seeding', useCommunitySeeding: false },
  { ...DEFAULT_ABLATION, name: 'comps_corpus_only', compSources: 'corpus_only' },
  { ...DEFAULT_ABLATION, name: 'comps_ebay_only', compSources: 'ebay_only' },
  { ...DEFAULT_ABLATION, name: 'no_sentiment_levers', includeSentimentLevers: false },
  { ...DEFAULT_ABLATION, name: 'model_sonnet', modelOverride: MODELS.judge },
  { ...DEFAULT_ABLATION, name: 'model_haiku', modelOverride: MODELS.triage },
];

export interface ExtractOptions {
  tier: Tier;
  ablation: AblationConfig;
  /** Skip the T5 web-research cache. Off by default; the cache is the one
   *  part of the system that compounds. */
  bypassSentimentCache?: boolean;
}

export class AblationLeakError extends Error {
  constructor(listingId: string, details: string) {
    super(
      `Ablation leak in ${listingId}: the model string survived scrubbing, which would turn T1 into an open-book test. ${details}`,
    );
    this.name = 'AblationLeakError';
  }
}

export async function extract(
  client: ModelClient,
  rawSnapshot: ListingSnapshot,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const { ablation, tier } = opts;

  // Ablate FIRST, then verify. Everything downstream sees only the ablated
  // snapshot — a leak here silently inflates the headline number.
  const snapshot = ablate(rawSnapshot);

  // Image paths must resolve from the RAW snapshot — the files on disk keep
  // their original names — so they need their own leak check: a descriptive
  // filename can leak the model string even when every text field is clean.
  const allPaths = imagePaths(rawSnapshot);
  const leaks = [
    ...verifyAblation(snapshot),
    ...verifyImagePaths(allPaths, rawSnapshot.statedModel, rawSnapshot.ablationStrings),
  ];
  if (leaks.length > 0) {
    throw new AblationLeakError(
      rawSnapshot.id,
      leaks.map((l) => `${l.field}: "${l.matched}"`).join('; '),
    );
  }

  const usage: UsageRecord[] = [];
  const skipped: { stage: string; reason: string }[] = [];
  const errors: { stage: string; message: string }[] = [];

  const taxonomy = await loadTaxonomy(snapshot.category);
  const labels = await loadLabels(snapshot.id);

  const paths = ablation.includeImages
    ? ablation.allImages
      ? allPaths
      : allPaths.slice(0, 1)
    : [];

  const model =
    ablation.modelOverride ?? (tier === 'triage' ? MODELS.triage : MODELS.full);

  const result: ExtractionResult = {
    listingId: snapshot.id,
    tier,
    identify: null,
    attributes: null,
    inclusions: null,
    salience: null,
    sentiment: null,
    negotiation: null,
    usage,
    skipped,
    errors,
  };

  // --- T1 -----------------------------------------------------------------
  try {
    const out = await runIdentify(client, snapshot, taxonomy, paths, {
      model,
      includeText: ablation.includeText,
      includeImages: ablation.includeImages,
      includeVisualTells: ablation.includeVisualTells,
      // Triage is a cheap category-and-rough-ID pass; the zoom pass is a
      // full-tier cost.
      useNameplateZoom: ablation.useNameplateZoom && tier === 'full',
    });
    result.identify = out.result;
    usage.push(...out.usage);
  } catch (err) {
    errors.push({ stage: 't1.identify', message: (err as Error).message });
  }

  // Triage stops here. It exists to answer "what is this, roughly" cheaply
  // enough to run on every listing the user browses.
  if (tier === 'triage') {
    skipped.push({ stage: 'full_pipeline', reason: 'triage tier: T2-T6 run on explicit compare only' });
    return result;
  }

  // --- T2 -----------------------------------------------------------------
  try {
    const out = await runAttributes(client, snapshot, taxonomy, result.identify, paths, {
      model,
      includeVisualTells: ablation.includeVisualTells,
      useSpecLookup: ablation.useSpecLookup,
    });
    result.attributes = out.attributes;
    usage.push(...out.usage);
    skipped.push(...out.skipped);
  } catch (err) {
    errors.push({ stage: 't2.attributes', message: (err as Error).message });
  }

  // --- T3 -----------------------------------------------------------------
  if (paths.length > 0) {
    try {
      const out = await runInclusions(client, snapshot, paths, model);
      result.inclusions = out.inclusions;
      usage.push(...out.usage);
      if (out.dropped > 0) {
        skipped.push({
          stage: 't3.inclusions',
          reason: `dropped ${out.dropped} inclusion(s) citing a nonexistent image index`,
        });
      }
    } catch (err) {
      errors.push({ stage: 't3.inclusions', message: (err as Error).message });
    }
  } else {
    skipped.push({ stage: 't3.inclusions', reason: 'no images in this ablation' });
  }

  // --- T4 -----------------------------------------------------------------
  try {
    const out = await runSalience(
      client,
      snapshot,
      taxonomy,
      result.attributes?.attributes.map((a) => a.key) ?? [],
      model,
    );
    result.salience = out.salience;
    usage.push(...out.usage);
  } catch (err) {
    errors.push({ stage: 't4.salience', message: (err as Error).message });
  }

  // --- T5 -----------------------------------------------------------------
  try {
    const out = await runSentiment(client, taxonomy, result.identify, {
      model,
      useCommunitySeeding: ablation.useCommunitySeeding,
      useCache: !opts.bypassSentimentCache,
    });
    result.sentiment = out.sentiment;
    usage.push(...out.usage);
    skipped.push(...out.skipped);
  } catch (err) {
    errors.push({ stage: 't5.sentiment', message: (err as Error).message });
  }

  // --- T6 -----------------------------------------------------------------
  try {
    const out = await runNegotiate(
      client,
      snapshot,
      labels,
      result.identify,
      result.attributes,
      result.inclusions,
      result.sentiment,
      {
        model,
        compSources: ablation.compSources,
        includeSentimentLevers: ablation.includeSentimentLevers,
      },
    );
    result.negotiation = out.brief;
    usage.push(...out.usage);
    skipped.push(...out.skipped);
    if (out.droppedLevers > 0) {
      // Should be zero by construction. Nonzero means the validator is broken.
      skipped.push({
        stage: 't6.lever_validation',
        reason: `dropped ${out.droppedLevers} lever(s) with unresolvable sourceFindingId`,
      });
    }
  } catch (err) {
    errors.push({ stage: 't6.negotiate', message: (err as Error).message });
  }

  return result;
}
