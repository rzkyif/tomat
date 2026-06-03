/**
 * Type definitions and shared validation constants for the settings schema.
 * Used by every group file under `./groups/` and by the engine in
 * `./engine.ts`. The full schema is built from these primitives and is
 * authoritative for both the client renderer and core's setting reads.
 */

// Pulled inline so this file has zero non-type dependencies. Mirrors the
// client-side command builder's accepted command kinds.
export type CommandType = "llm" | "stt";

export type OptionsSource = "monitors" | "fonts";

export type ActivationMode = "manual" | "sticky" | "push-to-talk";

export interface SettingOption {
  value: string | number;
  label: string;
}

export interface FieldCondition {
  /** Field id to compare against. Optional only when `allOf` is set;
   *  in that case the parent acts as a pure AND wrapper around its children. */
  field?: string;
  eq?: string | number | boolean;
  neq?: string | number | boolean;
  in?: (string | number | boolean)[];
  nin?: (string | number | boolean)[];
  /** When set, all listed conditions must pass. Combines with the field-level
   *  comparison if both are present. */
  allOf?: FieldCondition[];
}

export interface PresetBadge {
  icon: string;
  label: string;
}

export interface PresetOption {
  id: string;
  label: string;
  title?: string;
  badges?: PresetBadge[];
  description?: string;
  icon?: string;
  defaults?: Record<string, string | number | boolean>;
}

export interface PresetConfig {
  options: PresetOption[];
  secondaryOptions?: PresetOption[];
}

export interface RegexValidationRule {
  regex: string;
  errorMessage: string;
}

export type RegexValidation = string | RegexValidationRule[];

// External-API URL validator: HTTPS for any host, or HTTP only for loopback.
// Used by llm.external.baseUrl, dualModel.external.baseUrl, and stt.external.baseUrl.
export const SECURE_URL_VALIDATION: RegexValidationRule[] = [
  {
    regex: "^(https://|http://(localhost|127\\.0\\.0\\.1)(:|/|$))",
    errorMessage: "URL must use HTTPS, or HTTP with localhost / 127.0.0.1 only.",
  },
];

/**
 * Common props every field carries. Anything that influences layout, search,
 * or conditional visibility but not how the field is rendered or what it
 * stores lives here.
 */
interface BaseField {
  id: string;
  name: string;
  description: string;
  visibleWhen?: FieldCondition;
  editableWhen?: FieldCondition;
  optionalWhen?: FieldCondition;
  optional?: boolean;
  /** Controls how the description is presented:
   *  - `none`: never shown (no info button).
   *  - `ondemand`: hidden behind an info-button toggle (default for non-empty descriptions).
   *  - `always`: rendered inline, always visible.
   *  When unset, falls back to `ondemand` if description is non-empty, else `none`. */
  descriptionTier?: "none" | "ondemand" | "always";
}

/** Shared shape for free-text inputs (string / password / multiline). */
interface TextLikeFieldProps {
  defaultValue: string;
  placeholder?: string;
  regex?: RegexValidation;
  suffix?: string;
}

/** Shared shape for numeric inputs (number / float). `""` is the sentinel
 *  for "unset" on `optional` numeric fields. */
interface NumberLikeFieldProps {
  defaultValue: number | string;
  placeholder?: string;
  regex?: RegexValidation;
  suffix?: string;
}

export type StringField = BaseField & TextLikeFieldProps & { type: "string" };
export type PasswordField = BaseField &
  TextLikeFieldProps & {
    type: "password";
  };
export type MultilineField = BaseField &
  TextLikeFieldProps & {
    type: "multiline";
    mono?: boolean;
  };
export type NumberField = BaseField & NumberLikeFieldProps & { type: "number" };
export type FloatField = BaseField & NumberLikeFieldProps & { type: "float" };

export type BooleanField = BaseField & {
  type: "boolean";
  defaultValue: boolean;
};
export type ColorField = BaseField & {
  type: "color";
  defaultValue: string;
  /** When set, this color only seeds a derived light/dark scale (its hue and
   *  chroma are used; the theme sets each shade's lightness). The picker hides
   *  the lightness slider and pins OKLCH L to this value, since editing
   *  lightness would have no rendered effect. Choose the light-mode lightness
   *  of the shade where the color is seen most (e.g. the default color uses the
   *  bg-surface step, ~0.985); the picker still theme-inverts it, so dark mode
   *  shows the matching dark shade. Omit for colors rendered as-is (bubbles,
   *  shadow), which keep a free lightness slider. */
  lockedLightness?: number;
};
export type ShortcutField = BaseField & {
  type: "shortcut";
  defaultValue: string;
};

/** Render-only fields whose value is ignored; defaultValue exists only so the
 *  defaults loader has a stable initial entry. */
