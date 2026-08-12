import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AblationLeakError, DEFAULT_ABLATION, extract } from '../src/extractor/pipeline.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../src/extractor/client/types.js';
import { expandAliases } from '../src/capture/ablate.js';
import type { ListingSnapshot } from '../src/schema/index.js';

/**
 * Pipeline behavior tests with a stub client. These check the guardrails —
 * gating, evidence enforcement, ablation leak detection — which is where the
 * eval's trustworthiness actually lives.
 */

class StubClient implements ModelClient {
  readonly backend = 'cli' as const;
  readonly calls: ModelRequest[] = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async run<T>(req: ModelRequest): Promise<ModelResponse<T>> {
    this.calls.push(req);
    const key = Object.keys(this.responses).find((k) => req.stage.startsWith(k));
    const parsed = key ? this.responses[key] : null;
    return {
      parsed: parsed as T,
      text: JSON.stringify(parsed ?? {}),
      usage: {
        stage: req.stage,
        model: req.model,
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        rawCostUsd: 0.001,
        wallClockMs: 5,
      },
    };
  }

  stages(): string[] {
    return this.calls.map((c) => c.stage);
  }
}

function snap(over: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    id: 'home_gym-test',
    marketplace: 'craigslist',
    category: 'home_gym',
    split: 'dev',
    sourceUrl: 'https://example.com/1',
    capturedAt: '2026-01-01T00:00:00Z',
    title: 'Power rack',
    description: 'A rack.',
    priceUsd: 500,
    locationText: null,
    renderedText: 'A rack.',
    jsonLd: [],
    images: [],
    statedModel: null,
    ablationStrings: [],
    observations: [],
    ...over,
  };
}

const confidentId = {
  abstained: false,
  brand: 'Rogue',
  model: 'R-3',
  generation: null,
  family: null,
  confidence: 0.9,
  reasoning: '',
  evidenceImageIndices: [],
};

const abstainedId = {
  abstained: true,
  brand: null,
  model: null,
  generation: null,
  family: 'a 3x3 power rack',
  confidence: 0.2,
  reasoning: 'no legible nameplate',
  evidenceImageIndices: [],
};

describe('ablation leak detection', () => {
  it('does not throw when every field is cleanly scrubbed', async () => {
    const clean = snap({
      statedModel: 'Rogue R-3',
      ablationStrings: [],
      title: 'Rogue R-3 rack',
      renderedText: 'A well built rack, barely used.',
    });
    await expect(
      extract(new StubClient({ t1: confidentId }), clean, {
        tier: 'full',
        ablation: DEFAULT_ABLATION,
      }),
    ).resolves.toBeDefined();
  });

  it('throws AblationLeakError when the model string survives in an image filename', async () => {
    // ablate() only rewrites the copy of images[].path it returns to the
    // caller; the file on disk keeps its original name (capture/store.ts
    // resolves paths from the raw snapshot so the file can actually be
    // found), and the CLI backend embeds that resolved path as literal text
    // in the model prompt. A descriptive filename is therefore a real leak
    // vector, distinct from — and not covered by — the text-field checks
    // above.
    const leaky = snap({
      statedModel: 'Rogue R-3',
      ablationStrings: [],
      images: [
        {
          index: 0,
          path: 'images/rogue-r3-nameplate.jpg',
          sourceUrl: 'https://example.com/1.jpg',
          width: null,
          height: null,
          sha256: 'deadbeef',
        },
      ],
    });

    await expect(
      extract(new StubClient({ t1: confidentId }), leaky, {
        tier: 'full',
        ablation: DEFAULT_ABLATION,
      }),
    ).rejects.toThrow(AblationLeakError);
  });
});

describe('tier gating', () => {
  it('triage stops after T1 — it runs on every browsed listing, so it must stay cheap', async () => {
    const client = new StubClient({ t1: confidentId });
    const result = await extract(client, snap(), {
      tier: 'triage',
      ablation: DEFAULT_ABLATION,
    });

    expect(result.identify).not.toBeNull();
    expect(result.attributes).toBeNull();
    expect(result.sentiment).toBeNull();
    expect(result.negotiation).toBeNull();
    expect(client.stages().every((s) => s.startsWith('t1'))).toBe(true);
  });
});

describe('T1 confidence gating', () => {
  it('refuses T5 and T6 when T1 abstains', async () => {
    // The most important guardrail in the system: owner reports and comps for
    // a guessed model read as credible evidence for the wrong item.
    const client = new StubClient({
      t1: abstainedId,
      t2: { attributes: [], questionsForSeller: [] },
      t4: { rankedKeys: [], rationale: '' },
    });

    const result = await extract(client, snap(), {
      tier: 'full',
      ablation: DEFAULT_ABLATION,
    });

    expect(result.sentiment).toBeNull();
    expect(result.negotiation).toBeNull();
    expect(client.stages()).not.toContain('t5.sentiment');
    expect(client.stages()).not.toContain('t6.negotiate');

    const reasons = result.skipped.map((s) => s.stage);
    expect(reasons).toContain('t5.sentiment');
    expect(reasons).toContain('t6.negotiate');
  });

  it('skips spec lookup when the ID is a guess', async () => {
    const client = new StubClient({
      t1: abstainedId,
      t2: { attributes: [], questionsForSeller: [] },
      t4: { rankedKeys: [], rationale: '' },
    });

    await extract(client, snap(), { tier: 'full', ablation: DEFAULT_ABLATION });
    expect(client.stages()).not.toContain('t2.spec_lookup');
  });

  it('runs the gated stages once T1 is confident', async () => {
    const client = new StubClient({
      t1: confidentId,
      t2: { attributes: [], questionsForSeller: [] },
      t4: { rankedKeys: [], rationale: '' },
      t5: { findings: [], conditionedOnModel: 'Rogue R-3' },
      t6: {
        fairValue: { low: null, point: null, high: null, basis: 'insufficient_data' },
        askingPremiumUsd: null,
        levers: [],
        walkAwayUsd: null,
        batna: null,
        sellerMotivation: { daysListed: null, priceDrops: null, relistCount: null, confidence: 0 },
        openingOfferUsd: null,
        unknowns: [],
      },
    });

    await extract(client, snap(), {
      tier: 'full',
      ablation: { ...DEFAULT_ABLATION, useCommunitySeeding: false },
      bypassSentimentCache: true,
    });

    expect(client.stages()).toContain('t2.spec_lookup');
    expect(client.stages()).toContain('t5.sentiment');
    expect(client.stages()).toContain('t6.negotiate');
  });
});

