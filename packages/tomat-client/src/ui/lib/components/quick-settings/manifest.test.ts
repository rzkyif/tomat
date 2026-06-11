// Schema-drift guard for the Quick Settings manifest: every referenced field
// id must still exist in SETTINGS_SCHEMA (a rename there would otherwise
// silently drop the field from Quick Settings at runtime).

import { describe, expect, it } from "vitest";
import type { FieldCondition } from "@tomat/shared";
import { findField, isValidSettingKey } from "@tomat/shared";
import { QUICK_SETTINGS_SECTIONS } from "./manifest";

function conditionFields(cond: FieldCondition | undefined): string[] {
  if (!cond) return [];
  const out: string[] = [];
  if (cond.field !== undefined) out.push(cond.field);
  for (const sub of cond.allOf ?? []) out.push(...conditionFields(sub));
  return out;
}

describe("quick settings manifest", () => {
  it("resolves every field id against the settings schema", () => {
    for (const section of QUICK_SETTINGS_SECTIONS) {
      for (const ref of section.fields) {
        expect(findField(ref.id), `${section.id}: ${ref.id}`).toBeDefined();
      }
    }
  });

  it("uses a boolean schema field for every header toggle", () => {
    for (const section of QUICK_SETTINGS_SECTIONS) {
      if (!section.enabledField) continue;
      const field = findField(section.enabledField);
      expect(field, `${section.id}: ${section.enabledField}`).toBeDefined();
      expect(field?.type, `${section.id}: ${section.enabledField}`).toBe("boolean");
    }
  });

  it("references only known setting keys in visibility conditions", () => {
    for (const section of QUICK_SETTINGS_SECTIONS) {
      for (const ref of section.fields) {
        for (const key of conditionFields(ref.visibleWhen)) {
          expect(isValidSettingKey(key), `${section.id}: ${ref.id} -> ${key}`).toBe(true);
        }
      }
    }
  });

  it("has no duplicate field ids within a section", () => {
    for (const section of QUICK_SETTINGS_SECTIONS) {
      const ids = section.fields.map((ref) => ref.id);
      expect(new Set(ids).size, section.id).toBe(ids.length);
    }
  });

  it("keeps at least one unconditional field per section", () => {
    // The renderer has no empty-body state: a section whose every field is
    // hidden by a manifest condition would open onto nothing.
    for (const section of QUICK_SETTINGS_SECTIONS) {
      expect(
        section.fields.some((ref) => !ref.visibleWhen),
        section.id,
      ).toBe(true);
    }
  });
});
