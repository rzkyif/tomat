/**
 * Declarative schema and defaults for every user-tunable option. The
 * settings UI, the defaults loader, and the persistence layer all read
 * from this single source of truth so a new option only needs to be added
 * in one place.
 *
 * The schema itself is composed from per-group modules under `./groups/`;
 * shared types and validation constants live in `./types`.
 */

import type {
  FieldCondition,
  RegexValidation,
  SettingField,
  SettingGroup,
  SettingSection,
  ConditionDep,
  SearchResultGroup,
} from "./types";

import { generalGroup } from "./groups/general";
import { shortcutsGroup } from "./groups/shortcuts";
import { appearanceGroup } from "./groups/appearance";
import { llmGroup } from "./groups/llm";
import { promptsGroup } from "./groups/prompts";
import { snippetsGroup } from "./groups/snippets";
import { toolkitsGroup } from "./groups/toolkits";
import { dualModelGroup } from "./groups/dualModel";
import { sttGroup } from "./groups/stt";
import { ttsGroup } from "./groups/tts";
import { usageGroup } from "./groups/usage";

export * from "./types";

// Kokoro TTS assets are fetched into ~/.tomat/models/<repo>/... by the existing
// downloader. transformers.js's `dtype: "q8"` expects an ONNX file named
// `model_quantized.onnx` (see DEFAULT_DTYPE_SUFFIX_MAPPING in dtypes.js); the
// repo ships that variant, so we download it rather than `model_q8f16.onnx`.
export const TTS_REPO = "@onnx-community/Kokoro-82M-v1.0-ONNX/main";
export const TTS_BASE_FILES: readonly string[] = [
  `${TTS_REPO}/config.json`,
  `${TTS_REPO}/tokenizer.json`,
  `${TTS_REPO}/tokenizer_config.json`,
  `${TTS_REPO}/onnx/model_quantized.onnx`,
];

// Embedding model for toolkit tool-relevance RAG. Fetched into
// ~/.tomat/models/Xenova/all-MiniLM-L6-v2/... by the shared Rust downloader so
// transformers.js can resolve it via env.localModelPath without ever hitting
// the network at runtime. dtype "q8" is used at load time to pick the
// `model_quantized.onnx` variant (same convention as Kokoro).
export const EMBED_REPO = "@Xenova/all-MiniLM-L6-v2/main";
export const EMBED_BASE_FILES: readonly string[] = [
  `${EMBED_REPO}/config.json`,
  `${EMBED_REPO}/tokenizer.json`,
  `${EMBED_REPO}/tokenizer_config.json`,
  `${EMBED_REPO}/onnx/model_quantized.onnx`,
];

export const SETTINGS_SCHEMA: SettingGroup[] = [
  generalGroup,
  shortcutsGroup,
  appearanceGroup,
  llmGroup,
  promptsGroup,
  snippetsGroup,
  toolkitsGroup,
  dualModelGroup,
  sttGroup,
  ttsGroup,
  usageGroup,
];

// Settings whose values are routed to the OS keychain rather than to
// ~/.tomat/settings.json. Derived from the schema so adding a `type: "password"`
// field automatically opts it in - no Rust or manifest update needed.
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

export function getDefaultSettings(): Record<string, any> {
  const defaults: Record<string, any> = {};
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (
          field.type !== "command_preview" &&
          field.type !== "services" &&
          field.type !== "storage" &&
          field.type !== "snippets" &&
          field.type !== "toolkits"
        ) {
          defaults[field.id] = field.defaultValue;
        }
      }
    }
  }
  return defaults;
}

/** True when a field/section pair should be visible given the user's
 *  advanced-settings preference. Advanced sections hide every child; an
 *  advanced field hides itself even within a non-advanced section. */
export function isFieldVisible(
  field: SettingField,
  section: SettingSection,
  showAdvanced: boolean,
): boolean {
  if (showAdvanced) return true;
  if (section.advanced) return false;
  return !field.advanced;
}

/** True when a section should be rendered in non-search mode. Advanced
 *  sections hide entirely when `showAdvanced` is false; otherwise the
 *  section is hidden only if all of its fields are advanced. */
export function isSectionVisible(section: SettingSection, showAdvanced: boolean): boolean {
  if (showAdvanced) return true;
  if (section.advanced) return false;
  return section.fields.some((f) => !f.advanced);
}

/** True when a group should appear in the sidebar in non-search mode. */
export function isGroupVisible(group: SettingGroup, showAdvanced: boolean): boolean {
  if (showAdvanced) return true;
  return group.sections.some((s) => isSectionVisible(s, showAdvanced));
}

export function evalCondition(
  cond: FieldCondition | undefined,
  currentSettings: Record<string, any>,
): boolean {
  if (!cond) return true;
  if (cond.field !== undefined) {
    const val = currentSettings[cond.field];
    if (cond.eq !== undefined && val !== cond.eq) return false;
    if (cond.neq !== undefined && val === cond.neq) return false;
    if (cond.in !== undefined && !cond.in.includes(val)) return false;
    if (cond.nin !== undefined && cond.nin.includes(val)) return false;
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
// Built once from the schema so that handleChange can efficiently find what to
// re-evaluate without scanning the entire schema on every change.

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
      if (field.type !== "preset" || !field.presetConfig) continue;
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
    }
  }
  return ids;
}

/** Search all settings fields by query string, grouped by section. Skips sections/fields
 * whose visibility conditions fail against the current settings. */
export function searchFields(
  query: string,
  currentSettings: Record<string, any>,
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
        if (
          field.type === "command_preview" ||
          field.type === "services" ||
          field.type === "storage" ||
          field.type === "snippets" ||
          field.type === "toolkits"
        )
          continue;
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
  if (field.description.toLowerCase().includes(q)) return true;

  if (field.type === "select" && field.options) {
    for (const opt of field.options) {
      if (opt.label.toLowerCase().includes(q)) return true;
    }
  }

  if (field.type === "preset") {
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

export function getValidationError(regex: RegexValidation, value: any): string | null {
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
