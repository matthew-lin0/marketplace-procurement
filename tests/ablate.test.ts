import { describe, expect, it } from 'vitest';
import { ablate, expandAliases, scrubText, verifyAblation } from '../src/capture/ablate.js';
import type { ListingSnapshot } from '../src/schema/index.js';

/**
 * The ablation tests matter more than they look. A leaked model string turns
 * T1 into an open-book test and silently inflates the single most consequential
 * number in the eval — and it inflates it in the flattering direction, so
 * nobody would notice from the results alone.
 */

function snap(over: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    id: 'home_gym-test',
    marketplace: 'craigslist',
    category: 'home_gym',
    split: 'dev',
    sourceUrl: 'https://example.com/l/1',
    capturedAt: '2026-01-01T00:00:00Z',
    title: 'Rogue R-3 power rack for sale',
    description: 'Selling my Rogue R-3. Great rack.',
    priceUsd: 500,
    locationText: 'Somewhere',
    renderedText: 'Rogue R-3 power rack, barely used',
    jsonLd: [{ name: 'Rogue R-3', brand: 'Rogue' }],
    images: [
      {
        index: 0,
        path: 'images/00.jpg',
        sourceUrl: 'https://cdn.example.com/rogue-r3-front.jpg',
        width: 1200,
        height: 900,
        sha256: 'abc',
      },
    ],
    statedModel: 'Rogue R-3',
    ablationStrings: expandAliases('Rogue R-3'),
    observations: [],
    ...over,
  };
}

describe('expandAliases', () => {
  it('covers the spacing and punctuation variants a listing actually uses', () => {
    const aliases = expandAliases('Rogue R-3');
    expect(aliases).toContain('Rogue R-3');
    expect(aliases).toContain('RogueR3');
    expect(aliases.some((a) => a === 'Rogue R 3')).toBe(true);
  });

  it('drops fragments too short to match safely', () => {
    // A two-character alias would redact half the page.
    expect(expandAliases('R3').every((a) => a.length >= 3)).toBe(true);
  });
});

describe('scrubText', () => {
  it('is case- and separator-insensitive', () => {
    const out = scrubText('rogue  r  3 rack', ['Rogue R-3']);
    expect(out.toLowerCase()).not.toContain('rogue');
  });

  it('redacts the longest match first so no fragment survives', () => {
    const out = scrubText('Rogue R-3', ['Rogue', 'Rogue R-3']);
    expect(out).toBe('[REDACTED]');
  });
});

describe('ablate + verifyAblation', () => {
  it('scrubs every field the extractor can see', () => {
    const ablated = ablate(snap());
    expect(ablated.title).not.toMatch(/rogue/i);
    expect(ablated.description).not.toMatch(/rogue/i);
    expect(ablated.renderedText).not.toMatch(/rogue/i);
    expect(JSON.stringify(ablated.jsonLd)).not.toMatch(/rogue/i);
    // Image filenames are a classic leak path.
    expect(ablated.images[0]!.sourceUrl).not.toMatch(/rogue/i);
  });

  it('preserves the answer key, which never reaches the extractor', () => {
    const ablated = ablate(snap());
    expect(ablated.statedModel).toBe('Rogue R-3');
  });

  it('reports no leaks on a correctly ablated snapshot', () => {
    expect(verifyAblation(ablate(snap()))).toEqual([]);
  });

  it('CATCHES a leak that ablation missed', () => {
    // Simulates the failure mode the check exists for: a field the scrubber
    // didn't reach. Without this check the eval would silently score an
    // open-book test.
    const leaky = ablate(snap());
    const tampered = { ...leaky, renderedText: 'actually its a Rogue R-3' };
    const leaks = verifyAblation(tampered);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]!.field).toBe('renderedText');
  });

  it('catches a leak hiding in JSON-LD', () => {
    const leaky = ablate(snap());
    const tampered = { ...leaky, jsonLd: [{ sku: 'RogueR3' }] };
    expect(verifyAblation(tampered).length).toBeGreaterThan(0);
  });

  it('is a no-op for listings with no stated model', () => {
    const s = snap({ statedModel: null, ablationStrings: [] });
    const ablated = ablate(s);
    expect(ablated.title).toBe(s.title);
    expect(verifyAblation(ablated)).toEqual([]);
  });
});
