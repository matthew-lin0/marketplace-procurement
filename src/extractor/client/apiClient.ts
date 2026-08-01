import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest, ModelResponse } from './types.js';
import { ModelCallError } from './types.js';
import { toWireSchema } from './jsonSchema.js';

/**
 * Metered API backend. Not the default — the CLI backend runs on a Claude Code
 * subscription with no key. This exists so the cost gate can be measured
 * against real per-token pricing, since the CLI backend's numbers include
 * Claude Code's own system prompt and multi-turn agent overhead.
 *
 * Requires ANTHROPIC_API_KEY.
 */
export class ApiClient implements ModelClient {
  readonly backend = 'api' as const;
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'ApiClient requires ANTHROPIC_API_KEY. Use the default CLI backend to run on a Claude Code subscription instead.',
      );
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async run<T>(req: ModelRequest): Promise<ModelResponse<T>> {
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [];

    for (const p of req.imagePaths ?? []) {
      const data = await fs.readFile(p);
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaTypeFor(p),
          data: data.toString('base64'),
        },
      });
    }
    content.push({ type: 'text', text: req.prompt });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: req.system,
      messages: [{ role: 'user', content }],
    };

    if (req.schema) {
      params.output_config = {
        format: { type: 'json_schema', schema: toWireSchema(req.schema) },
      };
    }
    if (req.allowWebSearch) {
      params.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const retryable = e.status === 429 || (e.status ?? 0) >= 500;
      throw new ModelCallError(
        `stage ${req.stage}: API error ${e.status}: ${e.message}`,
        req.stage,
        retryable,
      );
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const usage = {
      stage: req.stage,
      model: req.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      // Priced from token counts by the report, not reported inline here.
      rawCostUsd: 0,
      wallClockMs: Date.now() - started,
    };

    if (!req.schema) return { parsed: null, text, usage };

    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch {
      throw new ModelCallError(
        `stage ${req.stage}: expected JSON, got: ${text.slice(0, 300)}`,
        req.stage,
        true,
      );
    }

    const validated = req.schema.safeParse(candidate);
    if (!validated.success) {
      throw new ModelCallError(
        `stage ${req.stage}: schema validation failed: ${validated.error.message}`,
        req.stage,
        true,
      );
    }

    return { parsed: validated.data as T, text, usage };
  }
}

function mediaTypeFor(p: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch (path.extname(p).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