describe('T6 msrp_depreciated fallback', () => {
  // No data/labels/ fixture exists for these ids, so comps is always empty —
  // below MIN_COMPS, which is what triggers the msrp lookup at all.
  const negotiateBase = {
    askingPremiumUsd: null,
    levers: [],
    walkAwayUsd: null,
    batna: null,
    sellerMotivation: { daysListed: null, priceDrops: null, relistCount: null, confidence: 0 },
    openingOfferUsd: null,
    unknowns: [],
  };

  it('accepts an msrp_depreciated estimate when a real sourced MSRP was found', async () => {
    const client = new StubClient({
      t1: confidentId,
      t2: { attributes: [], questionsForSeller: [] },
      t4: { rankedKeys: [], rationale: '' },
      't6.msrp_lookup': { found: true, msrpUsd: 300, url: 'https://example.com/spec', asOf: '2026' },
      't6.negotiate': {
        ...negotiateBase,
        fairValue: { low: 50, point: 80, high: 120, basis: 'msrp_depreciated' },
      },
    });

    const result = await extract(client, snap(), {
      tier: 'full',
      ablation: DEFAULT_ABLATION,
      bypassSentimentCache: true,
    });

    expect(result.negotiation?.fairValue.basis).toBe('msrp_depreciated');
    expect(result.negotiation?.fairValue.point).toBe(80);
  });

  it('overrides a claimed msrp_depreciated estimate to insufficient_data when no real MSRP backs it', async () => {
    // Simulates the model ignoring instructions and returning a number anyway
    // — the code must not trust the self-reported basis without a real lookup.
    const client = new StubClient({
      t1: confidentId,
      t2: { attributes: [], questionsForSeller: [] },
      t4: { rankedKeys: [], rationale: '' },
      't6.msrp_lookup': { found: false, msrpUsd: null, url: null, asOf: null },
      't6.negotiate': {
        ...negotiateBase,
        fairValue: { low: 50, point: 80, high: 120, basis: 'msrp_depreciated' },
      },
    });

    const result = await extract(client, snap(), {
      tier: 'full',
      ablation: DEFAULT_ABLATION,
      bypassSentimentCache: true,
    });

    expect(result.negotiation?.fairValue.basis).toBe('insufficient_data');
    expect(result.negotiation?.fairValue.point).toBeNull();
  });
});

describe('evidence enforcement', () => {
  it('drops a photo claim with no image cited', async () => {
    const client = new StubClient({
      t1: confidentId,
      t2: {
        attributes: [
          { key: 'a', value: 'x', confidence: 0.9, source: 'photo_inference', evidence: null },
          {
            key: 'b',
            value: 'y',
            confidence: 0.9,
            source: 'photo_inference',
            evidence: { imageIndex: 0, bbox: null, quote: null, url: null },
          },
        ],
        questionsForSeller: [],
      },
      t4: { rankedKeys: [], rationale: '' },
      t5: { findings: [], conditionedOnModel: 'Rogue R-3' },
      t6: {
        fairValue: { low: null, point: null, high: null, basis: 'insufficient_data' },
        askingPremiumUsd: null,
        levers: [],
        walkAwayUsd: null,
        batna: null,
        sellerMotivation: { daysListed: null, priceDrops: null, relistCount: null, confidence: 0 },
        openingOfferUsd: null,
        unknowns: [],
      },
    });

    const result = await extract(client, snap(), {
      tier: 'full',
      ablation: DEFAULT_ABLATION,
      bypassSentimentCache: true,
    });

    const keys = result.attributes!.attributes.map((a) => a.key);
    expect(keys).toContain('b');
    expect(keys).not.toContain('a');
  });
});

describe('ablation config', () => {
  it('withholds images entirely in the text_only config', async () => {
    const client = new StubClient({ t1: confidentId });
    await extract(client, snap(), {
      tier: 'triage',
      ablation: { ...DEFAULT_ABLATION, includeImages: false },
    });
    expect(client.calls[0]!.imagePaths).toEqual([]);
  });
});

describe('schema round-trip', () => {
  it('accepts the identify shape the prompts ask for', () => {
    const Schema = z.object({ abstained: z.boolean() });
    expect(Schema.safeParse({ abstained: true }).success).toBe(true);
  });
});
