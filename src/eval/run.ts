import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, RUNNER, RUNS_DIR } from '../config.js';
import { listSnapshotIds, loadLabels, loadSnapshot } from '../capture/store.js';
import { ApiClient } from '../extractor/client/apiClient.js';
import { CliClient } from '../extractor/client/cliClient.js';
import type { ModelClient } from '../extractor/client/types.js';
import { ModelCallError } from '../extractor/client/types.js';
import {
  ABLATIONS,
  DEFAULT_ABLATION,
  extract,
  type AblationConfig,
} from '../extractor/pipeline.js';
import type { ExtractionResult, ListingSnapshot, Split, Tier } from '../schema/index.js';
import { loadBaseline } from './baseline.js';
import { buildReport, renderReport } from './report.js';

/**
 * Eval runner.
 *
 *   npm run eval -- --split=dev
 *   npm run eval -- --split=dev --ablations
 *   npm run eval -- --split=holdout          # ONCE, at the end
 *
 * Throttled and checkpointed on purpose: the default backend is a Claude Code
 * subscription, whose limits are built for interactive use rather than batch
 * loops. Every completed listing is written to disk immediately, and a rerun
 * resumes rather than starting over.
 */

interface Args {
  split: Split;
  tier: Tier;
  ablations: boolean;
  backend: 'cli' | 'api';
  limit: number | null;
  fresh: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=').slice(1).join('=');
  };
  const has = (name: string) => argv.includes(`--${name}`);

  const split = (get('split') ?? 'dev') as Split;
  if (split !== 'dev' && split !== 'holdout') {
    throw new Error(`--split must be "dev" or "holdout", got "${split}"`);
  }

  return {
    split,
    tier: (get('tier') ?? 'full') as Tier,
    ablations: has('ablations'),
    backend: (get('backend') ?? 'cli') as 'cli' | 'api',
    limit: get('limit') ? Number.parseInt(get('limit')!, 10) : null,
    fresh: has('fresh'),
    verbose: has('verbose'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.split === 'holdout') {
    console.log(
      [
        '',
        '  ⚠  HOLDOUT RUN',
        '',
        '  The holdout exists because a human editing prompts against the same',
        '  listings overfits them just as reliably as gradient descent would.',
        '  Run this ONCE, when prompts and taxonomy are frozen. If you iterate',
        '  after seeing these numbers, they stop meaning anything.',
        '',
      ].join('\n'),
    );
  }

  const client: ModelClient =
    args.backend === 'api'
      ? new ApiClient()
      : new CliClient({ cwd: REPO_ROOT, verbose: args.verbose });

  console.log(`backend: ${client.backend}, split: ${args.split}, tier: ${args.tier}`);

  const baseline = await loadBaseline();
  if (!baseline && client.backend === 'cli') {
    console.warn(
      '\n  ⚠  No cost baseline found. CLI costs include Claude Code\'s own ~25k-token\n' +
        '     system prompt on every call, so reported cost will be inflated.\n' +
        '     Run `npm run baseline` first for meaningful cost numbers.\n',
    );
  }

  const ids = await listSnapshotIds();
  if (ids.length === 0) {
    console.error(
      [
        '',
        'No listings captured yet.',
        '',
        'The dataset is yours to collect — the capture extension runs in your own',
        'logged-in browser session, which is the whole point of that approach.',
        '',
        '  1. npm run sink                     (starts the local receiver)',
        '  2. Load ./ext unpacked in Chrome    (chrome://extensions, dev mode)',
        '  3. Browse listings, click the extension button on each',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const snapshots: ListingSnapshot[] = [];
  for (const id of ids) {
    const s = await loadSnapshot(id);
    if (s.split === args.split) snapshots.push(s);
  }

  const selected = args.limit ? snapshots.slice(0, args.limit) : snapshots;
  if (selected.length === 0) {
    console.error(`No listings in split "${args.split}". Captured splits: ${
      [...new Set(snapshots.map((s) => s.split))].join(', ') || '(none)'
    }`);
    process.exitCode = 1;
    return;
  }

  const configs = args.ablations ? ABLATIONS : [DEFAULT_ABLATION];
  console.log(
    `${selected.length} listing(s) x ${configs.length} config(s) = ${
      selected.length * configs.length
    } extraction(s)\n`,
  );

  const runId = `${args.split}-${args.tier}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(RUNS_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });

  const allResults: { ablation: string; result: ExtractionResult }[] = [];

  for (const config of configs) {
    console.log(`\n── ablation: ${config.name} ─────────────────────────────`);
    const results = await runConfig(client, selected, config, args, runDir);
    allResults.push(...results.map((r) => ({ ablation: config.name, result: r })));
  }

  // Assemble scoring inputs alongside their labels.
  const withLabels = await Promise.all(
    allResults.map(async (r) => ({
      ...r,
      snapshot: selected.find((s) => s.id === r.result.listingId)!,
      labels: await loadLabels(r.result.listingId),
    })),
  );

  const report = await buildReport(withLabels, {
    split: args.split,
    tier: args.tier,
    backend: client.backend,
    baseline,
    runId,
  });

  const md = renderReport(report);
  const reportPath = path.join(runDir, 'report.md');
  await fs.writeFile(reportPath, md, 'utf8');
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n${md}`);
  console.log(`\nWritten to ${reportPath}`);
}

async function runConfig(
  client: ModelClient,
  snapshots: ListingSnapshot[],
  config: AblationConfig,
  args: Args,
  runDir: string,
): Promise<ExtractionResult[]> {
  const outDir = path.join(runDir, config.name);
  await fs.mkdir(outDir, { recursive: true });

  const results: ExtractionResult[] = [];
  const queue = [...snapshots];
  let done = 0;

  // Modest concurrency: subscription limits are built for interactive use.
  const workers = Array.from({ length: RUNNER.concurrency }, async () => {
    for (;;) {
      const snapshot = queue.shift();
      if (!snapshot) return;

      const cachePath = path.join(outDir, `${snapshot.id}.json`);
      if (!args.fresh) {
        try {
          const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as ExtractionResult;
          results.push(cached);
          done++;
          process.stdout.write(`  [${done}/${snapshots.length}] ${snapshot.id} (resumed)\n`);
          continue;
        } catch {
          // Not yet run; fall through.
        }
      }

      try {
        const result = await withRetry(() =>
          extract(client, snapshot, { tier: args.tier, ablation: config }),
        );
        await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');
        results.push(result);
        done++;

        const id = result.identify;
        const idStr = id?.abstained
          ? 'abstained'
          : id?.model
            ? `${id.brand ?? '?'} ${id.model} (${id.confidence.toFixed(2)})`
            : 'no id';
        process.stdout.write(`  [${done}/${snapshots.length}] ${snapshot.id}: ${idStr}\n`);
      } catch (err) {
        done++;
        process.stdout.write(
          `  [${done}/${snapshots.length}] ${snapshot.id}: FAILED — ${(err as Error).message}\n`,
        );
      }

      await sleep(RUNNER.delayBetweenCallsMs);
    }
  });

  await Promise.all(workers);
  return results;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RUNNER.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ModelCallError ? err.retryable : false;
      if (!retryable || attempt === RUNNER.maxRetries) throw err;
      const delay = RUNNER.retryBaseDelayMs * 2 ** attempt;
      process.stdout.write(`    retry ${attempt + 1}/${RUNNER.maxRetries} in ${delay}ms\n`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
