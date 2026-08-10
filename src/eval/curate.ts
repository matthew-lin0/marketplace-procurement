import fs from 'node:fs/promises';
import path from 'node:path';
import { listingDir, loadSnapshot, saveSnapshot } from '../capture/store.js';

/**
 * Manual image triage. Capture is deliberately selector-free (ext/content.js
 * grabs every plausible image on the page), which on image-heavy sites like
 * Facebook Marketplace sweeps in "related listings" thumbnails alongside the
 * real gallery. At ~60 listings total, reviewing which images actually belong
 * is cheap; an automated filter getting it wrong and silently dropping a real
 * photo is not — listings vanish within days, so a missed photo is gone for
 * good. Same philosophy as data/labels/: hand curation where it's cheap at
 * this scale.
 *
 *   npx tsx src/eval/curate.ts <id>                 # list images
 *   npx tsx src/eval/curate.ts <id> --keep=0,2,5     # keep only these indices
 *
 * imageIndex in T1/T2/T3 evidence refers to position in the filtered list
 * actually sent to the model, not the raw capture index — so dropping entries
 * here needs no re-indexing downstream.
 */

async function main(): Promise<void> {
  const [id, ...rest] = process.argv.slice(2);
  if (!id) {
    console.error('usage: curate <listing-id> [--keep=0,2,5]');
    process.exitCode = 1;
    return;
  }

  const keepArg = rest.find((a) => a.startsWith('--keep='));
  const snapshot = await loadSnapshot(id);
  const dir = listingDir(id);
  const sorted = [...snapshot.images].sort((a, b) => a.index - b.index);

  if (!keepArg) {
    console.log(`${sorted.length} image(s) for ${id}:\n`);
    for (const img of sorted) {
      const stat = await fs.stat(path.join(dir, img.path)).catch(() => null);
      const kb = stat ? Math.round(stat.size / 1024) : 0;
      const dims = `${img.width ?? '?'}x${img.height ?? '?'}`;
      console.log(`  ${String(img.index).padStart(2)}  ${img.path.padEnd(16)} ${dims.padEnd(10)} ${kb}KB`);
    }
    console.log(
      `\nOpen data/listings/${id}/images/ to look through them, then rerun with\n` +
        `--keep=<comma-separated indices> to drop everything else.`,
    );
    return;
  }

  const keep = new Set(
    keepArg
      .slice('--keep='.length)
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10)),
  );
  const dropped = sorted.filter((img) => !keep.has(img.index));
  const kept = sorted.filter((img) => keep.has(img.index));

  if (kept.length === 0) {
    console.error('--keep matched no images; nothing to do');
    process.exitCode = 1;
    return;
  }

  for (const img of dropped) {
    await fs.rm(path.join(dir, img.path), { force: true });
  }

  const html = await fs.readFile(path.join(dir, 'page.html'), 'utf8').catch(() => '');
  await saveSnapshot({ ...snapshot, images: kept }, html);

  console.log(`Kept ${kept.length}, dropped ${dropped.length} image(s) for ${id}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
