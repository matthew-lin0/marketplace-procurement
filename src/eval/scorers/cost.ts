import type { ExtractionResult, UsageRecord } from '../../schema/index.js';

/**
 * Cost accounting.
 *
 * The CLI backend reports a `total_cost_usd` that includes Claude Code's own
 * system prompt — roughly 25k cached tokens on EVERY call. A two-word reply
 * reports about $0.05. That is harness overhead, not our prompt, and reporting
 * it as our cost would make the triage tier look ~50x more expensive than it is.
 *
 * `src/eval/baseline.ts` measures the overhead empirically; this module
 * subtracts it. Both numbers are reported so nobody has to trust the
 * subtraction blindly.
 *
 * Prices below are per million tokens, from the Anthropic pricing table. They
 * are only used for the API-equivalent estimate — the number that actually
 * decides the cost gate, since the CLI's agent-loop overhead is not what a
 * shipped extension would pay.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
};

export interface CostBaseline {
  /** Cached tokens the harness adds to every call, measured empirically. */
  overheadCacheTokensPerCall: number;
  overheadCostUsdPerCall: number;
  measuredAt: string;
  model: string;
  samples: number;
}

export interface CostSummary {
  calls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** What the backend said. For CLI runs this is inflated by harness overhead. */
  rawCostUsd: number;
  /** rawCost minus measured per-call overhead. Null when no baseline exists. */
  adjustedCostUsd: number | null;
  /** Priced from token counts at published rates, excluding the harness's own
   *  prompt. THIS is the number the cost gate should use. */
  apiEquivalentCostUsd: number;
  meanWallClockMs: number;
  byStage: Record<string, { calls: number; apiEquivalentUsd: number; meanMs: number }>;
}

export function summarizeCost(
  usage: UsageRecord[],
  baseline: CostBaseline | null,
): CostSummary {
  const byStage: CostSummary['byStage'] = {};
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let raw = 0;
  let apiEquiv = 0;
  let totalMs = 0;

  for (const u of usage) {
    inTok += u.inputTokens;
    outTok += u.outputTokens;
    cacheRead += u.cacheReadTokens;
    cacheCreate += u.cacheCreationTokens;
    raw += u.rawCostUsd;
    totalMs += u.wallClockMs;

    const stageCost = priceUsage(u, baseline);
    apiEquiv += stageCost;

    byStage[u.stage] ??= { calls: 0, apiEquivalentUsd: 0, meanMs: 0 };
    const s = byStage[u.stage]!;
    s.calls++;
    s.apiEquivalentUsd += stageCost;
    s.meanMs += u.wallClockMs;
  }

  for (const s of Object.values(byStage)) {
    s.meanMs = s.calls > 0 ? s.meanMs / s.calls : 0;
  }

  return {
    calls: usage.length,
    totalInputTokens: inTok,
    totalOutputTokens: outTok,
    totalCacheReadTokens: cacheRead,
    totalCacheCreationTokens: cacheCreate,
    rawCostUsd: raw,
    adjustedCostUsd: baseline
      ? Math.max(0, raw - baseline.overheadCostUsdPerCall * usage.length)
      : null,
    apiEquivalentCostUsd: apiEquiv,
    meanWallClockMs: usage.length > 0 ? totalMs / usage.length : 0,
    byStage,
  };
}

/**
 * Prices a single call at published rates, subtracting the harness's own
 * cached prompt from the cache-creation tokens so we are pricing OUR prompt.
 */
function priceUsage(u: UsageRecord, baseline: CostBaseline | null): number {
  const p = PRICING[u.model] ?? PRICING['claude-opus-5']!;
  const overhead = baseline?.overheadCacheTokensPerCall ?? 0;

  const ourCacheCreate = Math.max(0, u.cacheCreationTokens - overhead);
  const ourCacheRead = Math.max(0, u.cacheReadTokens - overhead);

  return (
    (u.inputTokens / 1e6) * p.inputPerMTok +
    (u.outputTokens / 1e6) * p.outputPerMTok +
    (ourCacheRead / 1e6) * p.cacheReadPerMTok +
    (ourCacheCreate / 1e6) * p.cacheWritePerMTok
  );
}

/** Per-listing cost at a given tier — the number the passive-indexing gate
 *  actually cares about. */
export function costPerListing(
  results: ExtractionResult[],
  baseline: CostBaseline | null,
): { tier: string; listings: number; meanApiEquivalentUsd: number; meanWallClockMs: number }[] {
  const byTier = new Map<string, ExtractionResult[]>();
  for (const r of results) {
    const list = byTier.get(r.tier) ?? [];
    list.push(r);
    byTier.set(r.tier, list);
  }

  return [...byTier.entries()].map(([tier, rs]) => {
    const summaries = rs.map((r) => summarizeCost(r.usage, baseline));
    return {
      tier,
      listings: rs.length,
      meanApiEquivalentUsd:
        summaries.reduce((s, c) => s + c.apiEquivalentCostUsd, 0) / Math.max(1, rs.length),
      meanWallClockMs:
        rs
          .map((r) => r.usage.reduce((s, u) => s + u.wallClockMs, 0))
          .reduce((s, ms) => s + ms, 0) / Math.max(1, rs.length),
    };
  });
}
