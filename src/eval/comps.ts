import fs from 'node:fs/promises';
import path from 'node:path';
import { LABELS_DIR } from '../config.js';
import { loadLabels, loadSnapshot, readManifest } from '../capture/store.js';
import type { Comp, ListingLabels } from '../schema/index.js';

/**
 * Populates T6 comps from your own captured corpus instead of hand-typing
 * JSON, and instead of scraping eBay/Facebook (both actively block
 * unauthenticated fetches — see the ablation/negotiate research). Condition
 * and exact-model-match are judgment calls only a human looking at the
 * listing can make, so this tool surfaces candidates and asks for that
 * judgment rather than guessing it.
 *
 *   npx tsx src/eval/comps.ts <target-id>
 *       lists other captured listings in the same category as candidates
 *
 *   npx tsx src/eval/comps.ts <target-id> --add=<other-id> --condition=<tier>
 *       [--exact=true] [--distance=<miles>] [--model="..."]
 *       adds one comp, pulling price/date/url from that listing's own capture
 */

const CONDITIONS = ['parts', 'rough', 'used', 'good', 'excellent', 'new'] as const;

async function main(): Promise<void> {
  const [targetId, ...rest] = process.argv.slice(2);
  if (!targetId) {
    console.error('usage: comps <target-listing-id> [--add=<other-id> --condition=<tier> ...]');
    process.exitCode = 1;
    return;
  }

  const addArg = rest.find((a) => a.startsWith('--add='));

  if (!addArg) {
    const manifest = await readManifest();
    const target = manifest.find((m) => m.id === targetId);
    const candidates = manifest.filter(
      (m) => m.id !== targetId && (!target || m.category === target.category),
    );

    if (candidates.length === 0) {
      console.log(
        `No other captured listings in category "${target?.category ?? '?'}" yet — ` +
          `capture some comparable listings first, then rerun this.`,
      );
      return;
    }

    console.log(`Candidate comps for ${targetId} (same category):\n`);
    for (const c of candidates) {
      const snap = await loadSnapshot(c.id).catch(() => null);
      console.log(
        `  ${c.id.padEnd(28)} $${String(snap?.priceUsd ?? '?').padEnd(6)} ${c.marketplace.padEnd(10)} captured ${c.capturedAt.slice(0, 10)}`,
      );
    }
    console.log(
      `\nAdd one at a time — you decide condition and exactness, this tool won't guess:\n` +
        `  npm run comps -- ${targetId} --add=<other-id> --condition=<${CONDITIONS.join('|')}> [--exact=true] [--distance=<miles>] [--model="..."]`,
    );
    return;
  }

  const get = (name: string): string | undefined =>
    rest.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);

  const otherId = addArg.slice('--add='.length);
  const condition = get('condition');
  if (!condition || !(CONDITIONS as readonly string[]).includes(condition)) {
    console.error(`--condition is required and must be one of: ${CONDITIONS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const otherSnapshot = await loadSnapshot(otherId).catch(() => null);
  if (!otherSnapshot) {
    console.error(`No captured listing found for "${otherId}"`);
    process.exitCode = 1;
    return;
  }
  if (otherSnapshot.priceUsd === null) {
    console.error(`${otherId} has no captured price — can't use it as a comp`);
    process.exitCode = 1;
    return;
  }

  const comp: Comp = {
    id: otherId,
    source: 'corpus',
    url: otherSnapshot.sourceUrl,
    model: get('model') ?? otherSnapshot.statedModel ?? otherSnapshot.title,
    isExactModel: get('exact') === 'true',
    conditionTier: condition as Comp['conditionTier'],
    priceUsd: otherSnapshot.priceUsd,
    distanceMiles: get('distance') ? Number.parseFloat(get('distance')!) : null,
    observedAt: otherSnapshot.capturedAt,
  };

  const existing = await loadLabels(targetId);
  const labels: ListingLabels = existing ?? {
    listingId: targetId,
    trueModel: null,
    trueGeneration: null,
    trueAttributes: {},
    trueUnstatedInclusions: [],
    expertTopAttributes: [],
    logisticsCostUsd: null,
    refurbCostUsd: null,
    comps: [],
  };

  if (labels.comps.some((c) => c.id === comp.id)) {
    console.error(
      `${targetId} already has a comp with id "${comp.id}" — remove it from ` +
        `data/labels/${targetId}.json first if you want to replace it`,
    );
    process.exitCode = 1;
    return;
  }

  labels.comps.push(comp);
  await fs.mkdir(LABELS_DIR, { recursive: true });
  await fs.writeFile(path.join(LABELS_DIR, `${targetId}.json`), JSON.stringify(labels, null, 2), 'utf8');

  console.log(
    `Added ${otherId} ($${comp.priceUsd}, ${condition}) as a comp for ${targetId}. ` +
      `Now has ${labels.comps.length} comp(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
