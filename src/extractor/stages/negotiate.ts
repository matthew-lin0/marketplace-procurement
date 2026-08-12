import { CONFIDENT_TIER_THRESHOLD, MAX_COMP_DISTANCE_MILES, MIN_COMPS } from '../../config.js';
import {
  MsrpLookup,
  NegotiationBrief,
  type Comp,
  type IdentifyResult,
  type ListingLabels,
  type ListingSnapshot,
  type SentimentResult,
  type AttributeSet,
  type InclusionSet,
  type UsageRecord,
} from '../../schema/index.js';
import { msrpLookupPrompt, negotiationPrompt, SYSTEM_APPRAISER } from '../prompts.js';
import type { ModelClient } from '../client/types.js';

/**
 * T6: assemble a negotiation position.
 *
 * The central methodological risk here is asking-versus-sold. The corpus holds
 * ASKING prices. Asking prices sit above transaction prices, and stale listings
 * are stale precisely because they are overpriced — so a naive corpus mean is
 * biased high twice over. Anchoring a buyer's offer on it advises them to
 * overpay while looking rigorous.
 *
 * Mitigations, in priority order:
 *   1. eBay sold prices where the category has them (real transactions).
 *   2. Corpus TIMING signals, which passive indexing gives away free: days
 *      listed, price-drop history, relist count. "Relisted twice, down 15% over
 *      five weeks" is stronger evidence than any comp average, and is
 *      unavailable to anyone without a longitudinal corpus.
 *   3. insufficient_data and no point estimate.
 */

export interface NegotiateOptions {
  model: string;
  /** Ablation: corpus asking comps only vs eBay sold vs both. */
  compSources: 'corpus_only' | 'ebay_only' | 'both';
  /** Ablation: are T5 findings available as lever sources? */
  includeSentimentLevers: boolean;
}

export interface NegotiateOutput {
  brief: NegotiationBrief | null;
  usage: UsageRecord[];
  skipped: { stage: string; reason: string }[];
  /** Levers dropped for referencing a nonexistent finding. Should be zero by
   *  construction; nonzero means the validator is broken. */
  droppedLevers: number;
  validCompCount: number;
}

