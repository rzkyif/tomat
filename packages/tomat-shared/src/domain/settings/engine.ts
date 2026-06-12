/**
 * Declarative schema and runtime helpers for every user-tunable option.
 *
 * The schema is composed from per-group modules under `./groups/`; shared
 * types and validation constants live in `./types.ts`. Both the client
 * renderer and core's setting reads consume this module. It's the single
 * source of truth for what setting keys exist, what they default to, and
 * which destination ("client" or "core") they're persisted to.
 */

import type {
  ConditionDep,
  FieldCondition,
  RegexValidation,
  SearchResultGroup,
  SettingDestination,
  SettingField,
  SettingGroup,
  SettingSection,
} from "./types.ts";
import { groupDestinations } from "./types.ts";
import type { RequiredModelRef } from "../model.ts";

import { generalGroup } from "./groups/general.ts";
import { shortcutsGroup } from "./groups/shortcuts.ts";
import { appearanceGroup } from "./groups/appearance.ts";
import { llmGroup } from "./groups/llm.ts";
import { promptsGroup } from "./groups/prompts.ts";
import { snippetsGroup } from "./groups/snippets.ts";
import { toolkitsGroup, toolsGroup } from "./groups/toolkits.ts";
import { dualModelGroup } from "./groups/dual-model.ts";
import { sttGroup } from "./groups/stt.ts";
import { ttsGroup } from "./groups/tts.ts";
import { usageGroup } from "./groups/usage.ts";
import { coresGroup } from "./groups/cores.ts";

// Kokoro TTS assets are fetched into ~/.tomat/models/<repo>/... by the
// core downloader. transformers.js's `dtype: "q8"` expects an ONNX file
// named `model_quantized.onnx` (see DEFAULT_DTYPE_SUFFIX_MAPPING in
// dtypes.js); the repo ships that variant, so we download it rather than
// `model_q8f16.onnx`.
export const TTS_REPO = "@onnx-community/Kokoro-82M-v1.0-ONNX/main";
export const TTS_BASE_FILES: readonly string[] = [
  `${TTS_REPO}/config.json`,
  `${TTS_REPO}/tokenizer.json`,
  `${TTS_REPO}/tokenizer_config.json`,
  `${TTS_REPO}/onnx/model_quantized.onnx`,
];

// Embedding model for toolkit tool-relevance RAG. Fetched into
// ~/.tomat/models/Xenova/all-MiniLM-L6-v2/... so transformers.js can
// resolve it via env.localModelPath without ever hitting the network at
// runtime. dtype "q8" is used at load time to pick the
// `model_quantized.onnx` variant (same convention as Kokoro).
export const EMBED_REPO = "@Xenova/all-MiniLM-L6-v2/main";
export const EMBED_BASE_FILES: readonly string[] = [
  `${EMBED_REPO}/config.json`,
  `${EMBED_REPO}/tokenizer.json`,
  `${EMBED_REPO}/tokenizer_config.json`,
  `${EMBED_REPO}/onnx/model_quantized.onnx`,
];

function isHfSpec(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("@") && v.length > 1;
}

/** Model files (HF specs) the current settings require, tagged with their
 *  requirement group. The single source of truth consumed by both the core
 *  (`sourcesForKind` / requirements) and the client. llm local → modelPath
 *  (+ mmproj if image support); stt enabled+local → modelPath; tts (when
 *  enabled) → base files; embed → base files (always, for tool-relevance RAG). */
export function requiredModelRefs(s: Record<string, unknown>): RequiredModelRef[] {
  const out: RequiredModelRef[] = [];
  const llmLocal = s["llm.provider"] !== "external";
  const sttActive = !!s["stt.enabled"] && s["stt.provider"] !== "external";
  const imagesOn = !!s["llm.supportImages"];

  const llmModel = s["llm.modelPath"];
  if (llmLocal && isHfSpec(llmModel)) out.push({ source: llmModel, group: "llm" });
  const mmproj = s["llm.mmprojPath"];
  if (llmLocal && imagesOn && isHfSpec(mmproj)) out.push({ source: mmproj, group: "llm" });
  const sttModel = s["stt.modelPath"];
  if (sttActive && isHfSpec(sttModel)) out.push({ source: sttModel, group: "stt" });
  if (s["tts.enabled"]) {
    for (const f of TTS_BASE_FILES) out.push({ source: f, group: "tts" });
  }
  for (const f of EMBED_BASE_FILES) out.push({ source: f, group: "embed" });
  return out;
}

