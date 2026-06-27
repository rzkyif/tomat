// Shared request-body helpers for the HTTP routes. `readJson` decodes the JSON
// body (throwing a uniform validation error on malformed input); `parseBody`
// validates an already-decoded body against a Zod schema. Together they replace
// the per-route copies of both that the route files used to define locally.

import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "../shared/errors.ts";

/**
 * Decode the JSON request body. Throws `validation_error` on malformed JSON.
 * With `allowEmpty`, an empty body resolves to `{}` instead of throwing, for
 * endpoints whose body is optional (defaults fill in the rest).
 */
export async function readJson(c: Context, opts?: { allowEmpty?: boolean }): Promise<unknown> {
  if (opts?.allowEmpty) {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError("validation_error", "invalid JSON body");
    }
  }
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}

/** Validate `body` against `schema`, throwing `validation_error` on mismatch. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("validation_error", parsed.error.message);
  }
  return parsed.data;
}
