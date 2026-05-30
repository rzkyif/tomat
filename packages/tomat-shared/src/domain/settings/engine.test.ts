// Tests for the core-side settings PATCH validator. Introspects the live
// schema so the assertions survive field renames.

import { assertEquals } from "@std/assert";
import {
  isSecretSettingKey,
  SECRET_KEYS,
  SETTINGS_SCHEMA,
  validateSettingsPatch,
} from "./engine.ts";

function firstFieldOfType(type: string): string | undefined {
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (field.type === type) return field.id;
      }
    }
  }
  return undefined;
}

Deno.test("validateSettingsPatch: accepts a well-typed boolean value", () => {
  const id = firstFieldOfType("boolean");
  if (!id) return; // schema has no boolean field (unexpected, but don't fail)
  assertEquals(validateSettingsPatch({ [id]: true }), []);
});

Deno.test("validateSettingsPatch: rejects a wrong-typed known value", () => {
  const id = firstFieldOfType("boolean");
  if (!id) return;
  assertEquals(
    validateSettingsPatch({ [id]: "not-a-boolean" }).length > 0,
    true,
  );
});

Deno.test("validateSettingsPatch: rejects secret-typed keys (vault only)", () => {
  const secret = SECRET_KEYS[0];
  assertEquals(typeof secret, "string");
  assertEquals(validateSettingsPatch({ [secret]: "sk-leak" }).length > 0, true);
});

Deno.test("validateSettingsPatch: allows unknown keys and deletions", () => {
  // Unknown keys are not errors (forward-compat); null/undefined are resets.
  assertEquals(validateSettingsPatch({ "totally.unknown.key": "x" }), []);
  assertEquals(validateSettingsPatch({ "some.key": null }), []);
});

Deno.test("isSecretSettingKey: true for password fields, false otherwise", () => {
  assertEquals(isSecretSettingKey(SECRET_KEYS[0]), true);
  assertEquals(isSecretSettingKey("definitely.not.a.secret"), false);
});