export async function runNegotiate(
  client: ModelClient,
  snapshot: ListingSnapshot,
  labels: ListingLabels | null,
  identify: IdentifyResult | null,
  attributes: AttributeSet | null,
  inclusions: InclusionSet | null,
  sentiment: SentimentResult | null,
  opts: NegotiateOptions,
): Promise<NegotiateOutput> {
  if (
    !identify ||
    identify.abstained ||
    identify.confidence < CONFIDENT_TIER_THRESHOLD
  ) {
    return {
      brief: null,
      usage: [],
      droppedLevers: 0,
      validCompCount: 0,
      skipped: [
        {
          stage: 't6.negotiate',
          reason: `T1 not confident; a brief built on a guessed model sends the buyer to a seller with confidently wrong comps`,
        },
      ],
    };
  }

  const comps = selectComps(labels?.comps ?? [], opts.compSources);
  const findings = buildFindingIndex(attributes, inclusions, sentiment, opts);
  const usage: UsageRecord[] = [];

  // Comps are the real pricing basis. Only when they're too thin to price from
  // do we spend a call looking up a retail/MSRP reference — and even then,
  // only a real, sourced number is usable; a recalled price is worse than none.
  let msrp: MsrpLookup | null = null;
  if (comps.length < MIN_COMPS && identify.brand && identify.model) {
    const msrpRes = await client.run<MsrpLookup>({
      stage: 't6.msrp_lookup',
      model: opts.model,
      system: SYSTEM_APPRAISER,
      prompt: msrpLookupPrompt(identify.brand, identify.model, identify.generation),
      schema: MsrpLookup,
      allowWebSearch: true,
    });
    usage.push(msrpRes.usage);
    if (msrpRes.parsed?.found && msrpRes.parsed.msrpUsd !== null && msrpRes.parsed.url) {
      msrp = msrpRes.parsed;
    }
  }

  const res = await client.run<NegotiationBrief>({
    stage: 't6.negotiate',
    model: opts.model,
    system: SYSTEM_APPRAISER,
    prompt: negotiationPrompt(
      snapshot,
      renderComps(comps),
      renderFindings(findings),
      renderCosts(labels),
      renderTiming(snapshot),
      renderMsrp(msrp),
    ),
    schema: NegotiationBrief,
  });
  usage.push(res.usage);

  if (!res.parsed) {
    return { brief: null, usage, skipped: [], droppedLevers: 0, validCompCount: comps.length };
  }

  const validIds = new Set(findings.map((f) => f.id));
  const keptLevers = res.parsed.levers.filter((l) => validIds.has(l.sourceFindingId));
  const droppedLevers = res.parsed.levers.length - keptLevers.length;

  // Enforce the abstention rule in code rather than trusting the prompt. Thin
  // data must not produce a point estimate no matter what the model returns —
  // and an msrp_depreciated estimate is only trusted if a real lookup actually
  // backed it; the model claiming that basis without one doesn't count.
  const fairValue =
    comps.length >= MIN_COMPS
      ? res.parsed.fairValue
      : msrp && res.parsed.fairValue.basis === 'msrp_depreciated' && res.parsed.fairValue.low !== null
        ? res.parsed.fairValue
        : { low: null, point: null, high: null, basis: 'insufficient_data' as const };

  const askingPremium =
    fairValue.point !== null && snapshot.priceUsd !== null
      ? snapshot.priceUsd - fairValue.point
      : null;

  return {
    brief: {
      ...res.parsed,
      fairValue,
      askingPremiumUsd: askingPremium,
      levers: keptLevers,
      // A walk-away derived from a null fair value is meaningless.
      walkAwayUsd: fairValue.low === null ? null : res.parsed.walkAwayUsd,
      openingOfferUsd: fairValue.point === null ? null : res.parsed.openingOfferUsd,
    },
    usage,
    skipped: [],
    droppedLevers,
    validCompCount: comps.length,
  };
}

/** A cross-country comp is not a comp for something that needs a U-Haul. */
function selectComps(all: Comp[], sources: NegotiateOptions['compSources']): Comp[] {
  return all.filter((c) => {
    if (sources === 'corpus_only' && c.source !== 'corpus') return false;
    if (sources === 'ebay_only' && c.source !== 'ebay_sold') return false;
    if (c.distanceMiles !== null && c.distanceMiles > MAX_COMP_DISTANCE_MILES) return false;
    return true;
  });
}

interface FindingRef {
  id: string;
  text: string;
  origin: 'T2' | 'T3' | 'T5';
}

/**
 * Every lever must trace to one of these ids. Building the index here — rather
 * than asking the model to invent ids — is what makes the grounding check
 * mechanical instead of a matter of opinion.
 */
function buildFindingIndex(
  attributes: AttributeSet | null,
  inclusions: InclusionSet | null,
  sentiment: SentimentResult | null,
  opts: NegotiateOptions,
): FindingRef[] {
  const out: FindingRef[] = [];

  attributes?.attributes.forEach((a, i) => {
    out.push({
      id: `t2-${i}`,
      origin: 'T2',
      text: `${a.key} = ${a.value} (source: ${a.source}, confidence ${a.confidence.toFixed(2)})`,
    });
  });

  inclusions?.inclusions.forEach((inc, i) => {
    out.push({
      id: `t3-${i}`,
      origin: 'T3',
      text: `${inc.kind}: ${inc.label} — visible in image ${inc.imageIndex}${
        inc.mentionedInText ? '' : ', NOT mentioned in listing text'
      }${inc.estimatedValueUsd !== null ? `, est. $${inc.estimatedValueUsd}` : ''}`,
    });
  });

  if (opts.includeSentimentLevers) {
    sentiment?.findings.forEach((f) => {
      out.push({
        id: f.id,
        origin: 'T5',
        text: `${f.kind}: ${f.claim} (applies to: ${f.appliesToGeneration}, consensus: ${f.consensusStrength})`,
      });
    });
  }

  return out;
}

