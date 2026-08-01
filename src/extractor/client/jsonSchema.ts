import { z } from 'zod';

/**
 * Converts a zod schema to the JSON Schema subset that both backends accept.
 *
 * Two problems this solves:
 *
 * 1. `z.toJSONSchema()` emits `$schema: "https://json-schema.org/draft/2020-12/schema"`.
 *    The Claude CLI's `--json-schema` validator rejects that outright:
 *      "no schema with key or ref https://json-schema.org/draft/2020-12/schema"
 *
 * 2. Structured outputs do not support numeric or string constraints
 *    (`minimum`, `maximum`, `minLength`, `maxLength`, `multipleOf`, ...).
 *
 * Stripping the constraints costs nothing, because every caller runs the FULL
 * zod schema over the response afterward (`req.schema.safeParse`). The
 * constraint is still enforced — just locally, where a violation is a caught
 * validation error rather than an opaque 400.
 *
 * Shared by both clients on purpose: the ModelClient seam only means anything
 * if swapping backends doesn't quietly change what the model is asked for.
 */

const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
]);

export function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = sanitize(value);
  }

  // Structured outputs require every object to close itself off.
  if (out['type'] === 'object' && !('additionalProperties' in out)) {
    out['additionalProperties'] = false;
  }

  return out;
}
