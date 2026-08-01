import type { ListingSnapshot } from '../schema/index.js';

/**
 * The ground-truth trick: harvest listings that already state their model,
 * then strip the model string and see whether the system recovers it from the
 * photos plus the remaining text. Free labels at whatever scale we can
 * capture.
 *
 * Two things make or break it:
 *
 * 1. Thoroughness. Model strings leak into image filenames, JSON-LD, and
 *    seller replies. We scrub every captured field, then assert the scrub
 *    worked (`verifyAblation`). A leak silently inflates T1 accuracy, which
 *    is the single most consequential number in the eval.
 * 2. Sample bias. Sellers who state models are not a random sample — they
 *    tend to have better photos and nicer gear. T1 numbers from this split
 *    are an OPTIMISTIC CEILING, and the report says so.
 */

const REDACTION = '[REDACTED]';

/** Generates the variants a model string realistically appears as.
 *  "Rogue R-3" also hides in "RogueR3", "rogue r 3", "R‑3" (en dash). */
export function expandAliases(model: string): string[] {
  const out = new Set<string>();
  const base = model.trim();
  if (!base) return [];

  const add = (s: string) => {
    const t = s.trim();
    // Two chars or fewer matches far too much ("R3" is borderline; "R" is not).
    if (t.length >= 3) out.add(t);
  };

  add(base);
  add(base.replace(/[\s\-_.]/g, '')); // RogueR3
  add(base.replace(/[\s\-_.]+/g, ' ')); // Rogue R 3
  add(base.replace(/[\s_.]+/g, '-')); // Rogue-R-3
  add(base.replace(/[-‐-―]/g, '-')); // normalize unicode dashes

  // Individual significant words, so a bare brand token doesn't survive. A
  // listing whose JSON-LD carries {"brand": "Rogue"} has handed the model half
  // the answer for free, and scoring that as a legitimate identification would
  // inflate T1 exactly the way this whole mechanism exists to prevent.
  //
  // The 4-char floor keeps generic model-number fragments ("R", "3", "Pro")
  // from redacting unrelated prose.
  for (const word of base.split(/[\s\-_.]+/)) {
    if (word.length >= 4 && /[a-z]/i.test(word)) add(word);
  }

  // Numeric-suffix variants: "R-3" <-> "R3" <-> "R 3"
  const m = /^(.*?)([A-Za-z]+)[\s\-_.]*(\d+)$/.exec(base);
  if (m) {
    const [, prefix, letters, digits] = m;
    add(`${prefix}${letters}${digits}`);
    add(`${prefix}${letters}-${digits}`);
    add(`${prefix}${letters} ${digits}`);
  }

  return [...out];
}

/** Escapes regex metacharacters, then makes runs of whitespace/dashes match
 *  each other, so one pattern covers "R-3", "R 3", and "R  -  3". */
function toFlexiblePattern(s: string): RegExp {
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/(\\?[\s\-_])+/g, '[\\s\\-_.]*');
  return new RegExp(flexible, 'gi');
}

export function scrubText(text: string, strings: string[]): string {
  let out = text;
  // Longest first, so "Rogue R-3" is redacted before the shorter "Rogue".
  for (const s of [...strings].sort((a, b) => b.length - a.length)) {
    if (s.trim().length < 3) continue;
    out = out.replace(toFlexiblePattern(s), REDACTION);
  }
  return out;
}

function scrubDeep(value: unknown, strings: string[]): unknown {
  if (typeof value === 'string') return scrubText(value, strings);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, strings));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Scrub keys too — a JSON-LD key like "rogueR3Spec" would leak.
      out[scrubText(k, strings)] = scrubDeep(v, strings);
    }
    return out;
  }
  return value;
}

/**
 * Returns a copy of the snapshot with every appearance of the model string
 * removed from every field the extractor can see.
 *
 * Note `images[].path` is scrubbed in the returned object but the file on disk
 * keeps its original name — the extractor is only ever handed the ablated
 * path list, and `verifyAblation` checks both.
 */
export function ablate(snapshot: ListingSnapshot): ListingSnapshot {
  const strings = [
    ...snapshot.ablationStrings,
    ...(snapshot.statedModel ? expandAliases(snapshot.statedModel) : []),
  ];
  if (strings.length === 0) return snapshot;

  return {
    ...snapshot,
    title: scrubText(snapshot.title, strings),
    description: scrubText(snapshot.description, strings),
    renderedText: scrubText(snapshot.renderedText, strings),
    locationText: snapshot.locationText ? scrubText(snapshot.locationText, strings) : null,
    jsonLd: snapshot.jsonLd.map((j) => scrubDeep(j, strings)),
    images: snapshot.images.map((img) => ({
      ...img,
      path: scrubText(img.path, strings),
      sourceUrl: scrubText(img.sourceUrl, strings),
    })),
    // Deliberately preserved: this is the answer key, and it never reaches
    // the extractor. `verifyAblation` skips these two fields for that reason.
    statedModel: snapshot.statedModel,
    ablationStrings: snapshot.ablationStrings,
  };
}

export interface AblationLeak {
  field: string;
  matched: string;
  context: string;
}

/**
 * Asserts the scrub worked. Any hit is a build failure, not a warning — a
 * leaked model string turns T1 into an open-book test and invalidates the
 * headline number.
 */
export function verifyAblation(ablated: ListingSnapshot): AblationLeak[] {
  const leaks: AblationLeak[] = [];
  if (!ablated.statedModel) return leaks;

  const strings = [...ablated.ablationStrings, ...expandAliases(ablated.statedModel)].filter(
    (s) => s.trim().length >= 3,
  );

  const check = (field: string, text: string) => {
    for (const s of strings) {
      const re = toFlexiblePattern(s);
      const match = re.exec(text);
      if (match) {
        const start = Math.max(0, match.index - 40);
        leaks.push({
          field,
          matched: match[0],
          context: text.slice(start, match.index + match[0].length + 40),
        });
      }
    }
  };

  check('title', ablated.title);
  check('description', ablated.description);
  check('renderedText', ablated.renderedText);
  if (ablated.locationText) check('locationText', ablated.locationText);
  check('jsonLd', JSON.stringify(ablated.jsonLd));
  ablated.images.forEach((img, i) => {
    check(`images[${i}].path`, img.path);
    check(`images[${i}].sourceUrl`, img.sourceUrl);
  });

  return leaks;
}
