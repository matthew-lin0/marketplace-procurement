import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MODELS, REPO_ROOT, SINK_PORT } from '../config.js';
import { expandAliases } from '../capture/ablate.js';
import { listingDir, saveSnapshot, sha256 } from '../capture/store.js';
import type { CapturedImage, CategoryKey, ListingSnapshot, Marketplace, Split } from '../schema/index.js';
import { CliClient } from '../extractor/client/cliClient.js';
import { identifyCandidatesPrompt, SYSTEM_APPRAISER } from '../extractor/prompts.js';
import { runAttributes } from '../extractor/stages/attributes.js';
import { runIdentify } from '../extractor/stages/identify.js';
import { loadTaxonomy } from '../taxonomy/index.js';
import { IdentifyCandidates } from '../schema/index.js';

/**
 * Local receiver for the capture extension.
 *
 *   npm run sink
 *
 * Downloads every image to disk immediately. This is not an optimization:
 * listings get deleted within days and hotlinked CDN URLs expire, so a dataset
 * of live URLs decays into a dataset of dead links. The images ARE the dataset.
 *
 * Also serves /analyze: the one-click quick-specs overlay (ext/overlay.js).
 * Unlike /snapshot, nothing here touches disk or the corpus — it's T1+T2
 * only, text-only, run fresh per click and discarded. Separate endpoint
 * rather than a flag on /snapshot because the two have nothing in common:
 * one builds the eval dataset, the other is an ephemeral product feature.
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

interface AnalyzePayload {
  sourceUrl: string;
  marketplace: Marketplace;
  category: CategoryKey;
  title: string;
  description: string;
  priceUsd: number | null;
  locationText: string | null;
  renderedText: string;
  images: { url: string; width: number | null; height: number | null }[];
}

const server = http.createServer(async (req, res) => {
  // Local-only tool; the extension is the only client.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/snapshot')) {
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
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/analyze')) {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body) as AnalyzePayload;
      const result = await handleAnalyze(payload);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      console.log(
        `analyzed ${payload.category}: ${result.identify?.abstained ? `abstained, ${result.candidates.length} candidate(s)` : `${result.identify?.brand ?? '?'} ${result.identify?.model ?? '?'}`}, ${result.attributes.length} attribute(s)`,
      );
    } catch (err) {
      console.error('analyze failed:', err);
      res.writeHead(500, { 'content-type': 'text/plain' }).end((err as Error).message);
    }
    return;
  }

  res.writeHead(404).end('not found');
});

async function handleAnalyze(payload: AnalyzePayload) {
  const snapshot: ListingSnapshot = {
    id: `analyze-${Date.now()}`,
    marketplace: payload.marketplace,
    category: payload.category,
    split: 'dev',
    sourceUrl: payload.sourceUrl,
    capturedAt: new Date().toISOString(),
    title: payload.title,
    description: payload.description || payload.renderedText.slice(0, 2_000),
    priceUsd: payload.priceUsd,
    locationText: payload.locationText,
    renderedText: payload.renderedText,
    jsonLd: [],
    images: [],
    statedModel: null,
    ablationStrings: [],
    observations: [],
  };

  const taxonomy = await loadTaxonomy(payload.category);
  const client = new CliClient({ cwd: REPO_ROOT });

  // Images go to T1 only, not T2. T1 needs them: trusting a seller's typed
  // model number alone means a typo or misremembered SKU silently identifies
  // the wrong product, and spec_lookup would then confidently return REAL
  // specs for that wrong product. A photo of the actual nameplate is a check
  // against that, same as the real six-stage pipeline's primary evidence
  // source. T2/spec_lookup stays text-only — it's the expensive, multi-step
  // web-research call, and once T1 has a real model name, the manufacturer
  // page is a better source for specs than a casual listing photo anyway.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-analyze-'));
  try {
    const imagePaths = await downloadTempImages(payload.images.slice(0, 4), tempDir);

    const identifyOut = await runIdentify(client, snapshot, taxonomy, imagePaths, {
      model: MODELS.triage,
      includeText: true,
      includeImages: imagePaths.length > 0,
      includeVisualTells: true,
      useNameplateZoom: false,
    });

    const attributesOut = await runAttributes(client, snapshot, taxonomy, identifyOut.result, [], {
      model: MODELS.triage,
      includeVisualTells: true,
      useSpecLookup: true,
    });

    // Mechanical, not model-stated: never ask the model to compute or state a
    // percentage itself (same "enforce in code" discipline as everywhere else
    // in this codebase). This is arithmetic on two real numbers — the
    // listing's actual asking price and a sourced new-unit price — not an
    // estimate of used value, so none of the anchoring/comps risk from T6
    // pricing applies here.
    const newPriceAttr = attributesOut.attributes?.attributes.find((a) => a.key === 'new_price_reference_usd');
    const newPriceUsd = newPriceAttr ? parseUsd(newPriceAttr.value) : null;
    const discountFromNewPct =
      newPriceUsd && newPriceUsd > 0 && snapshot.priceUsd !== null
        ? Math.round(((newPriceUsd - snapshot.priceUsd) / newPriceUsd) * 1000) / 10
        : null;

    // Quick-analyze-only fallback: the real identify() call already had its
    // honest shot and abstained rather than guess. Don't ask it again for the
    // same thing — ask a genuinely different, easier question ("what's
    // plausible", not "commit to one"), and never let this feed spec_lookup or
    // anything else that would need real confidence.
    let candidates: IdentifyCandidates | null = null;
    if (!identifyOut.result || identifyOut.result.abstained) {
      const candidatesRes = await client.run<IdentifyCandidates>({
        stage: 't1.identify_candidates',
        model: MODELS.triage,
        system: SYSTEM_APPRAISER,
        prompt: identifyCandidatesPrompt(snapshot, taxonomy, identifyOut.result?.family ?? null),
        schema: IdentifyCandidates,
      });
      candidates = candidatesRes.parsed;
    }

    // Attach each attribute's plain-English "why this matters" — already
    // hand-written per category in the taxonomy YAML, but spec_lookup itself
    // never sees it (its prompt only needs the key names) and nothing has
    // been surfacing it to the user either. This is the whole point of the
    // feature: not just a spec value, but why a buyer who doesn't already
    // know this category should care about it.
    const attributesWithContext =
      attributesOut.attributes?.attributes.map((a) => ({
        ...a,
        mattersBecause: taxonomy?.attributes.find((t) => t.key === a.key)?.mattersBecause ?? null,
      })) ?? [];

    return {
      identify: identifyOut.result,
      attributes: attributesWithContext,
      candidates: candidates?.candidates ?? [],
      newPriceUsd,
      discountFromNewPct,
    };
  } finally {
    // Ephemeral by design — nothing from a quick-analyze click belongs on
    // disk once the request is done.
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** First dollar-like number in a spec_lookup value string ("$329.99",
 *  "329.99 USD", "Around $300-350 depending on retailer" -> 300). Best-effort
 *  by design: a value that doesn't parse just means no discount is shown,
 *  not a failed analysis. */
function parseUsd(value: string): number | null {
  const m = /\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(value);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function downloadTempImages(
  images: { url: string; width: number | null; height: number | null }[],
  dir: string,
): Promise<string[]> {
  const paths: string[] = [];
  let index = 0;
  for (const img of images) {
    try {
      const res = await fetch(img.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < 5_000) continue; // spacer/tracking pixel
      const ext = extFor(res.headers.get('content-type'), img.url);
      const filePath = path.join(dir, `${String(index).padStart(2, '0')}${ext}`);
      await fs.writeFile(filePath, buf);
      paths.push(filePath);
      index++;
    } catch {
      // Best-effort: a broken image URL degrades to fewer images, not a
      // failed analysis.
    }
  }
  return paths;
}

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
