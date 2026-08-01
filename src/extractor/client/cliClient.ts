import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { ModelClient, ModelRequest, ModelResponse } from './types.js';
import { ModelCallError } from './types.js';
import { toWireSchema } from './jsonSchema.js';

/**
 * Drives the authenticated `claude` CLI in print mode, so the eval runs on a
 * Claude Code subscription with no API key.
 *
 * Two things about this backend that matter for the cost gate:
 *
 * 1. Every call carries Claude Code's own system prompt (~25k tokens as of
 *    writing). A two-word reply reports ~$0.05. That is harness overhead, not
 *    our prompt — `src/eval/baseline.ts` measures it so the report can
 *    subtract it out.
 * 2. It is an agent loop, not a single API call. Reading an image takes
 *    multiple turns. Latency and token counts are therefore NOT directly
 *    comparable to the API path; the cost gate must be re-measured against
 *    real pricing (via ApiClient) before anyone trusts it.
 */

const CliResult = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  subtype: z.string().optional(),
  api_error_status: z.unknown().nullable().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

export interface CliClientOptions {
  /** Working directory for the CLI. Image paths are made relative to this so
   *  the Read tool can reach them. */
  cwd: string;
  timeoutMs?: number;
  /** Emits the exact argv for each call. Useful when a stage misbehaves. */
  verbose?: boolean;
}

export class CliClient implements ModelClient {
  readonly backend = 'cli' as const;

  constructor(private readonly opts: CliClientOptions) {}

  async run<T>(req: ModelRequest): Promise<ModelResponse<T>> {
    const started = Date.now();
    const args = this.buildArgs(req);
    const stdin = this.buildPrompt(req);

    if (this.opts.verbose) {
      console.error(`[cli:${req.stage}] claude ${args.join(' ')}`);
    }

    const raw = await this.exec(args, stdin, req.stage);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new ModelCallError(
        `stage ${req.stage}: CLI did not return JSON. First 400 chars: ${raw.slice(0, 400)}`,
        req.stage,
        true,
      );
    }

    const res = CliResult.parse(parsedJson);

    if (res.is_error) {
      // Overload and rate-limit conditions are worth retrying; a malformed
      // request is not.
      const status = String(res.api_error_status ?? '');
      const retryable = /429|5\d\d|overload/i.test(status) || res.subtype === 'error_during_execution';
      throw new ModelCallError(
        `stage ${req.stage}: CLI reported error (subtype=${res.subtype}, status=${status})`,
        req.stage,
        retryable,
      );
    }

    const usage = {
      stage: req.stage,
      model: req.model,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: res.usage?.cache_creation_input_tokens ?? 0,
      rawCostUsd: res.total_cost_usd ?? 0,
      wallClockMs: Date.now() - started,
    };

    const text = res.result ?? '';

    if (!req.schema) {
      return { parsed: null, text, usage };
    }

    // `structured_output` is populated when --json-schema is used; fall back
    // to parsing `result` as JSON for robustness across CLI versions.
    const candidate =
      res.structured_output !== undefined ? res.structured_output : safeJson(text);

    if (candidate === undefined) {
      throw new ModelCallError(
        `stage ${req.stage}: expected structured output, got: ${text.slice(0, 300)}`,
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

  private buildArgs(req: ModelRequest): string[] {
    const args = ['-p', '--output-format', 'json', '--model', req.model];

    if (req.schema) {
      args.push('--json-schema', JSON.stringify(toWireSchema(req.schema)));
    }

    // Read is needed for images. WebSearch/WebFetch only where a stage asks
    // for it, so an ungrounded stage can't quietly reach the internet.
    const tools = ['Read'];
    if (req.allowWebSearch) tools.push('WebSearch', 'WebFetch');
    args.push('--allowed-tools', tools.join(','));

    return args;
  }

  private buildPrompt(req: ModelRequest): string {
    const parts: string[] = [];
    // Print mode has no separate system-prompt flag we can rely on across
    // versions, so the system text is prepended and clearly delimited.
    parts.push(`<role>\n${req.system}\n</role>`);

    if (req.imagePaths?.length) {
      const rel = req.imagePaths.map((p) => path.relative(this.opts.cwd, p));
      parts.push(
        `<images>\nRead each of these image files, in order. Image index N refers to the Nth path in this list (0-indexed).\n${rel
          .map((p, i) => `${i}: ${p}`)
          .join('\n')}\n</images>`,
      );
    }

    parts.push(req.prompt);
    return parts.join('\n\n');
  }

  private exec(args: string[], stdin: string, stage: string): Promise<string> {
    const timeoutMs = this.opts.timeoutMs ?? 10 * 60_000;

    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new ModelCallError(`stage ${stage}: timed out after ${timeoutMs}ms`, stage, true));
      }, timeoutMs);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ModelCallError(`stage ${stage}: spawn failed: ${err.message}`, stage, false));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new ModelCallError(
              `stage ${stage}: claude exited ${code}: ${stderr.slice(0, 400)}`,
              stage,
              true,
            ),
          );
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

function safeJson(s: string): unknown | undefined {
  const trimmed = s.trim();
  // Tolerate a fenced block, which some prompts elicit despite the schema.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
