import type { CommandType } from "./command";

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
  | "multiline";

const TOOL_ONLY_PROMPT = `You are a very limited on-device AI assistant. Your knowledge and reasoning capabilities are extremely small, so you MUST follow these rules strictly:

1. You can ONLY answer very basic, short, factual questions (1-2 sentences max). Examples of questions you CAN answer: simple greetings, very basic arithmetic, the current date if provided in context, or restating something the user just said.

2. For ANY question that requires reasoning, multi-step thinking, creativity, writing, coding, analysis, or specialized knowledge — you MUST NOT attempt to answer. Instead, politely explain that you are a small local model with very limited knowledge and cannot reliably answer complex questions, and suggest the user try a larger model or consult another source.

3. When a tool call would help answer the user's request, you MUST make the tool call. Never try to guess what a tool would return. Never invent facts.

4. Never make up information. Never guess. Never speculate. Never produce long responses. If in doubt, refuse politely.

5. Keep your responses extremely short — ideally one sentence, never more than two. Do not add disclaimers, preambles, or filler.

Remember: it is ALWAYS better to politely decline than to produce a wrong or made-up answer.`;

const ASSISTANT_PROMPT = `You are a professional on-device AI assistant. You run locally on the user's machine and have access to a suite of tools that let you help the user accomplish their tasks.

Your identity:
- You are an on-device assistant — you run locally, you respect user privacy, and you do not rely on any cloud service for core reasoning.
- You are professional, helpful, concise, and honest.

Your capabilities:
- You can answer questions, write and analyze code, help with tasks, and carry on natural conversation.
- You have access to tools. When a tool would produce a better or more accurate answer than your own reasoning, make the tool call.
- You can handle complex, multi-step requests. There are no arbitrary limits on the topics or tasks you are willing to help with, provided they are legal and safe.

Your style:
- Be direct and practical. Prefer short answers for simple questions and detailed answers only when needed.
- Never pretend to be a different model or service.
- If you are unsure about a fact, say so plainly rather than guessing.
- Never fabricate tool output. If a tool is not available or fails, explain what happened.

Remember: you are here to be genuinely useful to the user running you on their own device.`;

export interface SettingOption {
  value: string | number;
  label: string;
}

export interface FieldCondition {
  field: string;
  eq?: string | number | boolean;
  neq?: string | number | boolean;
}

export interface PresetOption {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  defaults?: Record<string, string | number | boolean>;
}

export interface PresetConfig {
  columns: number;
  options: PresetOption[];
  secondaryOptions?: PresetOption[];
}

export interface RegexValidationRule {
  regex: string;
  errorMessage: string;
}

export type RegexValidation = string | RegexValidationRule[];

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
}

export interface SettingSection {
  label?: string;
  collapsible?: boolean;
  visibleWhen?: FieldCondition;
  expandWhen?: FieldCondition;
  fields: SettingField[];
}

export interface SettingGroup {
  id: string;
  name: string;
  sections: SettingSection[];
}

