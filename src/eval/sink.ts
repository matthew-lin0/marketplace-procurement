import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { SINK_PORT } from '../config.js';
import { expandAliases } from '../capture/ablate.js';
import { listingDir, saveSnapshot, sha256 } from '../capture/store.js';
import type { CapturedImage, CategoryKey, ListingSnapshot, Marketplace, Split } from '../schema/index.js';

/**
 * Local receiver for the capture extension.
 *
 *   npm run sink
 *
 * Downloads every image to disk immediately. This is not an optimization:
 * listings get deleted within days and hotlinked CDN URLs expire, so a dataset
 * of live URLs decays into a dataset of dead links. The images ARE the dataset.
 */

interface Payload {
  sourceUrl: string;
  marketplace: Marketplace;
  category: CategoryKey;
  split: Split;
  capturedAt: string;
  title: string;
  description: string;
  priceUsd: number | null;
  locationText: string | null;
  renderedText: string;
  jsonLd: unknown[];
  html: string;
  images: { url: string; width: number | null; height: number | null }[];
  statedModel: string | null;
}

const server = http.createServer(async (req, res) => {
  // Local-only tool; the extension is the only client.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/snapshot')) {
    res.writeHead(404).end('not found');
    return;
  }

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as Payload;
    const result = await handleSnapshot(payload);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    console.log(
      `saved ${result.id} (${result.imagesSaved}/${result.imagesAttempted} images) — ${payload.category}/${payload.split}`,
    );
    for (const w of result.warnings) console.warn(`  ! ${w}`);
  } catch (err) {
    console.error('capture failed:', err);
    res.writeHead(500, { 'content-type': 'text/plain' }).end((err as Error).message);
  }
});

async function handleSnapshot(payload: Payload): Promise<{
  id: string;
  imagesSaved: number;
  imagesAttempted: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const id = makeId(payload.sourceUrl, payload.category);
  const dir = listingDir(id);
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });

  const images: CapturedImage[] = [];
  let index = 0;

  for (const img of payload.images) {
    try {
      const res = await fetch(img.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        warnings.push(`image ${index}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Skip spacers and tracking pixels that slipped past the size filter.
      if (buf.byteLength < 5_000) {
        continue;
      }
      const ext = extFor(res.headers.get('content-type'), img.url);
      const filename = `${String(index).padStart(2, '0')}${ext}`;
      await fs.writeFile(path.join(dir, 'images', filename), buf);

      images.push({
        index,
        path: path.join('images', filename),
        sourceUrl: img.url,
        width: img.width,
        height: img.height,
        sha256: sha256(buf),
      });
      index++;
    } catch (err) {
      warnings.push(`image ${index}: ${(err as Error).message}`);
    }
  }

  if (images.length === 0) {
    warnings.push('NO images saved — this listing is unusable for T1/T3. Re-capture with the gallery expanded.');
  }

  const snapshot: ListingSnapshot = {
    id,
    marketplace: payload.marketplace,
    category: payload.category,
    split: payload.split,
    sourceUrl: payload.sourceUrl,
    capturedAt: payload.capturedAt,
    title: payload.title,
    description: payload.description || payload.renderedText.slice(0, 2_000),
    priceUsd: payload.priceUsd,
    locationText: payload.locationText,
    renderedText: payload.renderedText,
    jsonLd: payload.jsonLd,
    images,
    statedModel: payload.statedModel,
    // Seeded from the stated model; extend by hand in snapshot.json when a
    // listing uses a nickname the expander won't produce.
    ablationStrings: payload.statedModel ? expandAliases(payload.statedModel) : [],
    observations: [
      { at: payload.capturedAt, priceUsd: payload.priceUsd, stillListed: true },
    ],
  };

  await saveSnapshot(snapshot, payload.html);

  return { id, imagesSaved: images.length, imagesAttempted: payload.images.length, warnings };
}

/** Stable per-URL so re-capturing the same listing updates it in place rather
 *  than duplicating — that is what accumulates the longitudinal observations
 *  the T6 timing signals depend on. */
function makeId(url: string, category: string): string {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
  return `${category}-${hash}`;
}

function extFor(contentType: string | null, url: string): string {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  const m = /\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i.exec(url);
  return m ? `.${m[1]!.toLowerCase()}` : '.jpg';
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

server.listen(SINK_PORT, '127.0.0.1', () => {
  console.log(`capture sink listening on http://localhost:${SINK_PORT}`);
  console.log(`snapshots -> data/listings/<id>/  (gitignored, local only)`);
  console.log(`\nLoad ./ext unpacked in Chrome, then click the button on a listing page.`);
});
