import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIDENT_TIER_THRESHOLD, DATA_DIR } from '../../config.js';
import {
  SentimentResult,
  type CategoryTaxonomy,
  type IdentifyResult,
  type UsageRecord,
} from '../../schema/index.js';
import { sentimentPrompt, SYSTEM_APPRAISER } from '../prompts.js';
import type { ModelClient } from '../client/types.js';
import { communitiesFor } from '../../taxonomy/index.js';

/**
 * T5: retrieve used-buying intelligence.
 *
 * Framed away from "reviews" deliberately. Retail reviews answer "should I buy
 * this new." A used purchase needs: what wears out, what to inspect, whether
 * parts are still made, which generation had the bad part.
 *
 * Two structural decisions:
 *
 * 1. GATED on T1 confidence. Sentiment for a misidentified model is worse than
 *    no sentiment — it launders a wrong ID inside credible-looking owner
 *    testimony. The result always carries conditionedOnModel so the UI can
 *    show the premise and let the user reject it.
 *
 * 2. CACHED PER MODEL, not per listing. Owner reports for a Rogue R-3 are the
 *    same across every R-3 listing forever. This is the one part of the system
 *    that compounds, and it keeps T5 out of the passive-indexing cost path.
 */

const CACHE_DIR = path.join(DATA_DIR, 'sentiment-cache');

export interface SentimentOptions {
  model: string;
  /** Ablation: taxonomy-seeded site: filters vs unrestricted web search. */
  useCommunitySeeding: boolean;
  useCache: boolean;
}

export interface SentimentOutput {
  sentiment: SentimentResult | null;
  usage: UsageRecord[];
  skipped: { stage: string; reason: string }[];
  cacheHit: boolean;
}

export async function runSentiment(
  client: ModelClient,
  taxonomy: CategoryTaxonomy | null,
  identify: IdentifyResult | null,
  opts: SentimentOptions,
): Promise<SentimentOutput> {
  // The gate. Not a soft preference — a hard refusal.
  if (
    !identify ||
    identify.abstained ||
    identify.confidence < CONFIDENT_TIER_THRESHOLD ||
    !identify.brand ||
    !identify.model
  ) {
    return {
      sentiment: null,
      usage: [],
      cacheHit: false,
      skipped: [
        {
          stage: 't5.sentiment',
          reason: `T1 not confident (abstained=${identify?.abstained ?? 'null'}, conf=${
            identify?.confidence ?? 0
          } < ${CONFIDENT_TIER_THRESHOLD}); owner reports for a guessed model would read as credible evidence for the wrong item`,
        },
      ],
    };
  }

  const key = cacheKey(identify.brand, identify.model, identify.generation);

  if (opts.useCache) {
    const hit = await readCache(key);
    if (hit) return { sentiment: hit, usage: [], skipped: [], cacheHit: true };
  }

  const communities = opts.useCommunitySeeding ? communitiesFor(taxonomy) : [];

  const res = await client.run<SentimentResult>({
    stage: 't5.sentiment',
    model: opts.model,
    system: SYSTEM_APPRAISER,
    prompt: sentimentPrompt(identify.brand, identify.model, identify.generation, communities),
    schema: SentimentResult,
    allowWebSearch: true,
  });

  if (!res.parsed) {
    return { sentiment: null, usage: [res.usage], skipped: [], cacheHit: false };
  }

  // Enforce the invariants the scorers rely on, mechanically.
  const findings = res.parsed.findings
    // No quote, drop the finding. This is what makes the attribution scorer
    // possible at all.
    .filter((f) => f.citations.length > 0 && f.citations.every((c) => c.quote.trim().length > 0))
    .map((f, i) => ({
      ...f,
      // Stable ids so T6 levers can reference them.
      id: f.id && f.id.trim() ? f.id : `t5-${key.slice(0, 8)}-${i}`,
      appliesToGeneration: f.appliesToGeneration?.trim() || 'unknown',
    }));

  const result: SentimentResult = {
    findings,
    // Always echo the premise, even if the model wrote something else here.
    conditionedOnModel: `${identify.brand} ${identify.model}${
      identify.generation ? ` (${identify.generation})` : ''
    }`,
  };

  if (opts.useCache) await writeCache(key, result);

  return { sentiment: result, usage: [res.usage], skipped: [], cacheHit: false };
}

function cacheKey(brand: string, model: string, generation: string | null): string {
  const norm = `${brand}|${model}|${generation ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

async function readCache(key: string): Promise<SentimentResult | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8');
    return SentimentResult.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: SentimentResult): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2), 'utf8');
}
