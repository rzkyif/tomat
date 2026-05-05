/**
 * Declarative schema and defaults for every user-tunable option. The
 * settings UI, the defaults loader, and the persistence layer all read
 * from this single source of truth so a new option only needs to be added
 * in one place.
 */

/**
 * Defines every user-tunable setting the app has, grouped into the sections
 * the settings UI renders. The schema, default values, and validation
 * rules all live here so adding a new option only takes a change in one
 * place.
 */

import type { CommandType } from "./command";
import {
  TOOL_ONLY_PROMPT,
  ASSISTANT_PROMPT,
  DEFAULT_TITLE_GENERATION_PROMPT,
  DEFAULT_AUTOCORRECT_PROMPT,
  DEFAULT_MERGE_TRANSCRIPTION_PROMPT,
  DEFAULT_COMPLEXITY_DETECTION_PROMPT,
  DEFAULT_CONTEXT_TEMPLATE,
} from "./prompts";

export type SettingType =
  | "boolean"
  | "string"
  | "number"
  | "float"
  | "select"
  | "monitor"
  | "preset"
  | "command_preview"
  | "password"
  | "multiline"
  | "services"
  | "storage"
  | "snippets"
  | "toolkits"
  | "shortcut"
  | "color"
  | "number_slider";

export type ActivationMode = "manual" | "sticky" | "push-to-talk";

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
// Used by llm.external.baseUrl and stt.external.baseUrl.
const SECURE_URL_VALIDATION: RegexValidationRule[] = [
  {
    regex: "^(https://|http://(localhost|127\\.0\\.0\\.1)(:|/|$))",
    errorMessage: "URL must use HTTPS, or HTTP with localhost / 127.0.0.1 only.",
  },
];

export interface SettingField {
  id: string;
  name: string;
  description: string;
  type: SettingType;
  defaultValue: string | number | boolean;
  options?: SettingOption[];
  placeholder?: string;
  presetConfig?: PresetConfig;
  commandType?: CommandType;
  visibleWhen?: FieldCondition;
  editableWhen?: FieldCondition;
  optionalWhen?: FieldCondition;
  regex?: RegexValidation;
  optional?: boolean;
  suffix?: string;
  /** For `number_slider`: min/max/step bounds for the range slider and the
   *  numeric input. Ignored by other field types. */
  min?: number;
  max?: number;
  step?: number;
  /** When true, hidden unless `appearance.settings.showAdvanced` is on.
   *  Search results always include advanced fields regardless. */
  advanced?: boolean;
  /** Controls how the description is presented:
   *  - `none`: never shown (no info button).
   *  - `ondemand`: hidden behind an info-button toggle (default for non-empty descriptions).
   *  - `always`: rendered inline, always visible.
   *  When unset, falls back to `ondemand` if description is non-empty, else `none`. */
  descriptionTier?: "none" | "ondemand" | "always";
}

export interface SettingSection {
  label?: string;
  collapsible?: boolean;
  visibleWhen?: FieldCondition;
  expandWhen?: FieldCondition;
  fields: SettingField[];
  /** When true, the entire section is hidden unless advanced settings are shown. */
  advanced?: boolean;
}

export interface SettingGroup {
  id: string;
  name: string;
  /** Filled-variant icon class. Used when the group is the active sidebar entry. */
  icon: string;
  /** Outline-variant icon class. Falls back to `icon` when the icon set has no
   *  outline equivalent (e.g. tune, call-split). */
  iconInactive?: string;
  sections: SettingSection[];
}

