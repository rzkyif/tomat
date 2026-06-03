import { assertEquals, assertThrows } from "@std/assert";
import type { Tool } from "@tomat/shared";
import { __resetValidatorCacheForTesting, validateAndNormalizeToolArgs } from "./validate-args.ts";
import { AppError } from "../shared/errors.ts";

function tool(parameters: Record<string, unknown>, id = "tk::t"): Tool {
  return {
    id,
    toolkitId: "tk",
    name: "t",
    description: "",
    parameters,
    triggers: [],
    fnExport: "t",
    alwaysAvailable: false,
    enabled: true,
    requiredPermissions: [],
    missingRequired: [],
    grants: [],
  };
}

Deno.test("validateAndNormalizeToolArgs: fills schema defaults", () => {
  __resetValidatorCacheForTesting();
  const t = tool({
    type: "object",
    properties: { unit: { type: "string", default: "celsius" }, city: { type: "string" } },
    required: ["city"],
  });
  assertEquals(JSON.parse(validateAndNormalizeToolArgs(t, JSON.stringify({ city: "Paris" }))), {
    city: "Paris",
    unit: "celsius",
  });
});

Deno.test("validateAndNormalizeToolArgs: rejects a missing required property", () => {
  __resetValidatorCacheForTesting();
  const t = tool({ type: "object", properties: { city: { type: "string" } }, required: ["city"] });
  assertThrows(() => validateAndNormalizeToolArgs(t, "{}"), AppError, "invalid arguments");
});

Deno.test("validateAndNormalizeToolArgs: rejects non-JSON arguments", () => {
  __resetValidatorCacheForTesting();
  assertThrows(
    () => validateAndNormalizeToolArgs(tool({ type: "object" }), "{not json"),
    AppError,
    "not valid JSON",
  );
});

Deno.test("validateAndNormalizeToolArgs: empty args become an empty object (with defaults)", () => {
  __resetValidatorCacheForTesting();
  const t = tool({ type: "object", properties: { x: { type: "number", default: 5 } } });
  assertEquals(JSON.parse(validateAndNormalizeToolArgs(t, "")), { x: 5 });
});

Deno.test("validateAndNormalizeToolArgs: recompiles when the schema changes for the same tool id", () => {
  __resetValidatorCacheForTesting();
  const id = "tk::t";
  assertEquals(
    JSON.parse(
      validateAndNormalizeToolArgs(
        tool({ type: "object", properties: { a: { type: "string", default: "x" } } }, id),
        "{}",
      ),
    ),
    { a: "x" },
  );
  // Same id, different schema must not reuse the stale validator.
  assertEquals(
    JSON.parse(
      validateAndNormalizeToolArgs(
        tool({ type: "object", properties: { b: { type: "string", default: "y" } } }, id),
        "{}",
      ),
    ),
    { b: "y" },
  );
});

Deno.test("validateAndNormalizeToolArgs: an unusable schema passes args through unchanged", () => {
  __resetValidatorCacheForTesting();
  // `type: "nonsense"` is not a valid JSON-Schema type; compile fails and we
  // fall back to passing the raw args rather than wedging the call.
  const raw = JSON.stringify({ anything: true });
  assertEquals(validateAndNormalizeToolArgs(tool({ type: "nonsense" }), raw), raw);
});
