import type { ModelClient } from '../client/types.js';
import {
  AttributeSet,
  InclusionSet,
  SalienceRanking,
  type Attribute,
  type CategoryTaxonomy,
  type IdentifyResult,
  type ListingSnapshot,
  type UsageRecord,
} from '../../schema/index.js';
import { CONFIDENT_TIER_THRESHOLD } from '../../config.js';
import {
  inclusionsPrompt,
  saliencePrompt,
  specLookupPrompt,
  SYSTEM_APPRAISER,
  visualAttributePrompt,
} from '../prompts.js';

/**
 * T2 (recover unstated attributes), T3 (detect unmentioned inclusions and
 * condition), T4 (rank salience).
 *
 * T2 has two paths and they are not equivalent:
 *   - spec_lookup, gated on a confident T1, grounds attributes in a real
 *     manufacturer source with a URL. Auditable.
 *   - photo_inference, the fallback, requires a per-claim image citation.
 *
 * The eval reports fabrication rate per source precisely so we can see whether
 * grounding is doing what we think it is.
 */

export interface AttributeOptions {
  model: string;
  includeVisualTells: boolean;
  /** Ablation: does spec-lookup grounding actually reduce fabrication? */
  useSpecLookup: boolean;
}

export interface AttributeOutput {
  attributes: AttributeSet | null;
  usage: UsageRecord[];
  skipped: { stage: string; reason: string }[];
}

export async function runAttributes(
  client: ModelClient,
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  identify: IdentifyResult | null,
  imagePaths: string[],
  opts: AttributeOptions,
): Promise<AttributeOutput> {
  const usage: UsageRecord[] = [];
  const skipped: { stage: string; reason: string }[] = [];
  const collected: Attribute[] = [];
  const questions: string[] = [];

  const idConfident =
    identify !== null &&
    !identify.abstained &&
    identify.confidence >= CONFIDENT_TIER_THRESHOLD &&
    identify.brand !== null &&
    identify.model !== null;

  // Path A: grounded spec lookup. Only when we actually know what this is.
  if (opts.useSpecLookup) {
    if (idConfident) {
      try {
        const looked = await client.run<AttributeSet>({
          stage: 't2.spec_lookup',
          model: opts.model,
          system: SYSTEM_APPRAISER,
          prompt: specLookupPrompt(
            identify.brand!,
            identify.model!,
            identify.generation,
            taxonomy,
          ),
          schema: AttributeSet,
          allowWebSearch: true,
        });
        usage.push(looked.usage);
        if (looked.parsed) {
          collected.push(...looked.parsed.attributes);
          questions.push(...looked.parsed.questionsForSeller);
        }
      } catch (err) {
        skipped.push({
          stage: 't2.spec_lookup',
          reason: `lookup failed: ${(err as Error).message}`,
        });
      }
    } else {
      skipped.push({
        stage: 't2.spec_lookup',
        reason: `T1 not confident (abstained=${identify?.abstained ?? 'null'}, conf=${
          identify?.confidence ?? 0
        } < ${CONFIDENT_TIER_THRESHOLD}); spec lookup for a guessed model would produce authoritative-looking wrong specs`,
      });
    }
  }

  // Path B: visual inference. Always runs — it is the fallback when ID fails,
  // and it also catches per-unit facts a spec sheet can never contain.
  const visual = await client.run<AttributeSet>({
    stage: 't2.visual',
    model: opts.model,
    system: SYSTEM_APPRAISER,
    prompt: visualAttributePrompt(snapshot, taxonomy, {
      includeVisualTells: opts.includeVisualTells,
    }),
    imagePaths,
    schema: AttributeSet,
  });
  usage.push(visual.usage);
  if (visual.parsed) {
    collected.push(...visual.parsed.attributes);
    questions.push(...visual.parsed.questionsForSeller);
  }

  const kept = collected.filter(isEvidenced);
  const droppedCount = collected.length - kept.length;
  if (droppedCount > 0) {
    skipped.push({
      stage: 't2.evidence_filter',
      reason: `dropped ${droppedCount} attribute(s) with no usable evidence`,
    });
  }

  return {
    attributes: {
      attributes: dedupeAttributes(kept),
      questionsForSeller: [...new Set(questions)],
    },
    usage,
    skipped,
  };
}

/**
 * A photo_inference claim with no image cited is dropped, and a spec_lookup
 * claim with no URL is dropped. This is enforced mechanically rather than
 * judged later, which is what makes the grounding metric trustworthy.
 *
 * model_prior claims survive on purpose: we want to measure how often the
 * model reaches for unverified recall, not to hide it.
 */
function isEvidenced(a: Attribute): boolean {
  switch (a.source) {
    case 'photo_inference':
      return a.evidence?.imageIndex !== null && a.evidence?.imageIndex !== undefined;
    case 'spec_lookup':
      return Boolean(a.evidence?.url);
    case 'listing_text':
      return Boolean(a.evidence?.quote);
    case 'model_prior':
      return true;
  }
}

/** Same key from two paths: prefer the better-grounded source, then the higher
 *  confidence. */
const SOURCE_RANK: Record<Attribute['source'], number> = {
  spec_lookup: 3,
  listing_text: 2,
  photo_inference: 1,
  model_prior: 0,
};

function dedupeAttributes(attrs: Attribute[]): Attribute[] {
  const best = new Map<string, Attribute>();
  for (const a of attrs) {
    const prev = best.get(a.key);
    if (!prev) {
      best.set(a.key, a);
      continue;
    }
    const better =
      SOURCE_RANK[a.source] > SOURCE_RANK[prev.source] ||
      (SOURCE_RANK[a.source] === SOURCE_RANK[prev.source] && a.confidence > prev.confidence);
    if (better) best.set(a.key, a);
  }
  return [...best.values()];
}

// --- T3 --------------------------------------------------------------------

export async function runInclusions(
  client: ModelClient,
  snapshot: ListingSnapshot,
  imagePaths: string[],
  model: string,
): Promise<{ inclusions: InclusionSet | null; usage: UsageRecord[]; dropped: number }> {
  const res = await client.run<InclusionSet>({
    stage: 't3.inclusions',
    model,
    system: SYSTEM_APPRAISER,
    prompt: inclusionsPrompt(snapshot),
    imagePaths,
    schema: InclusionSet,
  });

  if (!res.parsed) return { inclusions: null, usage: [res.usage], dropped: 0 };

  // An inclusion citing an image that does not exist is a fabrication with a
  // plausible-looking citation, which is the exact failure mode the evidence
  // requirement is meant to catch.
  const valid = res.parsed.inclusions.filter(
    (i) => i.imageIndex >= 0 && i.imageIndex < imagePaths.length,
  );

  return {
    inclusions: { inclusions: valid },
    usage: [res.usage],
    dropped: res.parsed.inclusions.length - valid.length,
  };
}

// --- T4 --------------------------------------------------------------------

export async function runSalience(
  client: ModelClient,
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  attributeKeys: string[],
  model: string,
): Promise<{ salience: SalienceRanking | null; usage: UsageRecord[] }> {
  const res = await client.run<SalienceRanking>({
    stage: 't4.salience',
    model,
    system: SYSTEM_APPRAISER,
    prompt: saliencePrompt(snapshot, taxonomy, attributeKeys),
    schema: SalienceRanking,
  });
  return { salience: res.parsed, usage: [res.usage] };
}
