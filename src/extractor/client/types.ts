import type { z } from 'zod';
import type { UsageRecord } from '../../schema/index.js';

export interface ModelRequest {
  /** Names the pipeline stage, for usage attribution in the report. */
  stage: string;
  model: string;
  system: string;
  prompt: string;
  /** Absolute paths to images. The CLI backend passes these as file paths for
   *  the Read tool; the API backend base64-encodes them. */
  imagePaths?: string[];
  /** When set, the response is validated against this schema and the parsed
   *  object is returned. */
  schema?: z.ZodType;
  /** Grants web search. Only T2 spec lookup and T5 sentiment need it. */
  allowWebSearch?: boolean;
  maxTokens?: number;
}

export interface ModelResponse<T = unknown> {
  parsed: T | null;
  text: string;
  usage: UsageRecord;
}

/**
 * The seam that lets the same extractor code run against either a Claude Code
 * subscription (CliClient) or a metered API key (ApiClient). The eval calls
 * the same extractor code the extension will ship — no parallel
 * implementation, or the eval measures something that never reaches users.
 */
export interface ModelClient {
  readonly backend: 'cli' | 'api';
  run<T>(req: ModelRequest): Promise<ModelResponse<T>>;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}