export const SETTINGS_SCHEMA: SettingGroup[] = [
  generalGroup,
  shortcutsGroup,
  appearanceGroup,
  llmGroup,
  promptsGroup,
  snippetsGroup,
  toolkitsGroup,
  toolsGroup,
  dualModelGroup,
  sttGroup,
  ttsGroup,
  usageGroup,
  coresGroup,
];

// Settings whose values are routed to the OS keychain rather than to
// settings.json. Derived from the schema so adding a `type: "password"`
// field automatically opts it in, with no manifest update needed.
export const SECRET_KEYS: readonly string[] = (() => {
  const out: string[] = [];
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (field.type === "password") out.push(field.id);
      }
    }
  }
  return out;
})();

/**
 * Every setting field id known to the schema. Derived at import time so a
 * rename here doesn't require updating a hand-maintained list elsewhere.
 * Useful for: runtime validation of `currentSettings` lookups in dev, and
 * dependency-graph traversal.
 */
export const SETTING_IDS: readonly string[] = (() => {
  const out: string[] = [];
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        out.push(field.id);
      }
    }
  }
  return out;
})();

const SETTING_ID_SET: ReadonlySet<string> = new Set(SETTING_IDS);

/** True if `key` matches a field id in `SETTINGS_SCHEMA`. */
export function isValidSettingKey(key: string): boolean {
  return SETTING_ID_SET.has(key);
}

// Per-field persistence destination, honoring hybrid groups: a section's
// `destination` overrides its group's first listed destination (see
// groupDestinations). Built lazily once; the schema is immutable after import.
let _keyDestinations: Map<string, SettingDestination> | null = null;

function keyDestinations(): Map<string, SettingDestination> {
  if (_keyDestinations) return _keyDestinations;
  const map = new Map<string, SettingDestination>();
  for (const group of SETTINGS_SCHEMA) {
    const groupDest = groupDestinations(group)[0];
    for (const section of group.sections) {
      const dest = section.destination ?? groupDest;
      for (const field of section.fields) map.set(field.id, dest);
    }
  }
  _keyDestinations = map;
  return map;
}

/** Persistence destination ("client" or "core") for a schema field id,
 *  honoring per-section overrides in hybrid groups. Undefined for unknown
 *  keys. The single routing truth for both the client save path and core's
 *  PATCH validation. */
export function settingKeyDestination(key: string): SettingDestination | undefined {
  return keyDestinations().get(key);
}

export function getDefaultSettings(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (
          field.type !== "command_preview" &&
          field.type !== "services" &&
          field.type !== "storage" &&
          field.type !== "object_management"
        ) {
          defaults[field.id] = field.defaultValue;
        }
      }
    }
  }
  return defaults;
}

/** True when a section should be rendered in non-search mode. A section only
 *  disappears when it has no fields; per-field `visibleWhen` is applied by the
 *  renderer. (Collapse is a separate, purely-UI concern; a collapsed section is
 *  still "visible" here, just rendered header-only.) */
export function isSectionVisible(section: SettingSection): boolean {
  return section.fields.length > 0;
}

/** True when a group should appear in the settings UI. */
export function isGroupVisible(group: SettingGroup): boolean {
  return !group.hidden;
}

/** The set of section keys (`${groupId}-${sectionIndex}`) that are expanded by
 *  default: every labeled section in a non-hidden group that isn't flagged
 *  `defaultCollapsed`. Used to seed the Settings panel on mount and to restore
 *  a group's default expand/collapse state. Unlabeled sections render their
 *  fields inline (no collapse), so they're omitted. */
export function defaultExpandedSections(): Set<string> {
  const expanded = new Set<string>();
  for (const group of SETTINGS_SCHEMA) {
    if (group.hidden) continue;
    group.sections.forEach((section, si) => {
      if (section.label && !section.defaultCollapsed) {
        expanded.add(`${group.id}-${si}`);
      }
    });
  }
  return expanded;
}

export function evalCondition(
  cond: FieldCondition | undefined,
  currentSettings: Record<string, unknown>,
): boolean {
  if (!cond) return true;
  if (cond.field !== undefined) {
    const val = currentSettings[cond.field];
    if (cond.eq !== undefined && val !== cond.eq) return false;
    if (cond.neq !== undefined && val === cond.neq) return false;
    if (cond.in !== undefined && !cond.in.includes(val as string | number | boolean)) {
      return false;
    }
    if (cond.nin !== undefined && cond.nin.includes(val as string | number | boolean)) {
      return false;
    }
  }
  if (cond.allOf) {
    for (const sub of cond.allOf) {
      if (!evalCondition(sub, currentSettings)) return false;
    }
  }
  return true;
}

