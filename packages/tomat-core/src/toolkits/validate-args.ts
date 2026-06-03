// Host-side validation of LLM-emitted tool arguments against the tool's
// declared JSON-Schema `parameters`, with default-filling.
//
// The core/client split dropped this step: `argumentsJson` was forwarded to the
// worker verbatim, so a tool no longer received the "normalized args with
// defaults applied" its author declared (and malformed model output reached
// tool code uncaught). This restores it, mirroring the old Bun toolkit
// service's Ajv usage.

import { Ajv, type ValidateFunction } from "ajv";
import type { Tool } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("toolkits.validate");

// `useDefaults` fills missing properties' defaults during validate(); it
// mutates the data object in place, so we re-serialize afterward. `strict:
// false` tolerates the assorted JSON-Schema dialects tool authors emit.
const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });

// Compiled-validator cache keyed by tool id. A tool's parameters schema can
// change across re-installs, so we stash the schema JSON and recompile when it
// differs. Bounded to avoid unbounded growth; eviction is FIFO via Map
// insertion order (good enough; validators are cheap to rebuild).
const MAX_VALIDATORS = 256;
const cache = new Map<string, { schemaJson: string; validate: ValidateFunction }>();

/** Validate `argumentsJson` against `tool.parameters` and return a normalized
 *  JSON string with schema defaults applied. Throws
 *  `AppError("validation_error")` when the arguments are not valid JSON or
 *  violate the schema. A malformed author schema is treated as "no validation"
 *  (raw args pass through) so a bad schema can't wedge the call path. */
export function validateAndNormalizeToolArgs(tool: Tool, argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
  } catch {
    throw new AppError("validation_error", `tool ${tool.name}: arguments are not valid JSON`);
  }

  const schema = tool.parameters ?? { type: "object" };
  const schemaJson = JSON.stringify(schema);
  let entry = cache.get(tool.id);
  if (!entry || entry.schemaJson !== schemaJson) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      log.warn(
        `tool ${tool.id}: unusable parameters schema, skipping validation: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return argumentsJson;
    }
    if (cache.size >= MAX_VALIDATORS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    entry = { schemaJson, validate };
    cache.set(tool.id, entry);
  }

  if (!entry.validate(parsed)) {
    const detail = ajv
      .errorsText(entry.validate.errors, { separator: "; " })
      .replace(/^data/, "args");
    throw new AppError("validation_error", `tool ${tool.name}: invalid arguments: ${detail}`);
  }
  return JSON.stringify(parsed);
}

export function __resetValidatorCacheForTesting(): void {
  cache.clear();
}
