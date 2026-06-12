// Tests for the core-side settings PATCH validator. Introspects the live
// schema so the assertions survive field renames.

import { assertEquals } from "@std/assert";
import {
  isSecretSettingKey,
  SECRET_KEYS,
  settingKeyDestination,
  SETTINGS_SCHEMA,
  validateSettingsPatch,
} from "./engine.ts";
import {
  CLIENT_GROUP_IDS,
  CORE_GROUP_IDS,
  groupDestinations,
  isClientGroup,
  isCoreGroup,
} from "./types.ts";

Deno.test("group-id registry stays in sync with schema destinations (no drift)", () => {
  // CLIENT_GROUP_IDS / CORE_GROUP_IDS are hand-maintained for their literal
  // types; this is the derive-check that fails if a group's `destination` in the
  // schema ever disagrees with the registry. A multi-destination group is
  // listed in both registries.
  const schemaClient = SETTINGS_SCHEMA.filter((g) => groupDestinations(g).includes("client"))
    .map((g) => g.id)
    .sort();
  const schemaCore = SETTINGS_SCHEMA.filter((g) => groupDestinations(g).includes("core"))
    .map((g) => g.id)
    .sort();
  assertEquals(schemaClient, [...CLIENT_GROUP_IDS].sort());
  assertEquals(schemaCore, [...CORE_GROUP_IDS].sort());
  // The classifier helpers must agree with each group's declared destination(s).
  for (const g of SETTINGS_SCHEMA) {
    assertEquals(isClientGroup(g.id), groupDestinations(g).includes("client"));
    assertEquals(isCoreGroup(g.id), groupDestinations(g).includes("core"));
  }
});

Deno.test("hybrid groups label every section and give it a destination", () => {
  // A group spanning both client and core routes per section, so each section
  // must be labeled (to carry a Client/Core badge) and declare its own
  // destination (so its fields persist to the right place).
  for (const group of SETTINGS_SCHEMA) {
    if (!Array.isArray(group.destination)) continue;
    for (const section of group.sections) {
      assertEquals(
        typeof section.label === "string" && section.label.length > 0,
        true,
        `hybrid group "${group.id}" has an unlabeled section`,
      );
      assertEquals(
        section.destination === "client" || section.destination === "core",
        true,
        `section "${section.label}" in hybrid group "${group.id}" needs a destination`,
      );
    }
  }
});

Deno.test("validateSettingsPatch: accepts a well-typed core-destination value", () => {
  // tts.enabled lives in the tts group's core section (hybrid group).
  assertEquals(validateSettingsPatch({ "tts.enabled": true }), []);
});

Deno.test("validateSettingsPatch: rejects a wrong-typed known value", () => {
  assertEquals(validateSettingsPatch({ "tts.enabled": "not-a-boolean" }).length > 0, true);
});

Deno.test("validateSettingsPatch: rejects secret-typed keys (vault only)", () => {
  const secret = SECRET_KEYS[0];
  assertEquals(typeof secret, "string");
  assertEquals(validateSettingsPatch({ [secret]: "sk-leak" }).length > 0, true);
});

Deno.test("validateSettingsPatch: rejects unknown keys, allows deletions on core keys", () => {
  // The core store holds only known core-destination keys; null is a reset.
  assertEquals(validateSettingsPatch({ "totally.unknown.key": "x" }).length > 0, true);
  assertEquals(validateSettingsPatch({ "totally.unknown.key": null }).length > 0, true);
  assertEquals(validateSettingsPatch({ "llm.modelPath": null }), []);
});

Deno.test("validateSettingsPatch: rejects client-destination keys", () => {
  assertEquals(validateSettingsPatch({ "appearance.theme": "dark" }).length > 0, true);
  // The client section of a hybrid group routes to the client store too.
  assertEquals(validateSettingsPatch({ "tts.voice": "bf_emma" }).length > 0, true);
});

Deno.test("settingKeyDestination: honors group defaults and section overrides", () => {
  assertEquals(settingKeyDestination("llm.modelPath"), "core");
  // Hybrid tts group: core section vs client section.
  assertEquals(settingKeyDestination("tts.enabled"), "core");
  assertEquals(settingKeyDestination("tts.voice"), "client");
  // Client section override inside the otherwise core toolkits group.
  assertEquals(settingKeyDestination("toolkits.skipRiskyGrantWarning"), "client");
  assertEquals(settingKeyDestination("appearance.theme"), "client");
  assertEquals(settingKeyDestination("totally.unknown.key"), undefined);
});

Deno.test("isSecretSettingKey: true for password fields, false otherwise", () => {
  assertEquals(isSecretSettingKey(SECRET_KEYS[0]), true);
  assertEquals(isSecretSettingKey("definitely.not.a.secret"), false);
});