export const SETTINGS_SCHEMA: SettingGroup[] = [
  {
    id: "general",
    name: "General",
    icon: "i-material-symbols-tune-rounded",
    iconInactive: "i-material-symbols-tune-rounded",
    sections: [
      {
        label: "Context",
        fields: [
          {
            id: "general.context.userName",
            name: "Your Name",
            description: "How the agent should address you.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Alex",
            descriptionTier: "none",
          },
          {
            id: "general.context.agentName",
            name: "Agent Name",
            description:
              "A name for the agent. Leave empty to let the agent pick or stay nameless.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Sebastian",
            descriptionTier: "ondemand",
          },
          {
            id: "general.context.language",
            name: "Language",
            description: "The language you prefer to communicate in.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. English",
            descriptionTier: "none",
          },
          {
            id: "general.context.locationAuto",
            name: "Auto-Detect Location",
            description:
              "Derive your location from the system timezone instead of typing it manually.\nFully offline, no network calls, no permissions.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
          {
            id: "general.context.location",
            name: "Location",
            description:
              "A location the agent can reference. Sent as plain text. No network calls.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. San Francisco, CA",
            visibleWhen: { field: "general.context.locationAuto", eq: false },
            descriptionTier: "none",
          },
          {
            id: "general.context.dateTime",
            name: "Share Current Date and Time",
            description: "Attach the current date and time to the system prompt.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "none",
          },
          {
            id: "general.context.os",
            name: "Share Operating System",
            description: "Attach your operating system to the system prompt.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "none",
          },
        ],
      },
      {
        label: "Sessions",
        fields: [
          {
            id: "general.session.alwaysStartNew",
            name: "Start Fresh Each Time",
            description:
              "When the app starts, always begin a new empty session instead of resuming the last one.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
          {
            id: "general.session.storeSessions",
            name: "Save Chat History",
            description:
              "Persist messages and session titles to disk.\nWhen disabled, sessions live only in memory and are cleared when the app closes.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
  {
    id: "shortcuts",
    name: "Shortcuts",
    icon: "i-material-symbols-keyboard-rounded",
    iconInactive: "i-material-symbols-keyboard-outline-rounded",
    sections: [
      {
        label: "Global",
        fields: [
          {
            id: "shortcuts.toggleWindow",
            name: "Show / Hide Window",
            description: "Click the field and press a key combination to set it. Clear to disable.",
            type: "shortcut",
            defaultValue: "super+ctrl+shift+z",
            optional: true,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Input",
        fields: [
          {
            id: "shortcuts.attachFile",
            name: "Attach File",
            description:
              "Open the file picker to attach a file to the next message.\nOnly active while the chat input is focused.",
            type: "shortcut",
            defaultValue: "super+ctrl+shift+a",
            optional: true,
            descriptionTier: "ondemand",
          },
          {
            id: "shortcuts.captureScreen",
            name: "Capture Full Screen",
            description:
              "Capture the primary monitor as an image attachment.\nOnly active while the chat input is focused.",
            type: "shortcut",
            defaultValue: "super+ctrl+shift+s",
            optional: true,
            descriptionTier: "ondemand",
          },
          {
            id: "shortcuts.captureRegion",
            name: "Capture Screen Area",
            description:
              "Open the region-capture overlay so you can drag-select a rectangle to attach.\nOnly active while the chat input is focused.",
            type: "shortcut",
            defaultValue: "super+ctrl+shift+x",
            optional: true,
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
  {
    id: "appearance",
    name: "Appearance",
    icon: "i-material-symbols-palette",
    iconInactive: "i-material-symbols-palette-outline",
    sections: [
      {
        label: "Theme",
        fields: [
          {
            id: "appearance.theme",
            name: "Theme",
            description: "Choose between light, dark, or system-matching theme.",
            type: "select",
            defaultValue: "auto",
            options: [
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "auto", label: "Auto (System)" },
            ],
            descriptionTier: "none",
          },
          {
            id: "appearance.textSize",
            name: "Text Size",
            description: "Base text size for the entire app.\nAccepted range: 12–32 pixels.",
            type: "number",
            defaultValue: 18,
            suffix: "px",
            regex: [
              {
                regex: "^(?:1[2-9]|2[0-9]|3[0-2])$",
                errorMessage: "Must be between 12 and 32",
              },
            ],
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Bubbles",
        fields: [
          {
            id: "appearance.userBubbleColor",
            name: "User Bubble Color",
            description:
              "Color of your message bubbles. Light/dark variants are derived automatically; the picker reflects the current theme but only the light value is saved. Supports transparency via the alpha slider.",
            type: "color",
            defaultValue: "#86efacff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.agentBubbleColor",
            name: "Agent Bubble Color",
            description: "Color of agent message bubbles when the primary model is used.",
            type: "color",
            defaultValue: "#93c5fdff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.secondaryAgentBubbleColor",
            name: "Secondary Agent Bubble Color",
            description:
              "Color of agent message bubbles when the secondary model is used (if dual model is enabled).",
            type: "color",
            defaultValue: "#d8b4feff",
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Theme Colors",
        fields: [
          {
            id: "appearance.defaultColor",
            name: "Default Color",
            description:
              "Source color for the entire neutral scale used across the app (backgrounds, borders, text, etc.). All nine light shades and their dark variants are derived from this single hex via OKLCH lightness adjustments. Pick a desaturated near-gray for a classic neutral, or a tinted hex for a themed app.",
            type: "color",
            defaultValue: "#737373ff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.systemMessageDefaultColor",
            name: "System Message Override",
            description:
              "Override the default color for system-message bubbles (reasoning, tool call, relevant tools). Set alpha to 0 (fully transparent) to inherit the global Default Color.",
            type: "color",
            defaultValue: "#00000000",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.userInputDefaultColor",
            name: "User Input Override",
            description:
              "Override the default color for the user input area at the bottom. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
            type: "color",
            defaultValue: "#00000000",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.sessionBarDefaultColor",
            name: "Session Bar Override",
            description:
              "Override the default color for the session bar. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
            type: "color",
            defaultValue: "#00000000",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.settingsDefaultColor",
            name: "Settings Override",
            description:
              "Override the default color for the settings panel. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
            type: "color",
            defaultValue: "#00000000",
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Accent Colors",
        fields: [
          {
            id: "appearance.accentRed",
            name: "Red Accent",
            description:
              "Source color for the red accent scale (used for errors and destructive actions). All shades are derived from this hex.",
            type: "color",
            defaultValue: "#ef4444ff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.accentBlue",
            name: "Blue Accent",
            description:
              "Source color for the blue accent scale. All shades are derived from this hex.",
            type: "color",
            defaultValue: "#3b82f6ff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.accentPurple",
            name: "Purple Accent",
            description:
              "Source color for the purple accent scale. All shades are derived from this hex.",
            type: "color",
            defaultValue: "#a855f7ff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.accentGreen",
            name: "Green Accent",
            description:
              "Source color for the green accent scale (used for success states). All shades are derived from this hex.",
            type: "color",
            defaultValue: "#22c55eff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.accentOrange",
            name: "Orange Accent",
            description:
              "Source color for the orange accent scale (used for warnings/loading). All shades are derived from this hex.",
            type: "color",
            defaultValue: "#f97316ff",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.accentYellow",
            name: "Yellow Accent",
            description:
              "Source color for the yellow accent scale. All shades are derived from this hex.",
            type: "color",
            defaultValue: "#eab308ff",
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Roundedness",
        fields: [
          {
            id: "appearance.roundedSmall",
            name: "Small Roundedness",
            description: "Corner radius used by smaller chrome (code blocks, ToolCall internals).",
            type: "number_slider",
            defaultValue: 6,
            min: 0,
            max: 16,
            step: 1,
            suffix: "px",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.roundedMedium",
            name: "Medium Roundedness",
            description:
              "Corner radius used by inputs, form controls, and small cards (FieldCard, MultilineField, etc.).",
            type: "number_slider",
            defaultValue: 8,
            min: 0,
            max: 20,
            step: 1,
            suffix: "px",
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.roundedLarge",
            name: "Large Roundedness",
            description:
              "Corner radius used by message bubbles, modals, and prominent surfaces (SessionBar, system messages).",
            type: "number_slider",
            defaultValue: 16,
            min: 0,
            max: 32,
            step: 1,
            suffix: "px",
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Animations",
        fields: [
          {
            id: "appearance.animationsEnabled",
            name: "Enable Animations",
            description:
              "Smoothly animate message entry, settings transitions, and expandable sections.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "none",
          },
          {
            id: "appearance.animationSpeedMultiplier",
            name: "Animation Speed",
            description:
              "Speed multiplier for all UI animations.\nHigher values = faster. Accepted range: 25–400%.",
            type: "number",
            defaultValue: 100,
            suffix: "%",
            editableWhen: { field: "appearance.animationsEnabled", eq: true },
            regex: [
              {
                regex: "^(?:2[5-9]|[3-9][0-9]|[1-3][0-9]{2}|400)$",
                errorMessage: "Must be between 25 and 400",
              },
            ],
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Window",
        fields: [
          {
            id: "layout.monitor",
            name: "Monitor",
            description: "Choose which monitor to display the app on.",
            type: "monitor",
            defaultValue: "primary",
            descriptionTier: "none",
          },
          {
            id: "layout.alignment",
            name: "Window Alignment",
            description: "Align the window to the left, center, or right of the monitor.",
            type: "select",
            defaultValue: "center",
            options: [
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" },
            ],
            descriptionTier: "none",
          },
          {
            id: "layout.width",
            name: "Window Width",
            description: "Width of the app window.\nAccepted range: 400–1200 pixels.",
            type: "number",
            defaultValue: 700,
            suffix: "px",
            regex: [
              {
                regex: "^(?:4[0-9]{2}|[5-9][0-9]{2}|1[01][0-9]{2}|1200)$",
                errorMessage: "Must be between 400 and 1200",
              },
            ],
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Settings UI",
        fields: [
          {
            id: "appearance.settings.showAdvanced",
            name: "Show Advanced Settings",
            description: "Reveal advanced and technical settings throughout this panel.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
          {
            id: "appearance.settings.sidebarCollapsed",
            name: "Collapse Settings Sidebar",
            description: "Shrink the settings sidebar to a thin icon strip.",
            type: "boolean",
            defaultValue: false,
            advanced: true,
            descriptionTier: "none",
          },
          {
            id: "appearance.settings.horizontalThreshold",
            name: "Horizontal Layout Threshold",
            description:
              "Container width at which fields switch to a horizontal layout (label left, input right).\nAccepted range: 400–2999 pixels.",
            type: "number",
            defaultValue: 450,
            suffix: "px",
            advanced: true,
            descriptionTier: "ondemand",
            regex: [
              {
                regex: "^([4-9][0-9]{2}|[12][0-9]{3})$",
                errorMessage: "Must be between 400 and 2999",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "llm",
    name: "Language Model",
    icon: "i-material-symbols-psychology-rounded",
    iconInactive: "i-material-symbols-psychology-outline-rounded",
    sections: [
      {
        label: "General",
        fields: [
          {
            id: "llm.supportImages",
            name: "Image Attachments",
            description:
              "Allow attaching images to messages.\nRequires a vision-capable model when running locally.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.showReasoning",
            name: "Show Thinking Process",
            description:
              "Display the model's reasoning in a collapsible section above each response.\nSaved with the session but never sent back to the model.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Provider",
        fields: [
          {
            id: "llm.provider",
            name: "Provider",
            description:
              "Where the language model runs.\n\nLocal: runs on this machine.\n\nExternal: sent to an OpenAI-compatible API.",
            type: "select",
            defaultValue: "local",
            options: [
              { value: "local", label: "Local" },
              { value: "external", label: "External" },
            ],
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Model",
        visibleWhen: { field: "llm.provider", eq: "local" },
        fields: [
          {
            id: "llm.preset",
            name: "Preset",
            description:
              "Pick a starter model. Selecting a preset replaces the model paths and tuning below. Editing any of those settings switches this to Custom.",
            type: "preset",
            defaultValue: "0.8b",
            presetConfig: {
              options: [
                {
                  id: "0.8b",
                  label: "0.8B",
                  title: "Qwen 3.5 0.8B",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~1 GB RAM" },
                    { icon: "i-material-symbols-bolt-rounded", label: "Fastest" },
                    { icon: "i-material-symbols-lightbulb-outline-rounded", label: "Basic" },
                  ],
                  description:
                    "Lightweight and quick. Good for short questions, simple chat, and machines with limited memory.\n\nStruggles with multi-step reasoning or long contexts.",
                  defaults: {
                    "llm.modelPath": "@unsloth/Qwen3.5-0.8B-GGUF/main/Qwen3.5-0.8B-Q4_K_M.gguf",
                    "llm.mmprojPath": "@unsloth/Qwen3.5-0.8B-GGUF/main/mmproj-F16.gguf",
                    "llm.contextSize": 4096,
                    "llm.mmap": true,
                    "llm.threads": 4,
                    "llm.reasoning": "off",
                    "llm.reasoningBudget": "",
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
                {
                  id: "2b",
                  label: "2B",
                  title: "Qwen 3.5 2B",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~2 GB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Balanced" },
                    { icon: "i-material-symbols-psychology-rounded", label: "Reasoning" },
                  ],
                  description:
                    "A balanced default with reasoning enabled. Handles most everyday tasks comfortably on a modern laptop.",
                  defaults: {
                    "llm.modelPath": "@unsloth/Qwen3.5-2B-GGUF/main/Qwen3.5-2B-Q4_K_M.gguf",
                    "llm.mmprojPath": "@unsloth/Qwen3.5-2B-GGUF/main/mmproj-F16.gguf",
                    "llm.contextSize": 8192,
                    "llm.mmap": true,
                    "llm.threads": 4,
                    "llm.reasoning": "on",
                    "llm.reasoningBudget": 512,
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
                {
                  id: "5b-e2b",
                  label: "5B E2B",
                  title: "Gemma 4 5B E2B",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~5 GB RAM" },
                    { icon: "i-material-symbols-hourglass-top-rounded", label: "Slower" },
                    { icon: "i-material-symbols-psychology-alt-rounded", label: "Smartest" },
                  ],
                  description:
                    "Best reasoning and answer quality. Recommended when you have the RAM to spare and want the strongest responses.\n\nSlower to first token.",
                  defaults: {
                    "llm.modelPath": "@unsloth/gemma-4-E2B-it-GGUF/main/gemma-4-E2B-it-Q4_K_M.gguf",
                    "llm.mmprojPath": "@unsloth/gemma-4-E2B-it-GGUF/main/mmproj-F16.gguf",
                    "llm.contextSize": 8192,
                    "llm.mmap": true,
                    "llm.threads": 6,
                    "llm.reasoning": "on",
                    "llm.reasoningBudget": 512,
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  title: "Custom",
                  badges: [{ icon: "i-material-symbols-build-rounded", label: "Manual setup" }],
                  description: "Configure model path, context size, threads, and ports yourself.",
                },
              ],
            },
          },
        ],
      },
      {
        label: "Llama Server Configuration",
        visibleWhen: {
          allOf: [
            { field: "llm.provider", eq: "local" },
            { field: "llm.preset", eq: "custom" },
          ],
        },
        fields: [
          {
            id: "llm.modelPath",
            name: "Model Path",
            description: "Path to the GGUF model file.",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/Qwen3.5-0.8B-Q4_K_M.gguf",
            descriptionTier: "ondemand",
          },
          {
            id: "llm.mmprojPath",
            name: "Vision Module Path",
            description: "Path to the mmproj GGUF file used for vision support.",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/mmproj-F16.gguf",
            placeholder: "@user/repo/branch/mmproj-f16.gguf",
            visibleWhen: { field: "llm.supportImages", eq: true },
            optionalWhen: { field: "llm.supportImages", eq: false },
            descriptionTier: "ondemand",
          },
          {
            id: "llm.contextSize",
            name: "Context Window Size",
            description: "Maximum context window length in tokens.",
            type: "number",
            defaultValue: 4096,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.threads",
            name: "Processor Cores",
            description: "Number of CPU threads used for inference.",
            type: "number",
            defaultValue: 4,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.reasoning",
            name: "Reasoning Mode",
            description: "Whether the model should produce a reasoning trace before its answer.",
            type: "select",
            defaultValue: "off",
            options: [
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
              { value: "auto", label: "Auto" },
            ],
            optional: true,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.reasoningBudget",
            name: "Max Thinking Tokens",
            description: "Number of tokens reserved for the reasoning trace.",
            type: "number",
            defaultValue: "",
            visibleWhen: { field: "llm.reasoning", neq: "off" },
            optional: true,
            placeholder: "optional",
            descriptionTier: "ondemand",
          },
          {
            id: "llm.mmap",
            name: "Memory-Mapped Loading",
            description:
              "Use memory-mapped I/O when loading the model.\n\nFaster startup and lower RAM usage in most cases. Disable if you see stability issues on unusual filesystems.",
            type: "boolean",
            defaultValue: true,
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "llm.host",
            name: "Host",
            description: "Server bind address.",
            type: "string",
            defaultValue: "127.0.0.1",
            regex: [
              {
                regex:
                  "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
                errorMessage: "Must be a valid IPv4 address",
              },
            ],
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "llm.port",
            name: "Port",
            description: "Server listen port.",
            type: "string",
            defaultValue: "7701",
            regex: [
              { regex: "^\\d+$", errorMessage: "Port must be a number" },
              {
                regex:
                  "^(?:[1-9]\\d{0,4}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5])$",
                errorMessage: "Port must be 1–65535",
              },
            ],
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "llm.webui",
            name: "Built-in Web UI",
            description: "Enable the llama.cpp built-in web interface.",
            type: "boolean",
            defaultValue: false,
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.commandPreview",
            name: "Command Preview",
            description: "",
            type: "command_preview",
            defaultValue: "",
            commandType: "llm",
            advanced: true,
          },
        ],
      },
      {
        label: "External Provider",
        visibleWhen: { field: "llm.provider", eq: "external" },
        fields: [
          {
            id: "llm.external.baseUrl",
            name: "Base URL",
            description:
              "API endpoint URL. Must use HTTPS for remote hosts; HTTP is only allowed for localhost.",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
            regex: SECURE_URL_VALIDATION,
            descriptionTier: "ondemand",
          },
          {
            id: "llm.external.apiKey",
            name: "API Key",
            description: "Authentication key.",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
            descriptionTier: "none",
          },
          {
            id: "llm.external.model",
            name: "Model",
            description: "Model identifier to use.",
            type: "string",
            defaultValue: "",
            placeholder: "gpt-4o-mini",
            descriptionTier: "none",
          },
          {
            id: "llm.external.contextSize",
            name: "Context Window Size",
            description: "Maximum context window length in tokens. Used for usage tracking.",
            type: "number",
            defaultValue: 128000,
            advanced: true,
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
  {
    id: "prompts",
    name: "Prompts",
    icon: "i-material-symbols-chat-bubble-rounded",
    iconInactive: "i-material-symbols-chat-bubble-outline-rounded",
    sections: [
      {
        label: "Default System Prompt",
        fields: [
          {
            id: "prompts.defaultSystemPrompt.preset",
            name: "Preset",
            description:
              "Pick a starter system prompt sent at the start of every chat. Selecting a preset replaces the prompt text below. Editing the prompt switches this to Custom.",
            type: "preset",
            defaultValue: "disabled",
            presetConfig: {
              options: [
                {
                  id: "disabled",
                  label: "None",
                  title: "None",
                  description:
                    "No system prompt is sent. The model runs with its default behavior.",
                  defaults: { "prompts.defaultSystemPrompt": "" },
                },
                {
                  id: "tool-only",
                  label: "Tool Only",
                  title: "Tool Only",
                  description:
                    "Forces short, cautious replies and a strong preference for tool use. Suited to small on-device models that cannot reason reliably on their own.",
                  defaults: { "prompts.defaultSystemPrompt": TOOL_ONLY_PROMPT },
                },
                {
                  id: "assistant",
                  label: "Assistant",
                  title: "Assistant",
                  description:
                    "A professional, capable general-purpose assistant that answers directly and uses tools when helpful.",
                  defaults: { "prompts.defaultSystemPrompt": ASSISTANT_PROMPT },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  title: "Custom",
                  description:
                    "Write your own system prompt. Editing the prompt manually switches to this option automatically.",
                },
              ],
            },
          },
          {
            id: "prompts.defaultSystemPrompt",
            name: "Default System Prompt",
            description:
              "The system prompt sent to the agent.\nEditing this manually switches the preset to Custom.",
            type: "multiline",
            defaultValue: "",
            optional: true,
            visibleWhen: { field: "prompts.defaultSystemPrompt.preset", eq: "custom" },
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
      {
        fields: [
          {
            id: "prompts.showSystemPrompt",
            name: "Show System Prompt Bubble",
            description:
              "Display the active system prompt as a collapsible bubble at the top of each session.\nThe bubble updates to reflect any snippet-triggered changes.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Context Template",
        advanced: true,
        fields: [
          {
            id: "prompts.contextTemplate",
            name: "Context Template",
            description:
              "Template appended to the system prompt when any context setting (agent name, language, location, date/time, OS, etc.) is enabled.\nUse `{name}` for placeholders and `[name:body]` for conditional segments that disappear when the named setting is unset. Available names: agentName, language, userName, location, dateTime, os.",
            type: "multiline",
            defaultValue: DEFAULT_CONTEXT_TEMPLATE,
            regex: [{ regex: "\\S", errorMessage: "Template cannot be empty" }],
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
      {
        label: "Title Generation",
        advanced: true,
        fields: [
          {
            id: "prompts.titleGenerationPrompt",
            name: "Title Generation Prompt",
            description:
              "Prompt used to auto-generate a short session title from the first user message.",
            type: "multiline",
            defaultValue: DEFAULT_TITLE_GENERATION_PROMPT,
            regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
      {
        label: "Autocorrect",
        advanced: true,
        fields: [
          {
            id: "prompts.autocorrectPrompt",
            name: "Autocorrect Prompt",
            description:
              "Prompt used to clean up speech-to-text transcriptions before they reach the chat input.",
            type: "multiline",
            defaultValue: DEFAULT_AUTOCORRECT_PROMPT,
            regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
      {
        label: "Merge Transcription",
        advanced: true,
        fields: [
          {
            id: "prompts.mergeTranscriptionPrompt",
            name: "Merge Transcription Prompt",
            description:
              "Prompt used to merge a fresh speech-to-text transcription into the existing text already in the chat input.",
            type: "multiline",
            defaultValue: DEFAULT_MERGE_TRANSCRIPTION_PROMPT,
            regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
      {
        label: "Complexity Detection",
        advanced: true,
        fields: [
          {
            id: "prompts.complexityDetectionPrompt",
            name: "Complexity Detection Prompt",
            description:
              "System prompt used by the default model to classify each new user message before it is answered.\nThe reply is matched case-insensitively: if it contains the word `complex` without `simple` the request is routed to the secondary model, otherwise it stays on the default model. A reply that is ambiguous or empty falls back to the default model.",
            type: "multiline",
            defaultValue: DEFAULT_COMPLEXITY_DETECTION_PROMPT,
            regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
            advanced: true,
            descriptionTier: "always",
          },
        ],
      },
    ],
  },
  {
    id: "snippets",
    name: "Snippets",
    icon: "i-material-symbols-text-snippet-rounded",
    iconInactive: "i-material-symbols-text-snippet-outline-rounded",
    sections: [
      {
        fields: [
          {
            id: "prompts.snippets",
            name: "Snippets",
            description:
              "Reusable text fragments triggered via @trigger in the chat input. Snippets can prepend, append, replace, or insert text into either the user message or the system prompt.",
            type: "snippets",
            defaultValue: "",
            descriptionTier: "always",
          },
        ],
      },
    ],
  },
  {
    id: "toolkits",
    name: "Tools",
    icon: "i-material-symbols-build-rounded",
    iconInactive: "i-material-symbols-build-outline-rounded",
    sections: [
      {
        fields: [
          {
            id: "tools.enabled",
            name: "Enable Tool Use",
            description:
              "Allow trusted toolkits to inject tools into each chat turn.\nWhen on, relevant tools are added to the model request, letting it call them mid-turn.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
          {
            id: "toolkits.list",
            name: "Installed Toolkits",
            description:
              "Drop a .ts file or folder into ~/.tomat/toolkits/, press Refresh, then Trust/Install/Enable.\nOnly trusted + enabled toolkits contribute tools to the agent.",
            type: "toolkits",
            defaultValue: "",
            visibleWhen: { field: "tools.enabled", eq: true },
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Tool Selection",
        advanced: true,
        visibleWhen: { field: "tools.enabled", eq: true },
        fields: [
          {
            id: "tools.filteringEnabled",
            name: "Enable Relevance Filtering",
            description:
              "Filter the available toolset down to a relevance-ranked shortlist before each turn (embedding similarity + optional AI second pass).\nDisable to send every enabled tool to the model on every turn. Simpler, but eats more context and slows down small models when many toolkits are installed.",
            type: "boolean",
            defaultValue: true,
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "tools.filteringMinTools",
            name: "Skip Filtering If Fewer Tools",
            description:
              "Skip filtering and send all enabled tools to the model when the total tool count is below this number.\nUseful when you only have a handful of tools and would rather not pay the embedding+AI cost. Set to 0 to always filter.",
            type: "number",
            defaultValue: 0,
            regex: [{ regex: "^([0-9]|[1-9][0-9]{1,2}|1000)$", errorMessage: "Must be 0-1000" }],
            visibleWhen: { field: "tools.filteringEnabled", eq: true },
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tools.alwaysAvailableEnabled",
            name: "Bypass Filter for Essential Tools",
            description:
              "When on, tools whose toolkit declares `alwaysAvailable: true` skip the relevance filter and are always sent to the model.\nOnly takes effect when filtering is enabled; disabling filtering already sends every tool, so the bypass is redundant.",
            type: "boolean",
            defaultValue: true,
            visibleWhen: { field: "tools.filteringEnabled", eq: true },
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "tools.maxTools",
            name: "Max Tools Per Turn",
            description:
              "Cap on tools passed to the main model. When the AI filter is enabled, applied after filtering as a final cap; when disabled, applied directly to the embedding-similarity ranking.",
            type: "number",
            defaultValue: 30,
            regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
            visibleWhen: { field: "tools.filteringEnabled", eq: true },
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tools.secondPassEnabled",
            name: "Use AI to Refine Tool Selection",
            description:
              "Run a second-pass AI filter to drop clearly unrelated tools after the embedding-similarity pass.\nDisable to use only embedding similarity ranking truncated to Max Tools.",
            type: "boolean",
            defaultValue: true,
            visibleWhen: { field: "tools.filteringEnabled", eq: true },
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tools.filterReasoning",
            name: "Filter Reasoning Mode",
            description:
              "Whether the second-pass filter should produce a reasoning trace before its answer.\nMay improve filtering accuracy on borderline cases but slows down responses.",
            type: "select",
            defaultValue: "off",
            options: [
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
              { value: "auto", label: "Auto" },
            ],
            visibleWhen: {
              allOf: [
                { field: "tools.filteringEnabled", eq: true },
                { field: "tools.secondPassEnabled", eq: true },
              ],
            },
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tools.filterReasoningBudget",
            name: "Max Tokens for Filter Thinking",
            description: "Number of tokens reserved for the filter reasoning trace.",
            type: "number",
            defaultValue: "",
            visibleWhen: {
              allOf: [
                { field: "tools.filteringEnabled", eq: true },
                { field: "tools.filterReasoning", neq: "off" },
              ],
            },
            optional: true,
            placeholder: "optional",
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tools.maxHops",
            name: "Max Tool Calls Per Message",
            description:
              "Hard cap on consecutive tool-call rounds within a single user turn.\nProtects against runaway loops when a tool's output keeps the model requesting more calls.",
            type: "number",
            defaultValue: 5,
            regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
            advanced: true,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Worker Pool",
        advanced: true,
        visibleWhen: { field: "tools.enabled", eq: true },
        fields: [
          {
            id: "toolkits.maxWarmWorkers",
            name: "Max Active Tool Processes",
            description:
              "Maximum number of toolkit workers kept alive at once.\nHigher values reduce cold-start latency; lower values cap resident memory when hundreds of toolkits are enabled.",
            type: "number",
            defaultValue: 8,
            regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "toolkits.workerIdleMs",
            name: "Unload Inactive Tools After",
            description:
              "Terminate a warm worker after this long with no tool calls.\nShorter values free memory faster; longer values keep frequently-used toolkits warm.",
            type: "number",
            defaultValue: 300000,
            suffix: "ms",
            regex: [{ regex: "^[0-9]+$", errorMessage: "Must be a non-negative integer" }],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "toolkits.callTimeoutMs",
            name: "Tool Call Timeout",
            description:
              "Hard upper bound for a single tool call before it is aborted with an error.\nThe timer is paused while a tool is waiting for user input, so a slow human response never causes a timeout. Set to 0 to disable.",
            type: "number",
            defaultValue: 60000,
            suffix: "ms",
            regex: [{ regex: "^[0-9]+$", errorMessage: "Must be a non-negative integer" }],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "toolkits.ignorePostinstallScripts",
            name: "Ignore Postinstall Scripts",
            description:
              "Pass `--ignore-scripts` to `bun install` so dependency postinstall hooks don't run.\nRecommended on: postinstall scripts from transitive dependencies are a common vector for surprise code execution. Disable only if a toolkit's dependencies require native builds.",
            type: "boolean",
            defaultValue: true,
            advanced: true,
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
  {
    id: "dualModel",
    name: "Dual Model",
    icon: "i-material-symbols-call-split-rounded",
    iconInactive: "i-material-symbols-call-split-rounded",
    sections: [
      {
        fields: [
          {
            id: "dualModel.enabled",
            name: "Enable Dual Model",
            description:
              "Route complex prompts to a stronger external model while keeping simple prompts on the default model.\nThe detection prompt is configured in the Prompts group.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Secondary Model",
        visibleWhen: { field: "dualModel.enabled", eq: true },
        fields: [
          {
            id: "dualModel.external.baseUrl",
            name: "Base URL",
            description:
              "API endpoint URL. Must use HTTPS for remote hosts; HTTP is only allowed for localhost.",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
            regex: SECURE_URL_VALIDATION,
            descriptionTier: "ondemand",
          },
          {
            id: "dualModel.external.apiKey",
            name: "API Key",
            description: "Authentication key.",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
            descriptionTier: "none",
          },
          {
            id: "dualModel.external.model",
            name: "Model",
            description: "Model identifier to use.",
            type: "string",
            defaultValue: "",
            placeholder: "gpt-4o",
            descriptionTier: "none",
          },
          {
            id: "dualModel.external.contextSize",
            name: "Context Window Size",
            description: "Maximum context window length, used for usage tracking.",
            type: "number",
            defaultValue: 128000,
            advanced: true,
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
  {
    id: "stt",
    name: "Speech-to-Text",
    icon: "i-material-symbols-mic-rounded",
    iconInactive: "i-material-symbols-mic-outline-rounded",
    sections: [
      {
        fields: [
          {
            id: "stt.enabled",
            name: "Enable Speech-to-Text",
            description:
              "Allow voice dictation via the microphone button or push-to-talk shortcut.\nWhen disabled, the whisper server does not start, the mic button is hidden, and all sub-settings are inactive.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Transcription",
        visibleWhen: { field: "stt.enabled", eq: true },
        fields: [
          {
            id: "stt.llmAutocorrect",
            name: "Clean Up Transcription",
            description:
              "Use the language model to clean up transcription mistakes after speech recognition.\n\nDisable if you prefer raw output or want to save a model call per dictation.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.llmChainTranscription",
            name: "Merge Voice Into Existing Text",
            description:
              "When text is already in the input, use the language model to merge a new transcription into it rather than replacing it.\n\nDisable to always append as a new line.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.autoSend",
            name: "Auto Send After Transcription",
            description: "Automatically send the message as soon as transcription completes.",
            type: "boolean",
            defaultValue: true,
            descriptionTier: "none",
          },
        ],
      },
      {
        label: "Voice Input",
        visibleWhen: { field: "stt.enabled", eq: true },
        fields: [
          {
            id: "stt.activation",
            name: "Microphone Mode",
            description:
              "How the microphone is activated.\n\nManual: use the mic button. Voice input turns off whenever the app is hidden or closed.\n\nSticky: use the mic button. Voice input stays on through hides, closes, and restarts.\n\nPush to Talk: hold the global shortcut to dictate. Quick taps show or hide the window instead.",
            type: "select",
            defaultValue: "push-to-talk",
            options: [
              { value: "manual", label: "Manual" },
              { value: "sticky", label: "Sticky" },
              { value: "push-to-talk", label: "Push to Talk" },
            ],
            descriptionTier: "ondemand",
          },
          {
            id: "stt.holdDuration",
            name: "Push-to-Talk Hold Time",
            description:
              "Delay before push-to-talk activates while holding the shortcut.\nTaps shorter than this show or hide the app instead.",
            type: "number",
            defaultValue: 250,
            suffix: "ms",
            visibleWhen: { field: "stt.activation", eq: "push-to-talk" },
            descriptionTier: "ondemand",
          },
          {
            id: "stt.autoVolumeEnabled",
            name: "Lower Volume While Listening",
            description:
              "Drop the system output volume to a configurable level while voice input is active, then restore it when listening stops.\nUseful for letting your own voice be heard over media playback.",
            type: "boolean",
            defaultValue: false,
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.autoVolumeTarget",
            name: "Lowered Volume Level",
            description:
              "System volume to apply while voice input is listening.\nAccepted range: 0 to 100.",
            type: "number",
            defaultValue: 20,
            suffix: "%",
            visibleWhen: { field: "stt.autoVolumeEnabled", eq: true },
            regex: [
              { regex: "^(?:[0-9]|[1-9][0-9]|100)$", errorMessage: "Must be between 0 and 100" },
            ],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.vadPersistedState",
            name: "VAD Persisted State",
            description: "",
            type: "boolean",
            defaultValue: false,
            visibleWhen: { field: "stt.activation", eq: "__never__" },
            descriptionTier: "none",
          },
        ],
      },
      {
        label: "Provider",
        visibleWhen: { field: "stt.enabled", eq: true },
        fields: [
          {
            id: "stt.provider",
            name: "Provider",
            description:
              "Where speech-to-text runs.\n\nLocal: runs on this machine.\n\nExternal: audio is sent to an OpenAI-compatible transcription API.",
            type: "select",
            defaultValue: "local",
            options: [
              { value: "local", label: "Local" },
              { value: "external", label: "External" },
            ],
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Model",
        visibleWhen: {
          allOf: [
            { field: "stt.enabled", eq: true },
            { field: "stt.provider", eq: "local" },
          ],
        },
        fields: [
          {
            id: "stt.preset",
            name: "Preset",
            description:
              "Pick a starter model. Selecting a preset replaces the model path and decoding settings below. Editing any of those settings switches this to Custom.",
            type: "preset",
            defaultValue: "small",
            presetConfig: {
              options: [
                {
                  id: "distil-small-en",
                  label: "Distil Small",
                  title: "Distil-Whisper Small (English)",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~350 MB RAM" },
                    { icon: "i-material-symbols-bolt-rounded", label: "Fastest" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Good accuracy" },
                    { icon: "i-material-symbols-translate-rounded", label: "English only" },
                  ],
                  description:
                    "Distilled English-only model. Very fast with low memory use, great for live dictation.",
                  defaults: {
                    "stt.modelPath":
                      "@distil-whisper/distil-small.en/main/ggml-distil-small.en.bin",
                    "stt.threads": 4,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "distil-medium-en",
                  label: "Distil Medium",
                  title: "Distil-Whisper Medium (English)",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~800 MB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Fast" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Solid accuracy" },
                    { icon: "i-material-symbols-translate-rounded", label: "English only" },
                  ],
                  description:
                    "Distilled English-only Medium. Keeps Medium-class accuracy with noticeably lower latency.",
                  defaults: {
                    "stt.modelPath":
                      "@distil-whisper/distil-medium.en/main/ggml-medium-32-2.en.bin",
                    "stt.threads": 4,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "small",
                  label: "Small",
                  title: "Whisper Small",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~1 GB RAM" },
                    { icon: "i-material-symbols-bolt-rounded", label: "Fast" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Good accuracy" },
                    { icon: "i-material-symbols-language", label: "Multilingual" },
                  ],
                  description:
                    "Solid all-round transcription for clear speech. Runs well on most hardware.",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-small.bin",
                    "stt.threads": 4,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "distil-large-v3",
                  label: "Distil Large v3",
                  title: "Distil-Whisper Large v3 (English)",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~1.5 GB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Fast" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Best accuracy" },
                    { icon: "i-material-symbols-translate-rounded", label: "English only" },
                  ],
                  description:
                    "Distilled English-only Large v3. Top-tier English accuracy at Medium-class cost.",
                  defaults: {
                    "stt.modelPath":
                      "@distil-whisper/distil-large-v3-ggml/main/ggml-distil-large-v3.bin",
                    "stt.threads": 6,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "large-v3-turbo-q8",
                  label: "Large v3 Turbo",
                  title: "Whisper Large v3 Turbo (Q8)",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~2 GB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Balanced" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Best accuracy" },
                    { icon: "i-material-symbols-language", label: "Multilingual" },
                  ],
                  description:
                    "Quantized Turbo build of Large v3. Near-Large accuracy at a fraction of the size and latency.",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-large-v3-turbo-q8_0.bin",
                    "stt.threads": 8,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "medium",
                  label: "Medium",
                  title: "Whisper Medium",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~2.5 GB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Balanced" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Solid accuracy" },
                    { icon: "i-material-symbols-language", label: "Multilingual" },
                  ],
                  description:
                    "More accurate with accents or background noise. A good default on modern machines.",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-medium.bin",
                    "stt.threads": 6,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  title: "Custom",
                  badges: [{ icon: "i-material-symbols-build-rounded", label: "Manual setup" }],
                  description: "Configure model path, threads, and ports yourself.",
                },
              ],
            },
          },
        ],
      },
      {
        label: "Whisper Server Configuration",
        visibleWhen: {
          allOf: [
            { field: "stt.enabled", eq: true },
            { field: "stt.provider", eq: "local" },
            { field: "stt.preset", eq: "custom" },
          ],
        },
        fields: [
          {
            id: "stt.modelPath",
            name: "Model Path",
            description: "Path to the Whisper model file.",
            type: "string",
            defaultValue: "@ggerganov/whisper.cpp/main/ggml-small.bin",
            descriptionTier: "ondemand",
          },
          {
            id: "stt.threads",
            name: "Processor Cores",
            description: "Number of CPU threads used for inference.",
            type: "number",
            defaultValue: 4,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.host",
            name: "Host",
            description: "Server bind address.",
            type: "string",
            defaultValue: "127.0.0.1",
            regex: [
              {
                regex:
                  "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
                errorMessage: "Must be a valid IPv4 address",
              },
            ],
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "stt.port",
            name: "Port",
            description: "Server listen port.",
            type: "string",
            defaultValue: "7702",
            regex: [
              { regex: "^\\d+$", errorMessage: "Port must be a number" },
              {
                regex:
                  "^(?:[1-9]\\d{0,4}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5])$",
                errorMessage: "Port must be 1–65535",
              },
            ],
            advanced: true,
            descriptionTier: "always",
          },
          {
            id: "stt.commandPreview",
            name: "Command Preview",
            description: "",
            type: "command_preview",
            defaultValue: "",
            commandType: "stt",
            advanced: true,
          },
        ],
      },
      {
        label: "External Provider",
        visibleWhen: {
          allOf: [
            { field: "stt.enabled", eq: true },
            { field: "stt.provider", eq: "external" },
          ],
        },
        fields: [
          {
            id: "stt.external.baseUrl",
            name: "Base URL",
            description:
              "API endpoint URL. Must use HTTPS for remote hosts; HTTP is only allowed for localhost.",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
            regex: SECURE_URL_VALIDATION,
            descriptionTier: "ondemand",
          },
          {
            id: "stt.external.apiKey",
            name: "API Key",
            description: "Authentication key.",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
            descriptionTier: "none",
          },
          {
            id: "stt.external.model",
            name: "Model",
            description: "Model identifier to use.",
            type: "string",
            defaultValue: "",
            placeholder: "whisper-1",
            descriptionTier: "none",
          },
        ],
      },
    ],
  },
  {
    id: "tts",
    name: "Text-to-Speech",
    icon: "i-material-symbols-volume-up-rounded",
    iconInactive: "i-material-symbols-volume-up-outline-rounded",
    sections: [
      {
        fields: [
          {
            id: "tts.enabled",
            name: "Enable Text-to-Speech",
            description:
              "Read assistant responses aloud as they stream.\nKeeps the voice model loaded in memory while enabled and frees it on disable.",
            type: "boolean",
            defaultValue: false,
            descriptionTier: "ondemand",
          },
          {
            id: "tts.spellOutEmojis",
            name: "Spell Out Emojis",
            description:
              "Pass emojis through to the voice model so it pronounces them.\nWhen disabled (default), emojis are stripped before synthesis.",
            type: "boolean",
            defaultValue: false,
            visibleWhen: { field: "tts.enabled", eq: true },
            descriptionTier: "ondemand",
          },
        ],
      },
      {
        label: "Voice",
        visibleWhen: { field: "tts.enabled", eq: true },
        fields: [
          {
            id: "tts.voice",
            name: "Voice",
            description:
              "Voice model used for speech synthesis.\nSelecting a voice downloads its file the first time it is used.",
            type: "select",
            defaultValue: "af_bella",
            descriptionTier: "ondemand",
            options: [
              { value: "af_alloy", label: "American • Female • Alloy" },
              { value: "af_aoede", label: "American • Female • Aoede" },
              { value: "af_bella", label: "American • Female • Bella" },
              { value: "af_heart", label: "American • Female • Heart" },
              { value: "af_jessica", label: "American • Female • Jessica" },
              { value: "af_kore", label: "American • Female • Kore" },
              { value: "af_nicole", label: "American • Female • Nicole" },
              { value: "af_nova", label: "American • Female • Nova" },
              { value: "af_river", label: "American • Female • River" },
              { value: "af_sarah", label: "American • Female • Sarah" },
              { value: "af_sky", label: "American • Female • Sky" },
              { value: "am_adam", label: "American • Male • Adam" },
              { value: "am_echo", label: "American • Male • Echo" },
              { value: "am_eric", label: "American • Male • Eric" },
              { value: "am_fenrir", label: "American • Male • Fenrir" },
              { value: "am_liam", label: "American • Male • Liam" },
              { value: "am_michael", label: "American • Male • Michael" },
              { value: "am_onyx", label: "American • Male • Onyx" },
              { value: "am_puck", label: "American • Male • Puck" },
              { value: "am_santa", label: "American • Male • Santa" },
              { value: "bf_alice", label: "British • Female • Alice" },
              { value: "bf_emma", label: "British • Female • Emma" },
              { value: "bf_isabella", label: "British • Female • Isabella" },
              { value: "bf_lily", label: "British • Female • Lily" },
              { value: "bm_daniel", label: "British • Male • Daniel" },
              { value: "bm_fable", label: "British • Male • Fable" },
              { value: "bm_george", label: "British • Male • George" },
              { value: "bm_lewis", label: "British • Male • Lewis" },
              { value: "jf_alpha", label: "Japanese • Female • Alpha" },
              { value: "jf_gongitsune", label: "Japanese • Female • Gongitsune" },
              { value: "jf_nezumi", label: "Japanese • Female • Nezumi" },
              { value: "jf_tebukuro", label: "Japanese • Female • Tebukuro" },
              { value: "jm_kumo", label: "Japanese • Male • Kumo" },
              { value: "zf_xiaobei", label: "Mandarin • Female • Xiaobei" },
              { value: "zf_xiaoni", label: "Mandarin • Female • Xiaoni" },
              { value: "zf_xiaoxiao", label: "Mandarin • Female • Xiaoxiao" },
              { value: "zf_xiaoyi", label: "Mandarin • Female • Xiaoyi" },
              { value: "zm_yunjian", label: "Mandarin • Male • Yunjian" },
              { value: "zm_yunxi", label: "Mandarin • Male • Yunxi" },
              { value: "zm_yunxia", label: "Mandarin • Male • Yunxia" },
              { value: "zm_yunyang", label: "Mandarin • Male • Yunyang" },
              { value: "ef_dora", label: "Spanish • Female • Dora" },
              { value: "em_alex", label: "Spanish • Male • Alex" },
              { value: "em_santa", label: "Spanish • Male • Santa" },
              { value: "ff_siwis", label: "French • Female • Siwis" },
              { value: "hf_alpha", label: "Hindi • Female • Alpha" },
              { value: "hf_beta", label: "Hindi • Female • Beta" },
              { value: "hm_omega", label: "Hindi • Male • Omega" },
              { value: "hm_psi", label: "Hindi • Male • Psi" },
              { value: "if_sara", label: "Italian • Female • Sara" },
              { value: "im_nicola", label: "Italian • Male • Nicola" },
              { value: "pf_dora", label: "Brazilian Portuguese • Female • Dora" },
              { value: "pm_alex", label: "Brazilian Portuguese • Male • Alex" },
              { value: "pm_santa", label: "Brazilian Portuguese • Male • Santa" },
            ],
          },
          {
            id: "tts.minChunkWords",
            name: "Min Words Per Chunk",
            description:
              "Smallest number of words to buffer before sending a chunk to the voice model.\nHigher values produce smoother prosody at the cost of latency.",
            type: "number",
            defaultValue: 8,
            suffix: "words",
            regex: [{ regex: "^[1-9][0-9]*$", errorMessage: "Must be a positive integer" }],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tts.synthesisSpeed",
            name: "Speech Synthesis Speed",
            description:
              "Speed the voice model is asked to render speech at.\nAffects the prosody of the generated audio (lower = more relaxed pacing, higher = more clipped).\nAccepted range: 0.25 to 3.",
            type: "float",
            defaultValue: 1,
            suffix: "x",
            regex: [
              {
                regex: "^(0\\.(2[5-9]|[3-9]\\d?)|[12](\\.\\d+)?|3(\\.0+)?)$",
                errorMessage: "Must be between 0.25 and 3",
              },
            ],
            advanced: true,
            descriptionTier: "ondemand",
          },
          {
            id: "tts.playbackSpeed",
            name: "Playback Speed",
            description:
              "Speed the synthesized audio is replayed at.\nApplied after synthesis, so pitch scales with the multiplier (higher = higher-pitched voice).\nAccepted range: 0.25 to 3.",
            type: "float",
            defaultValue: 1,
            suffix: "x",
            regex: [
              {
                regex: "^(0\\.(2[5-9]|[3-9]\\d?)|[12](\\.\\d+)?|3(\\.0+)?)$",
                errorMessage: "Must be between 0.25 and 3",
              },
            ],
            descriptionTier: "ondemand",
          },
          {
            id: "tts.volume",
            name: "Volume",
            description: "Playback volume for synthesized speech.\nAccepted range: 0 to 100.",
            type: "number",
            defaultValue: 70,
            suffix: "%",
            regex: [
              {
                regex: "^(?:[0-9]|[1-9][0-9]|100)$",
                errorMessage: "Must be between 0 and 100",
              },
            ],
            descriptionTier: "none",
          },
        ],
      },
    ],
  },
  {
    id: "usage",
    name: "Usage",
    icon: "i-material-symbols-analytics-rounded",
    iconInactive: "i-material-symbols-analytics-outline-rounded",
    sections: [
      {
        fields: [
          {
            id: "usage.services",
            name: "Services",
            description: "Live memory and CPU usage for each local service.",
            type: "services",
            defaultValue: "",
            descriptionTier: "ondemand",
          },
          {
            id: "usage.storage",
            name: "Storage",
            description:
              "Downloaded models and saved sessions.\nSelect items and press Delete (or ⌘⌫) to remove them.",
            type: "storage",
            defaultValue: "",
            descriptionTier: "ondemand",
          },
        ],
      },
    ],
  },
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

export type ConditionDep =
  | { kind: "field"; fieldId: string; condition: "editableWhen" | "optionalWhen" }
  | {
      kind: "section";
      groupId: string;
      sectionIndex: number;
      condition: "visibleWhen" | "expandWhen";
    };

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

export interface SearchResultGroup {
  groupId: string;
  groupName: string;
  sectionKey: string;
  sectionLabel?: string;
  fields: SettingField[];
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

  if (field.options) {
    for (const opt of field.options) {
      if (opt.label.toLowerCase().includes(q)) return true;
    }
  }

  if (field.presetConfig) {
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