function renderFindings(findings: FindingRef[]): string {
  if (findings.length === 0) {
    return '<findings>\n(none available — you have no grounded levers, so return an empty levers array)\n</findings>';
  }
  return `<findings>
Each lever you propose MUST cite one of these ids in sourceFindingId.
${findings.map((f) => `[${f.id}] (${f.origin}) ${f.text}`).join('\n')}
</findings>`;
}

function renderComps(comps: Comp[]): string {
  if (comps.length === 0) {
    return `<comps>\n(none provided — set basis="insufficient_data" and leave the fair value range null)\n</comps>`;
  }
  const sold = comps.filter((c) => c.source === 'ebay_sold').length;
  return `<comps>
${comps.length} comparable(s), of which ${sold} are real SOLD prices and ${
    comps.length - sold
  } are asking prices.
${comps
  .map(
    (c) =>
      `- [${c.source}] ${c.model}${c.isExactModel ? '' : ' (near-model)'}, condition ${
        c.conditionTier
      }, $${c.priceUsd}${
        c.distanceMiles !== null ? `, ${c.distanceMiles} mi away` : ''
      }, observed ${c.observedAt}`,
  )
  .join('\n')}
</comps>`;
}

function renderCosts(labels: ListingLabels | null): string {
  return `<costs>
Logistics (transport, U-Haul, help): ${
    labels?.logisticsCostUsd !== null && labels?.logisticsCostUsd !== undefined
      ? `$${labels.logisticsCostUsd}`
      : 'not supplied'
  }
Refurb / parts needed: ${
    labels?.refurbCostUsd !== null && labels?.refurbCostUsd !== undefined
      ? `$${labels.refurbCostUsd}`
      : 'not supplied'
  }
</costs>`;
}

function renderMsrp(msrp: MsrpLookup | null): string {
  if (!msrp) {
    return '<retail_reference>\n(no retail/MSRP price found — do not use basis="msrp_depreciated")\n</retail_reference>';
  }
  return `<retail_reference>
Current retail/MSRP: $${msrp.msrpUsd}, as of ${msrp.asOf ?? 'unknown date'}, source: ${msrp.url}
This is a NEW-condition price with zero market signal about used demand. Do not
anchor near it — depreciate heavily and reflect the uncertainty in a wide range.
</retail_reference>`;
}

/**
 * The timing signals. These come free from passive indexing: because the user
 * re-sees the same listing while browsing, we accumulate days-listed and
 * price-drop history at no extra cost.
 */
function renderTiming(snapshot: ListingSnapshot): string {
  const obs = [...snapshot.observations].sort((a, b) => a.at.localeCompare(b.at));
  if (obs.length < 2) {
    return '<timing>\n(only one observation of this listing — no timing signal available)\n</timing>';
  }

  const first = obs[0]!;
  const last = obs[obs.length - 1]!;
  const days = Math.round(
    (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86_400_000,
  );

  let drops = 0;
  for (let i = 1; i < obs.length; i++) {
    const prev = obs[i - 1]!.priceUsd;
    const cur = obs[i]!.priceUsd;
    if (prev !== null && cur !== null && cur < prev) drops++;
  }

  const pctChange =
    first.priceUsd !== null && last.priceUsd !== null && first.priceUsd > 0
      ? ((last.priceUsd - first.priceUsd) / first.priceUsd) * 100
      : null;

  return `<timing>
Observed ${obs.length} times over ${days} day(s).
Price drops: ${drops}${pctChange !== null ? `, net change ${pctChange.toFixed(1)}%` : ''}
Currently listed: ${last.stillListed}
</timing>`;
}
