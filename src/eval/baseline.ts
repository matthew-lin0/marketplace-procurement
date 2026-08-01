import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, MODELS, REPO_ROOT } from '../config.js';
import { CliClient } from '../extractor/client/cliClient.js';
import type { CostBaseline } from './scorers/cost.js';

/**
 * Measures how much of a CLI call's reported cost is Claude Code's own system
 * prompt rather than ours.
 *
 * Why this exists: an observed two-word reply through `claude -p` reported
 * ~25,264 cache-creation tokens and $0.05. None of that is our prompt. Without
 * subtracting it, the triage-tier cost gate is measuring the harness, and
 * passive indexing looks impossibly expensive.
 *
 *   npm run baseline
 */

const BASELINE_PATH = path.join(DATA_DIR, 'cost-baseline.json');

const Trivial = z.object({ ok: z.boolean() });

export async function measureBaseline(samples = 3): Promise<CostBaseline> {
  const client = new CliClient({ cwd: REPO_ROOT });
  const cacheTokens: number[] = [];
  const costs: number[] = [];

  for (let i = 0; i < samples; i++) {
    const res = await client.run({
      stage: 'baseline',
      model: MODELS.triage,
      system: 'Reply with the minimum possible output.',
      prompt: 'Return {"ok": true}.',
      schema: Trivial,
    });
    // Cache creation on a first call, cache read on later ones — either way it
    // is the harness prompt, so take whichever is populated.
    cacheTokens.push(res.usage.cacheCreationTokens + res.usage.cacheReadTokens);
    costs.push(res.usage.rawCostUsd);
  }

  return {
    overheadCacheTokensPerCall: Math.round(median(cacheTokens)),
    overheadCostUsdPerCall: median(costs),
    measuredAt: new Date().toISOString(),
    model: MODELS.triage,
    samples,
  };
}

export async function loadBaseline(): Promise<CostBaseline | null> {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, 'utf8')) as CostBaseline;
  } catch {
    return null;
  }
}

export async function saveBaseline(b: CostBaseline): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BASELINE_PATH, JSON.stringify(b, null, 2), 'utf8');
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const samples = Number.parseInt(process.argv[2] ?? '3', 10);
  console.log(`Measuring CLI harness overhead over ${samples} trivial call(s)...`);
  const baseline = await measureBaseline(samples);
  await saveBaseline(baseline);
  console.log(`\nHarness overhead per call:`);
  console.log(`  cached tokens: ${baseline.overheadCacheTokensPerCall.toLocaleString()}`);
  console.log(`  reported cost: $${baseline.overheadCostUsdPerCall.toFixed(4)}`);
  console.log(`\nThis is Claude Code's own system prompt, not ours. Saved to ${BASELINE_PATH}`);
  console.log(`The eval report subtracts it, and shows raw vs adjusted side by side.`);
}