export function findField(fieldId: string): SettingField | undefined {
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (field.id === fieldId) return field;
      }
    }
  }
  return undefined;
}

// --- Condition dependency map ---
// Maps a setting key to the field/section IDs whose conditions depend on it.
// Built once from the schema so that handleChange can efficiently find what
// to re-evaluate without scanning the entire schema on every change.

let _conditionDeps: Map<string, ConditionDep[]> | null = null;

export function getConditionDeps(): Map<string, ConditionDep[]> {
  if (_conditionDeps) return _conditionDeps;

  const deps = new Map<string, ConditionDep[]>();

  function add(key: string, dep: ConditionDep) {
    let list = deps.get(key);
    if (!list) {
      list = [];
      deps.set(key, list);
    }
    list.push(dep);
  }

  // Walk a condition (including any nested `allOf` children) and yield each
  // field id it depends on. Used so a single setting change can re-evaluate
  // every dependent field/section regardless of how deeply nested.
  function fieldsOf(cond: FieldCondition | undefined): string[] {
    if (!cond) return [];
    const out: string[] = [];
    if (cond.field !== undefined) out.push(cond.field);
    if (cond.allOf) {
      for (const sub of cond.allOf) out.push(...fieldsOf(sub));
    }
    return out;
  }

  for (const group of SETTINGS_SCHEMA) {
    for (let si = 0; si < group.sections.length; si++) {
      const section = group.sections[si];
      for (const field of fieldsOf(section.visibleWhen)) {
        add(field, {
          kind: "section",
          groupId: group.id,
          sectionIndex: si,
          condition: "visibleWhen",
        });
      }
      for (const field of fieldsOf(section.expandWhen)) {
        add(field, {
          kind: "section",
          groupId: group.id,
          sectionIndex: si,
          condition: "expandWhen",
        });
      }
      for (const f of section.fields) {
        for (const field of fieldsOf(f.editableWhen)) {
          add(field, {
            kind: "field",
            fieldId: f.id,
            condition: "editableWhen",
          });
        }
        for (const field of fieldsOf(f.optionalWhen)) {
          add(field, {
            kind: "field",
            fieldId: f.id,
            condition: "optionalWhen",
          });
        }
      }
    }
  }

  _conditionDeps = deps;
  return deps;
}

/** Returns the set of field IDs that are controlled by any preset in a given group. */
export function getPresetFieldIds(groupId: string): Set<string> {
  const ids = new Set<string>();
  const group = SETTINGS_SCHEMA.find((g) => g.id === groupId);
  if (!group) return ids;
  for (const section of group.sections) {
    for (const field of section.fields) {
      if (
        (field.type !== "preset" && field.type !== "model_preset" && field.type !== "stt_preset") ||
        !field.presetConfig
      ) {
        continue;
      }
      const allOptions = [
        ...field.presetConfig.options,
        ...(field.presetConfig.secondaryOptions || []),
      ];
      for (const opt of allOptions) {
        if (opt.defaults) {
          for (const key of Object.keys(opt.defaults)) {
            ids.add(key);
          }
        }
      }
      for (const key of field.presetConfig.managedKeys ?? []) {
        ids.add(key);
      }
    }
  }
  return ids;
}

/** Search all settings fields by query string, grouped by section. Skips
 *  sections/fields whose visibility conditions fail against the current
 *  settings. */
export function searchFields(
  query: string,
  currentSettings: Record<string, unknown>,
): SearchResultGroup[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: SearchResultGroup[] = [];

  for (const group of SETTINGS_SCHEMA) {
    for (let si = 0; si < group.sections.length; si++) {
      const section = group.sections[si];
      if (!evalCondition(section.visibleWhen, currentSettings)) continue;

      const matched: SettingField[] = [];
      for (const field of section.fields) {
        // command_preview is a derived display, not user-targetable; the
        // services/storage display panels and object_management managers
        // (snippets/toolkits/cores) have no atomic field-level state to surface
        // in search results, and a manager is a full scrolling surface that
        // doesn't render sensibly inline, so they're excluded.
        if (
          field.type === "command_preview" ||
          field.type === "services" ||
          field.type === "storage" ||
          field.type === "object_management"
        ) {
          continue;
        }
        if (!evalCondition(field.visibleWhen, currentSettings)) continue;
        if (fieldMatchesQuery(field, q)) {
          matched.push(field);
        }
      }

      if (matched.length > 0) {
        results.push({
          groupId: group.id,
          groupName: group.name,
          sectionKey: `${group.id}-${si}`,
          sectionLabel: section.label,
          fields: matched,
        });
      }
    }
  }

  return results;
}

