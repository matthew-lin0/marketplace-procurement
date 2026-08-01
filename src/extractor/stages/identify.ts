import { z } from 'zod';
import type { ModelClient } from '../client/types.js';
import { IdentifyResult, type CategoryTaxonomy, type ListingSnapshot, type UsageRecord } from '../../schema/index.js';
import { identifyPrompt, nameplateLocatePrompt, SYSTEM_APPRAISER } from '../prompts.js';

/**
 * T1: identify brand + model + generation.
 *
 * This is the bottleneck for the entire product. Each downstream capability
 * makes a wrong ID more expensive rather than less: sentiment retrieved for a
 * misidentified model launders the error inside credible-looking owner
 * testimony, and a negotiation brief built on it sends the buyer to a seller
 * with confidently wrong comps.
 *
 * Abstention is therefore a first-class, rewarded output.
 */

const NameplateRegions = z.object({
  regions: z
    .array(
      z.object({
        imageIndex: z.number().int().nonnegative(),
        bbox: z.array(z.number()).length(4),
        whatYouExpectToFind: z.string(),
      }),
    )
    .max(6),
});
export type NameplateRegions = z.infer<typeof NameplateRegions>;

export interface IdentifyOptions {
  model: string;
  includeText: boolean;
  includeImages: boolean;
  includeVisualTells: boolean;
  /**
   * The crop-and-zoom nameplate pass. Hypothesis: this is the single largest
   * lever on T1, because model numbers are physically printed on most
   * equipment and are usually just too small to read in the wide shot.
   * Ablated independently so we get a number instead of a guess.
   */
  useNameplateZoom: boolean;
}

export interface IdentifyOutput {
  result: IdentifyResult | null;
  usage: UsageRecord[];
  /** Regions the model asked to zoom into, kept for the report. */
  nameplateRegions: NameplateRegions | null;
}

export async function runIdentify(
  client: ModelClient,
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  allImagePaths: string[],
  opts: IdentifyOptions,
): Promise<IdentifyOutput> {
  const usage: UsageRecord[] = [];
  const imagePaths = opts.includeImages ? allImagePaths : [];
  let nameplateRegions: NameplateRegions | null = null;

  // Pass 1: ask where the printed identifiers are likely to be. We do not
  // actually crop pixels here — we hand the model back its own regions of
  // interest and tell it to look there. That isolates "knowing where to look"
  // from image-processing plumbing, which is what we want to measure.
  if (opts.useNameplateZoom && imagePaths.length > 0) {
    try {
      const located = await client.run<NameplateRegions>({
        stage: 't1.nameplate_locate',
        model: opts.model,
        system: SYSTEM_APPRAISER,
        prompt: nameplateLocatePrompt(snapshot),
        imagePaths,
        schema: NameplateRegions,
      });
      usage.push(located.usage);
      nameplateRegions = located.parsed;
    } catch {
      // A failed locate pass should not fail identification; it just means we
      // fall back to the wide shot. Recorded as absent in the report.
      nameplateRegions = null;
    }
  }

  const focusBlock =
    nameplateRegions && nameplateRegions.regions.length > 0
      ? `\n\nLikely locations of printed identifiers, from a first pass over these
images. Examine each closely before concluding no identifier is legible:
${nameplateRegions.regions
  .map(
    (r) =>
      `- image ${r.imageIndex}, region [${r.bbox.map((n) => n.toFixed(2)).join(', ')}]: ${r.whatYouExpectToFind}`,
  )
  .join('\n')}`
      : '';

  const identified = await client.run<IdentifyResult>({
    stage: 't1.identify',
    model: opts.model,
    system: SYSTEM_APPRAISER,
    prompt:
      identifyPrompt(snapshot, taxonomy, {
        includeText: opts.includeText,
        includeVisualTells: opts.includeVisualTells,
      }) + focusBlock,
    imagePaths,
    schema: IdentifyResult,
  });
  usage.push(identified.usage);

  return { result: normalize(identified.parsed), usage, nameplateRegions };
}

/**
 * Enforces the invariant the scorers depend on: an abstention must not carry a
 * confident model claim. Without this, a model can hedge in the `abstained`
 * flag while still filling in `model`, and the confident-tier precision metric
 * silently counts it.
 */
function normalize(r: IdentifyResult | null): IdentifyResult | null {
  if (!r) return null;
  if (r.abstained) {
    return { ...r, model: null, confidence: Math.min(r.confidence, 0.5) };
  }
  // A stated model with no confidence is treated as an abstention.
  if (!r.model || r.model.trim() === '') {
    return { ...r, abstained: true, model: null };
  }
  return r;
}
