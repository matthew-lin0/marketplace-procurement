/** Shared normalization for string comparison across scorers. */

export function normalizeModelString(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―]/g, '-') // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** "Rogue R-3" and "rogue r3" are the same model. */
export function modelsMatchExact(a: string, b: string): boolean {
  const na = normalizeModelString(a).replace(/\s/g, '');
  const nb = normalizeModelString(b).replace(/\s/g, '');
  return na === nb && na.length > 0;
}

/**
 * Family-level partial credit: does the prediction share the brand and the
 * distinctive alphanumeric token with the truth? "Rogue R-4" vs "Rogue R-3"
 * shares the brand but not the token, so it is NOT a family match — that
 * distinction is the whole point of scoring family separately.
 */
export function modelsMatchFamily(a: string, b: string, aliases: string[][] = []): boolean {
  if (modelsMatchExact(a, b)) return true;

  for (const group of aliases) {
    const inA = group.some((g) => modelsMatchExact(g, a));
    const inB = group.some((g) => modelsMatchExact(g, b));
    if (inA && inB) return true;
  }

  const ta = new Set(normalizeModelString(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeModelString(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;

  // A conflicting model number is a WRONG answer, not a near miss. "Rogue R-4"
  // vs "Rogue R-3" share the brand and the letter, but they are different
  // racks at different prices — crediting that as partial would let the
  // family metric launder exactly the error it is meant to expose.
  const numsA = [...ta].filter((t) => /^\d+$/.test(t));
  const numsB = [...tb].filter((t) => /^\d+$/.test(t));
  if (numsA.length > 0 && numsB.length > 0) {
    const overlap = numsA.some((n) => numsB.includes(n));
    if (!overlap) return false;
  }

  const shared = [...ta].filter((t) => tb.has(t));
  // Require a shared token that carries model identity. A shared brand alone
  // is not a family match — every Rogue product would match every other one.
  const hasDistinctive = shared.some((t) => /\d/.test(t));
  return shared.length >= 2 && hasDistinctive;
}

/** Whitespace-and-punctuation-insensitive containment, for the mechanical
 *  quote-match check in T5. */
export function normalizeForQuoteMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const q = normalizeForQuoteMatch(quote);
  if (q.length < 10) return false; // too short to be meaningful evidence
  return normalizeForQuoteMatch(pageText).includes(q);
}

/** Loose key equality for attribute keys: `chamber_lining` ~ "chamber lining". */
export function keysMatch(a: string, b: string): boolean {
  return normalizeModelString(a).replace(/\s/g, '') === normalizeModelString(b).replace(/\s/g, '');
}

/** Value agreement, tolerant of formatting but not of meaning. */
export function valuesAgree(a: string, b: string): boolean {
  const na = normalizeModelString(a);
  const nb = normalizeModelString(b);
  if (na === nb) return true;
  // Containment handles "copper" vs "copper lined interior".
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;

  // Numeric agreement within 2%, so "17.7 in" and "17.7in" and "17.72" agree
  // but "11 gauge" and "14 gauge" do not.
  const numA = extractNumber(na);
  const numB = extractNumber(nb);
  if (numA !== null && numB !== null) {
    const denom = Math.max(Math.abs(numA), Math.abs(numB), 1e-9);
    return Math.abs(numA - numB) / denom <= 0.02;
  }
  return false;
}

function extractNumber(s: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Number.parseFloat(m[0]) : null;
}