export const SETTINGS_SCHEMA: SettingGroup[] = [
  {
    id: "appearance",
    name: "Appearance",
    sections: [
      {
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
          },
          {
            id: "appearance.textSize",
            name: "Text Size",
            description: "Base text size for the entire app (12–32).",
            type: "number",
            defaultValue: 18,
            suffix: "px",
            regex: [
              {
                regex: "^(?:1[2-9]|2[0-9]|3[0-2])$",
                errorMessage: "Must be between 12 and 32",
              },
            ],
          },
          {
            id: "layout.monitor",
            name: "Monitor",
            description: "Choose which monitor to display the app on.",
            type: "monitor",
            defaultValue: "primary",
          },
          {
            id: "layout.alignment",
            name: "Screen Alignment",
            description: "Align the window to the left, center, or right.",
            type: "select",
            defaultValue: "center",
            options: [
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" },
            ],
          },
          {
            id: "layout.width",
            name: "Window Width",
            description: "Width of the app window (400–1200).",
            type: "number",
            defaultValue: 700,
            suffix: "px",
            regex: [
              {
                regex: "^(?:4[0-9]{2}|[5-9][0-9]{2}|1[01][0-9]{2}|1200)$",
                errorMessage: "Must be between 400 and 1200",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "behaviour",
    name: "Behaviour",
    sections: [
      {
        label: "System Prompt",
        fields: [
          {
            id: "behaviour.preset",
            name: "",
            description: "",
            type: "preset",
            defaultValue: "disabled",
            presetConfig: {
              columns: 3,
              options: [
                {
                  id: "disabled",
                  label: "Disabled",
                  defaults: { "behaviour.systemPrompt": "" },
                },
                {
                  id: "tool-only",
                  label: "Tool Only",
                  defaults: { "behaviour.systemPrompt": TOOL_ONLY_PROMPT },
                },
                {
                  id: "assistant",
                  label: "Assistant",
                  defaults: { "behaviour.systemPrompt": ASSISTANT_PROMPT },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  icon: "i-material-symbols-tune-rounded",
                  color: "amber",
                },
              ],
            },
          },
          {
            id: "behaviour.systemPrompt",
            name: "System Prompt",
            description:
              "The system prompt sent to the agent. Editing this manually switches the preset to Custom.",
            type: "multiline",
            defaultValue: "",
            optional: true,
            visibleWhen: { field: "behaviour.preset", neq: "disabled" },
          },
        ],
      },
      {
        label: "Context",
        fields: [
          {
            id: "behaviour.context.preferredUserName",
            name: "Preferred User Name",
            description: "Optional: how the agent should address you.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Alex",
          },
          {
            id: "behaviour.context.preferredAgentName",
            name: "Preferred Agent Name",
            description:
              "Optional: a name for the agent. Leave empty to let the agent pick or stay nameless.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Tomat",
          },
          {
            id: "behaviour.context.preferredLanguage",
            name: "Preferred Language",
            description: "Optional: the language you prefer to communicate in.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. English",
          },
          {
            id: "behaviour.context.location",
            name: "Location",
            description:
              "Optional: a location string the agent can reference. No network calls are made.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. San Francisco, CA",
          },
          {
            id: "behaviour.context.dateTime",
            name: "Date and time",
            description: "Attach the current date and time to the system prompt.",
            type: "boolean",
            defaultValue: true,
          },
          {
            id: "behaviour.context.os",
            name: "Operating System",
            description: "Attach your operating system to the system prompt.",
            type: "boolean",
            defaultValue: true,
          },
        ],
      },
      {
        label: "Session Management",
        fields: [
          {
            id: "behaviour.alwaysStartNew",
            name: "Always Start New Session",
            description:
              "When the app starts, always begin a new empty session instead of resuming the last one.",
            type: "boolean",
            defaultValue: false,
          },
          {
            id: "behaviour.storeSessions",
            name: "Store Sessions",
            description:
              "Persist messages and session titles to disk. When disabled, sessions live only in memory and are cleared when the app closes.",
            type: "boolean",
            defaultValue: true,
          },
        ],
      },
    ],
  },
  {
    id: "llm",
    name: "Language Model",
    sections: [
      {
        fields: [
          {
            id: "llm.supportImages",
            name: "Support Images",
            description:
              "Allow attaching images to send to the LLM (requires vision-capable model)",
            type: "boolean",
            defaultValue: true,
          },
        ],
      },
      {
        fields: [
          {
            id: "llm.preset",
            name: "Model Preset",
            description: "",
            type: "preset",
            defaultValue: "0.8b",
            presetConfig: {
              columns: 3,
              options: [
                {
                  id: "0.8b",
                  label: "0.8B",
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
                  defaults: {
                    "llm.modelPath": "@unsloth/Qwen3.5-2B-GGUF/main/Qwen3.5-2B-Q4_K_M.gguf",
                    "llm.mmprojPath": "@unsloth/Qwen3.5-2B-GGUF/main/mmproj-F16.gguf",
                    "llm.contextSize": 8192,
                    "llm.mmap": true,
                    "llm.threads": 4,
                    "llm.reasoning": "on",
                    "llm.reasoningBudget": 1024,
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
                {
                  id: "5b-e2b",
                  label: "5B E2B",
                  defaults: {
                    "llm.modelPath": "@unsloth/gemma-4-E2B-it-GGUF/main/gemma-4-E2B-it-Q4_K_M.gguf",
                    "llm.mmprojPath": "@unsloth/gemma-4-E2B-it-GGUF/main/mmproj-F16.gguf",
                    "llm.contextSize": 8192,
                    "llm.mmap": true,
                    "llm.threads": 6,
                    "llm.reasoning": "on",
                    "llm.reasoningBudget": 1024,
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  icon: "i-material-symbols-tune-rounded",
                  color: "amber",
                },
                {
                  id: "external",
                  label: "External",
                  icon: "i-material-symbols-cloud-done-outline-rounded",
                  color: "purple",
                },
              ],
            },
          },
        ],
      },
      {
        label: "External Provider",
        visibleWhen: { field: "llm.preset", eq: "external" },
        fields: [
          {
            id: "llm.external.baseUrl",
            name: "Base URL",
            description: "API endpoint URL",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
          },
          {
            id: "llm.external.apiKey",
            name: "API Key",
            description: "Authentication key",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
          },
          {
            id: "llm.external.model",
            name: "Model",
            description: "Model identifier to use",
            type: "string",
            defaultValue: "",
            placeholder: "gpt-4o-mini",
          },
          {
            id: "llm.external.contextSize",
            name: "Context Size",
            description: "Maximum context window length for usage tracking",
            type: "number",
            defaultValue: 128000,
          },
        ],
      },
      {
        label: "Llama Server Configuration",
        visibleWhen: { field: "llm.preset", neq: "external" },
        fields: [
          {
            id: "llm.modelPath",
            name: "Model Path",
            description: "Path to the GGUF model file",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/Qwen3.5-0.8B-Q4_K_M.gguf",
          },
          {
            id: "llm.mmprojPath",
            name: "Vision Projector Path",
            description: "Path to the mmproj GGUF file for vision support",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/mmproj-F16.gguf",
            placeholder: "@user/repo/branch/mmproj-f16.gguf",
            visibleWhen: { field: "llm.supportImages", eq: true },
            optionalWhen: { field: "llm.supportImages", eq: false },
          },
          {
            id: "llm.contextSize",
            name: "Context Size",
            description: "Maximum context window length",
            type: "number",
            defaultValue: 4096,
          },
          {
            id: "llm.mmap",
            name: "Memory Map (mmap)",
            description: "Use memory-mapped I/O for model loading",
            type: "boolean",
            defaultValue: true,
          },
          {
            id: "llm.threads",
            name: "CPU Threads",
            description: "Number of threads for inference",
            type: "number",
            defaultValue: 4,
          },
          {
            id: "llm.reasoning",
            name: "Reasoning State",
            description: "Whether to enable reasoning (on, off, auto)",
            type: "select",
            defaultValue: "off",
            options: [
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
              { value: "auto", label: "Auto" },
            ],
            optional: true,
          },
          {
            id: "llm.reasoningBudget",
            name: "Reasoning Budget",
            description: "Number of tokens reserved for reasoning",
            type: "number",
            defaultValue: "",
            visibleWhen: { field: "llm.reasoning", neq: "off" },
            optional: true,
            placeholder: "optional",
          },
          {
            id: "llm.host",
            name: "Host",
            description: "Server bind address",
            type: "string",
            defaultValue: "127.0.0.1",
            regex: [
              {
                regex:
                  "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
                errorMessage: "Must be a valid IPv4 address",
              },
            ],
          },
          {
            id: "llm.port",
            name: "Port",
            description: "Server listen port",
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
          },
          {
            id: "llm.webui",
            name: "Enable Web UI",
            description: "Enable the llama.cpp built-in Web UI",
            type: "boolean",
            defaultValue: false,
          },
          {
            id: "llm.commandPreview",
            name: "Command Preview",
            description: "",
            type: "command_preview",
            defaultValue: "",
            commandType: "llm",
          },
        ],
      },
    ],
  },
  {
    id: "stt",
    name: "Speech-to-Text",
    sections: [
      {
        fields: [
          {
            id: "stt.llmAutocorrect",
            name: "LLM Autocorrect",
            description: "Use the LLM to correct transcription mistakes after speech recognition",
            type: "boolean",
            defaultValue: false,
          },
          {
            id: "stt.autoSend",
            name: "Auto Send Speech",
            description: "Automatically send the message after speech transcription completes",
            type: "boolean",
            defaultValue: false,
          },
        ],
      },
      {
        label: "Smart Activation",
        fields: [
          {
            id: "stt.smartStt",
            name: "Smart STT",
            description:
              "How voice input is activated. Persistent: VAD state survives app restarts. Hold: press the global shortcut to activate VAD while held.",
            type: "select",
            defaultValue: "disabled",
            options: [
              { value: "disabled", label: "Disabled" },
              { value: "persistent", label: "Persistent" },
              { value: "hold", label: "Hold" },
            ],
          },
          {
            id: "stt.holdDuration",
            name: "Hold Duration",
            description:
              "Delay before VAD activates while holding the shortcut. A short tap under this threshold will hide the app instead.",
            type: "number",
            defaultValue: 250,
            suffix: "ms",
            visibleWhen: { field: "stt.smartStt", eq: "hold" },
          },
          {
            id: "stt.vadPersistedState",
            name: "VAD Persisted State",
            description: "",
            type: "boolean",
            defaultValue: false,
            visibleWhen: { field: "stt.smartStt", eq: "__never__" },
          },
        ],
      },
      {
        fields: [
          {
            id: "stt.preset",

            name: "Model Preset",
            description: "",
            type: "preset",
            defaultValue: "base",
            presetConfig: {
              columns: 3,
              options: [
                {
                  id: "base",
                  label: "Base",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-base.bin",
                    "stt.threads": 4,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "medium",
                  label: "Medium",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-medium.bin",
                    "stt.threads": 6,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
                {
                  id: "large",
                  label: "Large",
                  defaults: {
                    "stt.modelPath": "@ggerganov/whisper.cpp/main/ggml-large-v3.bin",
                    "stt.threads": 8,
                    "stt.host": "127.0.0.1",
                    "stt.port": "7702",
                  },
                },
              ],
              secondaryOptions: [
                {
                  id: "custom",
                  label: "Custom",
                  icon: "i-material-symbols-tune-rounded",
                  color: "amber",
                },
                {
                  id: "external",
                  label: "External",
                  icon: "i-material-symbols-cloud-done-outline-rounded",
                  color: "purple",
                },
              ],
            },
          },
        ],
      },
      {
        label: "External Provider",
        visibleWhen: { field: "stt.preset", eq: "external" },
        fields: [
          {
            id: "stt.external.baseUrl",
            name: "Base URL",
            description: "API endpoint URL",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
          },
          {
            id: "stt.external.apiKey",
            name: "API Key",
            description: "Authentication key",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
          },
          {
            id: "stt.external.model",
            name: "Model",
            description: "Model identifier to use",
            type: "string",
            defaultValue: "",
            placeholder: "whisper-1",
          },
        ],
      },
      {
        label: "Whisper Server Configuration",
        visibleWhen: { field: "stt.preset", neq: "external" },
        fields: [
          {
            id: "stt.modelPath",
            name: "Model Path",
            description: "Path to the Whisper model file",
            type: "string",
            defaultValue: "@ggerganov/whisper.cpp/main/ggml-base.bin",
          },
          {
            id: "stt.threads",
            name: "CPU Threads",
            description: "Number of threads for inference",
            type: "number",
            defaultValue: 4,
          },
          {
            id: "stt.host",
            name: "Host",
            description: "Server bind address",
            type: "string",
            defaultValue: "127.0.0.1",
            regex: [
              {
                regex:
                  "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
                errorMessage: "Must be a valid IPv4 address",
              },
            ],
          },
          {
            id: "stt.port",
            name: "Port",
            description: "Server listen port",
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
          },
          {
            id: "stt.commandPreview",
            name: "Command Preview",
            description: "",
            type: "command_preview",
            defaultValue: "",
            commandType: "stt",
          },
        ],
      },
    ],
  },
];

export function getDefaultSettings(): Record<string, any> {
  const defaults: Record<string, any> = {};
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (field.type !== "command_preview") {
          defaults[field.id] = field.defaultValue;
        }
      }
    }
  }
  return defaults;
}

export function evalCondition(
  cond: FieldCondition | undefined,
  currentSettings: Record<string, any>,
): boolean {
  if (!cond) return true;
  const val = currentSettings[cond.field];
  if (cond.eq !== undefined) return val === cond.eq;
  if (cond.neq !== undefined) return val !== cond.neq;
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

  for (const group of SETTINGS_SCHEMA) {
    for (let si = 0; si < group.sections.length; si++) {
      const section = group.sections[si];
      if (section.visibleWhen) {
        add(section.visibleWhen.field, {
          kind: "section",
          groupId: group.id,
          sectionIndex: si,
          condition: "visibleWhen",
        });
      }
      if (section.expandWhen) {
        add(section.expandWhen.field, {
          kind: "section",
          groupId: group.id,
          sectionIndex: si,
          condition: "expandWhen",
        });
      }
      for (const field of section.fields) {
        if (field.editableWhen) {
          add(field.editableWhen.field, {
            kind: "field",
            fieldId: field.id,
            condition: "editableWhen",
          });
        }
        if (field.optionalWhen) {
          add(field.optionalWhen.field, {
            kind: "field",
            fieldId: field.id,
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

/** Search all settings fields by query string. Matches against name, description, options labels, and preset labels. */
export function searchFields(query: string): SettingField[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: SettingField[] = [];

  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        if (field.type === "command_preview") continue;
        if (fieldMatchesQuery(field, q)) {
          results.push(field);
        }
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
