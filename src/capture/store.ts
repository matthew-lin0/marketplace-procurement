import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LABELS_DIR, LISTINGS_DIR, MANIFEST_PATH } from '../config.js';
import { ListingLabels, ListingSnapshot } from '../schema/index.js';

/**
 * Disk layout:
 *
 *   data/listings/<id>/snapshot.json   raw capture       (gitignored)
 *   data/listings/<id>/page.html       original bytes    (gitignored)
 *   data/listings/<id>/images/*        full-res images   (gitignored)
 *   data/manifest.json                 URLs, hashes      (COMMITTED)
 *   data/labels/<id>.json              hand labels       (COMMITTED)
 *
 * The split matters. Snapshots contain other people's photos and descriptions
 * — faces, house interiors, enough detail to locate a seller. The manifest and
 * labels carry our own judgments, which are the expensive part and contain
 * nothing sensitive. That makes the dataset irreplaceable and unbacked, so:
 * keep a local Time Machine / external-drive backup, not cloud sync.
 */

export interface ManifestEntry {
  id: string;
  sourceUrl: string;
  marketplace: string;
  category: string;
  split: string;
  capturedAt: string;
  imageCount: number;
  imageHashes: string[];
  snapshotSha256: string;
  hasStatedModel: boolean;
}

export function listingDir(id: string): string {
  return path.join(LISTINGS_DIR, id);
}

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function saveSnapshot(snapshot: ListingSnapshot, rawHtml: string): Promise<void> {
  const dir = listingDir(snapshot.id);
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });

  // Raw HTML unmodified. Normalization is the thing under test, so it has to
  // be re-runnable against the original bytes.
  await fs.writeFile(path.join(dir, 'page.html'), rawHtml, 'utf8');

  const json = JSON.stringify(snapshot, null, 2);
  await fs.writeFile(path.join(dir, 'snapshot.json'), json, 'utf8');

  await upsertManifest({
    id: snapshot.id,
    sourceUrl: snapshot.sourceUrl,
    marketplace: snapshot.marketplace,
    category: snapshot.category,
    split: snapshot.split,
    capturedAt: snapshot.capturedAt,
    imageCount: snapshot.images.length,
    imageHashes: snapshot.images.map((i) => i.sha256),
    snapshotSha256: sha256(json),
    hasStatedModel: snapshot.statedModel !== null,
  });
}

export async function loadSnapshot(id: string): Promise<ListingSnapshot> {
  const raw = await fs.readFile(path.join(listingDir(id), 'snapshot.json'), 'utf8');
  return ListingSnapshot.parse(JSON.parse(raw));
}

export async function listSnapshotIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(LISTINGS_DIR, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        await fs.access(path.join(LISTINGS_DIR, e.name, 'snapshot.json'));
        ids.push(e.name);
      } catch {
        // Directory without a snapshot: a partial capture. Skip it.
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/** Absolute paths to a listing's images, in index order. */
export function imagePaths(snapshot: ListingSnapshot): string[] {
  const dir = listingDir(snapshot.id);
  return [...snapshot.images]
    .sort((a, b) => a.index - b.index)
    .map((img) => path.resolve(dir, img.path));
}

export async function loadLabels(id: string): Promise<ListingLabels | null> {
  try {
    const raw = await fs.readFile(path.join(LABELS_DIR, `${id}.json`), 'utf8');
    return ListingLabels.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readManifest(): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')) as ManifestEntry[];
  } catch {
    return [];
  }
}

async function upsertManifest(entry: ManifestEntry): Promise<void> {
  const manifest = await readManifest();
  const idx = manifest.findIndex((m) => m.id === entry.id);
  if (idx >= 0) manifest[idx] = entry;
  else manifest.push(entry);
  manifest.sort((a, b) => a.id.localeCompare(b.id));
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}