function fieldMatchesQuery(field: SettingField, q: string): boolean {
  if (field.name.toLowerCase().includes(q)) return true;
  // description is optional on object_management fields (it lives on the group).
  if (field.description?.toLowerCase().includes(q)) return true;

  if (field.type === "select" && field.options) {
    for (const opt of field.options) {
      if (opt.label.toLowerCase().includes(q)) return true;
    }
  }

  if (field.type === "preset" || field.type === "model_preset" || field.type === "stt_preset") {
    for (const opt of field.presetConfig.options) {
      if (opt.label.toLowerCase().includes(q)) return true;
    }
    if (field.presetConfig.secondaryOptions) {
      for (const opt of field.presetConfig.secondaryOptions) {
        if (opt.label.toLowerCase().includes(q)) return true;
      }
    }
  }

  return false;
}

/** True when `value` is type-compatible with `field`'s declared `type`.
 *  Used by core-side PATCH /settings validation so a client can't persist a
 *  wrong-typed value that would later break core or flow into a sidecar
 *  argument. Render-only fields hold no persisted scalar, so they pass. */
function settingValueTypeOk(field: SettingField, value: unknown): boolean {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "float":
    case "number_slider":
      return typeof value === "number" && Number.isFinite(value);
    case "select":
      return typeof value === "string" || typeof value === "number";
    case "command_preview":
      return typeof value === "string" || typeof value === "boolean";
    case "string":
    case "password":
    case "multiline":
    case "color":
    case "shortcut":
    case "preset":
    case "model_preset":
    case "stt_preset":
      return typeof value === "string";
    case "services":
    case "storage":
    case "object_management":
      return true;
  }
}

/**
 * Validate a PATCH body destined for the core settings store
 * (`PATCH /api/v1/settings`). Returns a list of human-readable errors; an
 * empty list means the patch is acceptable. Rules:
 *   - every key must be a known schema key with a core destination: the core
 *     store never holds client-side or unknown keys.
 *   - secret-typed keys (password fields) are rejected: their values belong in
 *     the encrypted vault via the secrets endpoint, never in settings.json.
 *   - render-only fields (command preview, services, storage, object
 *     management) hold no persistable scalar and are rejected.
 *   - `null`/`undefined` values are deletions (reset to default) and are OK on
 *     any accepted key.
 *   - values are type-checked (and regex-checked for text fields) so a
 *     malformed value can't be persisted.
 */
export function validateSettingsPatch(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const secretSet = new Set<string>(SECRET_KEYS);
  for (const [key, value] of Object.entries(patch)) {
    if (!isValidSettingKey(key)) {
      errors.push(`"${key}" is not a known setting`);
      continue;
    }
    if (secretSet.has(key)) {
      errors.push(`"${key}" is a secret and must be set via the secrets endpoint, not settings`);
      continue;
    }
    if (settingKeyDestination(key) !== "core") {
      errors.push(`"${key}" is not a core-destination setting`);
      continue;
    }
    const field = findField(key);
    if (!field) continue;
    if (
      field.type === "command_preview" ||
      field.type === "services" ||
      field.type === "storage" ||
      field.type === "object_management"
    ) {
      errors.push(`"${key}" is a render-only field and holds no persisted value`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (!settingValueTypeOk(field, value)) {
      errors.push(`"${key}" has the wrong type for a "${field.type}" setting`);
      continue;
    }
    if (
      (field.type === "string" || field.type === "password" || field.type === "multiline") &&
      field.regex
    ) {
      const re = getValidationError(field.regex, value);
      if (re) errors.push(`"${key}": ${re}`);
    }
  }
  return errors;
}

/** True if `key` names a secret-typed (password) setting whose value must be
 *  stored in the encrypted vault and never returned over the API. */
export function isSecretSettingKey(key: string): boolean {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

export function getValidationError(regex: RegexValidation, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;

  const strValue = String(value);

  if (typeof regex === "string") {
    try {
      if (!new RegExp(regex).test(strValue)) {
        return "Invalid format";
      }
    } catch {
      return "Invalid regex pattern";
    }
  } else if (Array.isArray(regex)) {
    for (const rule of regex) {
      try {
        if (!new RegExp(rule.regex).test(strValue)) {
          return rule.errorMessage;
        }
      } catch {
        return "Invalid regex pattern";
      }
    }
  }
  return null;
}
