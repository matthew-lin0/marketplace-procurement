import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { LISTINGS_DIR, REPO_ROOT } from '../config.js';
import { ablate, verifyAblation } from '../capture/ablate.js';
import { saveSnapshot, sha256 } from '../capture/store.js';
import { CliClient } from '../extractor/client/cliClient.js';
import { DEFAULT_ABLATION, extract } from '../extractor/pipeline.js';
import type { ListingSnapshot } from '../schema/index.js';

/**
 * End-to-end smoke test against the live CLI, with no captured data required.
 *
 *   npx tsx src/eval/smoke.ts            # triage tier, ~30s
 *   npx tsx src/eval/smoke.ts --full     # all six stages, ~5min
 *
 * Synthesizes a listing whose only image is a nameplate reading
 * "ACME / MODEL PX-1235", then checks three things that matter:
 *
 *   1. Ablation actually scrubs the model string everywhere before any model
 *      call happens.
 *   2. The vision path can read small printed text off an image at all.
 *   3. T5 does NOT invent owner reports for a product that does not exist.
 *      "ACME PX-1235" has no web presence; a system that returns findings for
 *      it is fabricating, and that is the failure this whole harness exists to
 *      detect.
 *
 * The fixture is deleted afterward so it cannot pollute a real dataset.
 */

const SMOKE_ID = 'home_gym-smoketest';
const TRUE_MODEL = 'ACME PX-1235';

/** 5x7 bitmap font. Enough to render a legible nameplate without a dependency. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function renderNameplatePng(): Buffer {
  const W = 640;
  const H = 420;
  const px: number[][][] = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => [38, 38, 42]),
  );

  for (let y = 150; y < 260; y++) {
    for (let x = 120; x < 520; x++) px[y]![x] = [196, 196, 190];
  }

  const draw = (text: string, ox: number, oy: number, scale: number) => {
    let cx = ox;
    for (const ch of text.toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let r = 0; r < g.length; r++) {
        for (let c = 0; c < g[r]!.length; c++) {
          if (g[r]![c] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const y = oy + r * scale + dy;
              const x = cx + c * scale + dx;
              if (y >= 0 && y < H && x >= 0 && x < W) px[y]![x] = [20, 20, 24];
            }
          }
        }
      }
      cx += (g[0]!.length + 1) * scale;
    }
  };

  draw('ACME', 150, 168, 4);
  draw('MODEL PX-1235', 150, 210, 3);

  const rows: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px[y]![x]!;
      row[1 + x * 3] = r!;
      row[2 + x * 3] = g!;
      row[3 + x * 3] = b!;
    }
    rows.push(row);
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const dir = path.join(LISTINGS_DIR, SMOKE_ID);

  console.log('Building synthetic listing with a legible nameplate...');
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });
  const png = renderNameplatePng();
  await fs.writeFile(path.join(dir, 'images', '00.png'), png);

  const snapshot: ListingSnapshot = {
    id: SMOKE_ID,
    marketplace: 'craigslist',
    category: 'home_gym',
    split: 'dev',
    sourceUrl: 'https://example.invalid/smoketest',
    capturedAt: new Date(0).toISOString(),
    title: `${TRUE_MODEL} power rack, great shape`,
    description: `Selling my ${TRUE_MODEL} power rack. Bolt-together, comes with plates you can see in the photo.`,
    priceUsd: 550,
    locationText: 'Bay Area',
    renderedText: `${TRUE_MODEL} power rack, great shape. $550.`,
    jsonLd: [{ name: `${TRUE_MODEL} Power Rack`, brand: 'ACME' }],
    images: [
      {
        index: 0,
        path: path.join('images', '00.png'),
        sourceUrl: 'https://cdn.example.invalid/acme-px1235.png',
        width: 640,
        height: 420,
        sha256: sha256(png),
      },
    ],
    statedModel: TRUE_MODEL,
    ablationStrings: [],
    observations: [{ at: new Date(0).toISOString(), priceUsd: 550, stillListed: true }],
  };

  await saveSnapshot(snapshot, '<html><body>synthetic smoke test</body></html>');

  try {
    // Check 1: ablation, before anything reaches a model.
    const ablated = ablate(snapshot);
    const leaks = verifyAblation(ablated);
    console.log('\n[1/3] Ablation');
    console.log(`  title      : ${ablated.title}`);
    console.log(`  jsonLd     : ${JSON.stringify(ablated.jsonLd)}`);
    console.log(`  image url  : ${ablated.images[0]!.sourceUrl}`);
    if (leaks.length > 0) {
      console.error(`  FAIL: ${leaks.length} leak(s) — T1 would be an open-book test`);
      process.exitCode = 1;
      return;
    }
    console.log('  PASS: no leaks');

    // Checks 2 and 3: the live pipeline.
    console.log(`\n[2/3] Pipeline (${full ? 'full — all six stages, ~5 min' : 'triage — ~30s'})`);
    const client = new CliClient({ cwd: REPO_ROOT });
    const result = await extract(client, snapshot, {
      tier: full ? 'full' : 'triage',
      ablation: DEFAULT_ABLATION,
      bypassSentimentCache: true,
    });

    for (const e of result.errors) console.error(`  ERROR ${e.stage}: ${e.message}`);

    const id = result.identify;
    const guess = id?.abstained ? 'abstained' : `${id?.brand ?? '?'} ${id?.model ?? '?'}`;
    console.log(`  identified : ${guess} (confidence ${id?.confidence.toFixed(2) ?? 'n/a'})`);

    // Three outcomes, and conflating the first two is exactly the mistake this
    // whole harness exists to avoid. Abstaining is a valid, valued answer;
    // guessing wrong is the failure that kills the product.
    if (id?.abstained) {
      console.log('  OK: abstained rather than guessing — a valid, rewarded output');
      if (!full) {
        console.log(
          '     (triage runs Haiku with no crop-and-zoom pass. Full tier read it correctly\n' +
            '      in testing, which is a data point for the nameplate-zoom hypothesis.)',
        );
      }
    } else if (/px.?1235/i.test(id?.model ?? '')) {
      console.log('  PASS: read the model number off the image');
    } else {
      console.error(
        `  FAIL: confidently wrong — claimed "${id?.model}" at ${id?.confidence.toFixed(2)}. ` +
          'A confident wrong ID poisons every downstream stage.',
      );
      process.exitCode = 1;
    }

    if (full) {
      console.log('\n[3/3] Fabrication guard');
      const findings = result.sentiment?.findings.length ?? 0;
      // "ACME PX-1235" does not exist. Any owner report for it is invented.
      if (result.sentiment === null) {
        console.log('  PASS: T5 skipped (gated on T1 confidence)');
      } else if (findings === 0) {
        console.log('  PASS: T5 returned no findings for a nonexistent product');
      } else {
        console.error(`  FAIL: T5 invented ${findings} finding(s) for a product that does not exist`);
        process.exitCode = 1;
      }

      const basis = result.negotiation?.fairValue.basis;
      if (!result.negotiation || basis === 'insufficient_data') {
        console.log('  PASS: T6 declined to price with no comps supplied');
      } else {
        console.error(`  FAIL: T6 produced a ${basis} estimate from zero comps`);
        process.exitCode = 1;
      }
    } else {
      console.log('\n[3/3] Fabrication guard: skipped (needs --full)');
    }

    console.log(`\nStages run: ${result.usage.map((u) => u.stage).join(', ')}`);
  } finally {
    // Never leave synthetic data where a real eval would pick it up.
    await fs.rm(dir, { recursive: true, force: true });
    console.log(`\nRemoved synthetic fixture ${SMOKE_ID}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