export type RenderOnlyField = BaseField & {
  type: "services" | "storage" | "snippets" | "toolkits" | "cores";
  defaultValue: string | number | boolean;
};

export type NumberSliderField = BaseField & {
  type: "number_slider";
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
};

/** A select either supplies a static `options` list or names an `optionsSource`
 *  the UI should resolve at runtime (monitors, system fonts, etc.). The two
 *  alternatives are mutually exclusive. */
export type SelectField = BaseField & {
  type: "select";
  defaultValue: string | number;
} & (
    | { options: SettingOption[]; optionsSource?: never }
    | { optionsSource: OptionsSource; options?: never }
  );

export type PresetField = BaseField & {
  type: "preset";
  defaultValue: string;
  presetConfig: PresetConfig;
};

export type CommandPreviewField = BaseField & {
  type: "command_preview";
  defaultValue: string | boolean;
  commandType: CommandType;
};

export type SettingField =
  | StringField
  | PasswordField
  | MultilineField
  | NumberField
  | FloatField
  | BooleanField
  | ColorField
  | ShortcutField
  | RenderOnlyField
  | NumberSliderField
  | SelectField
  | PresetField
  | CommandPreviewField;

export type SettingType = SettingField["type"];

export interface SettingSection {
  /** A labeled section is collapsible: the label row is the collapse toggle.
   *  An unlabeled section renders its fields inline (always visible, no
   *  toggle). Inline sections are allowed, but a group's unlabeled sections
   *  must come first, above any labeled (collapsible) ones; never place an
   *  inline section below a collapsible one. */
  label?: string;
  visibleWhen?: FieldCondition;
  expandWhen?: FieldCondition;
  fields: SettingField[];
  /** When true, the section starts collapsed (its fields hidden behind the
   *  section header) on a fresh load and on "reset group to defaults". Only
   *  meaningful for labeled sections, since the label is the collapse toggle.
   *  Unlabeled sections always render their fields inline. */
  defaultCollapsed?: boolean;
}

/** Where the group's settings are persisted: "client" → ~/.tomat/client/settings.json
 *  via Tauri commands; "core" → ~/.tomat/core/settings.json on the
 *  currently-selected paired core via PATCH /api/v1/settings. The UI shows
 *  a chip in the group header so the user knows where their change lands. */
export type SettingDestination = "client" | "core";

export interface SettingGroup {
  id: string;
  name: string;
  /** When true, the group is omitted from the settings UI entirely (no sidebar
   *  entry, not rendered). Used for groups that exist only to register setting
   *  ids / a persistence destination (e.g. `cores`). */
  hidden?: boolean;
  /** Where this group's values are persisted. Each group is single-
   *  destination; mixed groups must be split (e.g. legacy `stt` →
   *  `stt_input` + `stt_engine`). */
  destination: SettingDestination;
  /** Filled-variant icon class. Used when the group is the active sidebar entry. */
  icon: string;
  /** Outline-variant icon class. Falls back to `icon` when the icon set has no
   *  outline equivalent (e.g. tune, call-split). */
  iconInactive?: string;
  sections: SettingSection[];
}

export type ConditionDep =
  | {
      kind: "field";
      fieldId: string;
      condition: "editableWhen" | "optionalWhen";
    }
  | {
      kind: "section";
      groupId: string;
      sectionIndex: number;
      condition: "visibleWhen" | "expandWhen";
    };

export interface SearchResultGroup {
  groupId: string;
  groupName: string;
  sectionKey: string;
  sectionLabel?: string;
  fields: SettingField[];
}

/** Sparse on-disk format: only non-defaults are serialized. Defaults come
 *  from the schema at runtime. Used by both client and core's settings.json. */
export type SettingsRecord = Record<string, unknown>;

// --- Group id registry -----------------------------------------------------
// The full set of group ids known to the schema, classified by destination.
// Used by the client persistence layer to decide which settings go where.

export const CLIENT_GROUP_IDS = [
  "appearance",
  "shortcuts",
  "snippets",
  "usage",
  "stt_input",
  "tts",
  "general",
] as const;
export type ClientGroupId = (typeof CLIENT_GROUP_IDS)[number];

export const CORE_GROUP_IDS = [
  "llm",
  "prompts",
  "dualModel",
  "toolkits",
  "stt_engine",
  "server",
] as const;
export type CoreGroupId = (typeof CORE_GROUP_IDS)[number];

export type SettingGroupId = ClientGroupId | CoreGroupId;

export function isClientGroup(id: string): id is ClientGroupId {
  return (CLIENT_GROUP_IDS as readonly string[]).includes(id);
}

export function isCoreGroup(id: string): id is CoreGroupId {
  return (CORE_GROUP_IDS as readonly string[]).includes(id);
}
