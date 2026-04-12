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
  | "multiline"
  | "services"
  | "storage";

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
  in?: (string | number | boolean)[];
  nin?: (string | number | boolean)[];
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
          },
        ],
      },
    ],
  },
  {
    id: "general",
    name: "General",
    sections: [
      {
        label: "System Prompt",
        fields: [
          {
            id: "general.systemPrompt.preset",
            name: "",
            description: "",
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
                  defaults: { "general.systemPrompt": "" },
                },
                {
                  id: "tool-only",
                  label: "Tool Only",
                  title: "Tool Only",
                  description:
                    "Forces short, cautious replies and a strong preference for tool use. Suited to small on-device models that cannot reason reliably on their own.",
                  defaults: { "general.systemPrompt": TOOL_ONLY_PROMPT },
                },
                {
                  id: "assistant",
                  label: "Assistant",
                  title: "Assistant",
                  description:
                    "A professional, capable general-purpose assistant that answers directly and uses tools when helpful.",
                  defaults: { "general.systemPrompt": ASSISTANT_PROMPT },
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
            id: "general.systemPrompt",
            name: "System Prompt",
            description:
              "The system prompt sent to the agent.\nEditing this manually switches the preset to Custom.",
            type: "multiline",
            defaultValue: "",
            optional: true,
            visibleWhen: { field: "general.systemPrompt.preset", eq: "custom" },
          },
        ],
      },
      {
        label: "Context",
        fields: [
          {
            id: "general.context.userName",
            name: "Your Name",
            description: "How the agent should address you. Optional.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Alex",
          },
          {
            id: "general.context.agentName",
            name: "Agent Name",
            description:
              "A name for the agent. Optional — leave empty to let the agent pick or stay nameless.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. Tomat",
          },
          {
            id: "general.context.language",
            name: "Language",
            description: "The language you prefer to communicate in. Optional.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. English",
          },
          {
            id: "general.context.location",
            name: "Location",
            description:
              "A location string the agent can reference. Optional.\nNo network calls are made — the value is attached as plain text.",
            type: "string",
            defaultValue: "",
            optional: true,
            placeholder: "e.g. San Francisco, CA",
          },
          {
            id: "general.context.dateTime",
            name: "Include Date and Time",
            description: "Attach the current date and time to the system prompt.",
            type: "boolean",
            defaultValue: true,
          },
          {
            id: "general.context.os",
            name: "Include Operating System",
            description: "Attach your operating system to the system prompt.",
            type: "boolean",
            defaultValue: true,
          },
        ],
      },
      {
        label: "Sessions",
        fields: [
          {
            id: "general.session.alwaysStartNew",
            name: "Always Start New Session",
            description:
              "When the app starts, always begin a new empty session instead of resuming the last one.",
            type: "boolean",
            defaultValue: false,
          },
          {
            id: "general.session.storeSessions",
            name: "Store Sessions",
            description:
              "Persist messages and session titles to disk.\nWhen disabled, sessions live only in memory and are cleared when the app closes.",
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
        label: "Attachments",
        fields: [
          {
            id: "llm.supportImages",
            name: "Support Images",
            description:
              "Allow attaching images to messages.\nRequires a vision-capable model when using the local llama-server.",
            type: "boolean",
            defaultValue: true,
          },
        ],
      },
      {
        label: "Model",
        fields: [
          {
            id: "llm.preset",
            name: "",
            description: "",
            type: "preset",
            defaultValue: "0.8b",
            presetConfig: {
              options: [
                {
                  id: "0.8b",
                  label: "0.8B",
                  title: "Qwen 0.8B",
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
                  title: "Qwen 2B",
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
                    "llm.reasoningBudget": 1024,
                    "llm.host": "127.0.0.1",
                    "llm.port": "7701",
                  },
                },
                {
                  id: "5b-e2b",
                  label: "5B E2B",
                  title: "Gemma 5B E2B",
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
                  title: "Custom",
                  badges: [{ icon: "i-material-symbols-build-rounded", label: "Manual setup" }],
                  description: "Configure model path, context size, threads, and ports yourself.",
                },
                {
                  id: "external",
                  label: "External",
                  title: "External",
                  badges: [{ icon: "i-material-symbols-cloud", label: "OpenAI-compatible" }],
                  description: "Point to a remote API. Skips the local llama-server entirely.",
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
            description: "API endpoint URL.",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
          },
          {
            id: "llm.external.apiKey",
            name: "API Key",
            description: "Authentication key.",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
          },
          {
            id: "llm.external.model",
            name: "Model",
            description: "Model identifier to use.",
            type: "string",
            defaultValue: "",
            placeholder: "gpt-4o-mini",
          },
          {
            id: "llm.external.contextSize",
            name: "Context Size",
            description: "Maximum context window length, used for usage tracking.",
            type: "number",
            defaultValue: 128000,
          },
        ],
      },
      {
        label: "Llama Server Configuration",
        visibleWhen: { field: "llm.preset", eq: "custom" },
        fields: [
          {
            id: "llm.modelPath",
            name: "Model Path",
            description: "Path to the GGUF model file.",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/Qwen3.5-0.8B-Q4_K_M.gguf",
          },
          {
            id: "llm.mmprojPath",
            name: "Vision Projector Path",
            description: "Path to the mmproj GGUF file used for vision support.",
            type: "string",
            defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/mmproj-F16.gguf",
            placeholder: "@user/repo/branch/mmproj-f16.gguf",
            visibleWhen: { field: "llm.supportImages", eq: true },
            optionalWhen: { field: "llm.supportImages", eq: false },
          },
          {
            id: "llm.contextSize",
            name: "Context Size",
            description: "Maximum context window length.",
            type: "number",
            defaultValue: 4096,
          },
          {
            id: "llm.mmap",
            name: "Memory Mapping",
            description:
              "Use memory-mapped I/O when loading the model.\n\nFaster startup and lower RAM usage in most cases. Disable if you see stability issues on unusual filesystems.",
            type: "boolean",
            defaultValue: true,
          },
          {
            id: "llm.threads",
            name: "CPU Threads",
            description: "Number of threads used for inference.",
            type: "number",
            defaultValue: 4,
          },
          {
            id: "llm.reasoning",
            name: "Reasoning",
            description: "Whether the model should produce a reasoning trace before its answer.",
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
            description: "Number of tokens reserved for the reasoning trace.",
            type: "number",
            defaultValue: "",
            visibleWhen: { field: "llm.reasoning", neq: "off" },
            optional: true,
            placeholder: "optional",
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
          },
          {
            id: "llm.webui",
            name: "Llama.cpp Web UI",
            description: "Enable the llama.cpp built-in web interface.",
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
        label: "Transcription",
        visibleWhen: { field: "stt.preset", neq: "disabled" },
        fields: [
          {
            id: "stt.llmAutocorrect",
            name: "LLM Autocorrect",
            description:
              "Use the language model to clean up transcription mistakes after speech recognition.",
            type: "boolean",
            defaultValue: false,
          },
          {
            id: "stt.autoSend",
            name: "Auto-send Transcription",
            description: "Automatically send the message as soon as transcription completes.",
            type: "boolean",
            defaultValue: false,
          },
        ],
      },
      {
        label: "Voice Input",
        visibleWhen: { field: "stt.preset", neq: "disabled" },
        fields: [
          {
            id: "stt.smartStt",
            name: "Activation",
            description:
              "How the microphone is activated.\n\nManual: use the mic button. Voice input turns off whenever the app is hidden or closed.\nSticky: use the mic button. Voice input stays on through hides, closes, and restarts.\nPush to Talk: hold the global shortcut to dictate. Quick taps show or hide the window instead.",
            type: "select",
            defaultValue: "disabled",
            options: [
              { value: "disabled", label: "Manual" },
              { value: "persistent", label: "Sticky" },
              { value: "hold", label: "Push to Talk" },
            ],
          },
          {
            id: "stt.holdDuration",
            name: "Hold Duration",
            description:
              "Delay before push-to-talk activates while holding the shortcut.\nTaps shorter than this show or hide the app instead.",
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
        label: "Model",
        fields: [
          {
            id: "stt.preset",
            name: "",
            description: "",
            type: "preset",
            defaultValue: "base",
            presetConfig: {
              options: [
                {
                  id: "base",
                  label: "Base",
                  title: "Whisper Base",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~400 MB RAM" },
                    { icon: "i-material-symbols-bolt-rounded", label: "Fastest" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Basic accuracy" },
                  ],
                  description:
                    "Quick transcription for clear speech in quiet environments. Runs on almost any hardware.",
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
                  title: "Whisper Medium",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~2.5 GB RAM" },
                    { icon: "i-material-symbols-speed-rounded", label: "Balanced" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Solid accuracy" },
                  ],
                  description:
                    "Noticeably more accurate than Base with accents or background noise. A good default on modern machines.",
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
                  title: "Whisper Large v3",
                  badges: [
                    { icon: "i-material-symbols-memory-rounded", label: "~4 GB RAM" },
                    { icon: "i-material-symbols-hourglass-top-rounded", label: "Slower" },
                    { icon: "i-material-symbols-graphic-eq-rounded", label: "Best accuracy" },
                  ],
                  description:
                    "Highest accuracy, especially for non-English or noisy audio.\n\nSlow on low-end hardware.",
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
                  title: "Custom",
                  badges: [{ icon: "i-material-symbols-build-rounded", label: "Manual setup" }],
                  description: "Configure model path, threads, and ports yourself.",
                },
                {
                  id: "external",
                  label: "External",
                  title: "External",
                  badges: [{ icon: "i-material-symbols-cloud", label: "OpenAI-compatible" }],
                  description:
                    "Point to a remote transcription API. Skips the local whisper-server.",
                },
                {
                  id: "disabled",
                  label: "Disabled",
                  title: "Disabled",
                  badges: [{ icon: "i-material-symbols-mic-off-rounded", label: "Off" }],
                  description:
                    "Turn off speech-to-text entirely. The whisper server does not start and the microphone button is hidden.",
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
            description: "API endpoint URL.",
            type: "string",
            defaultValue: "",
            placeholder: "https://api.example.com/v1",
          },
          {
            id: "stt.external.apiKey",
            name: "API Key",
            description: "Authentication key.",
            type: "password",
            defaultValue: "",
            placeholder: "sk-...",
          },
          {
            id: "stt.external.model",
            name: "Model",
            description: "Model identifier to use.",
            type: "string",
            defaultValue: "",
            placeholder: "whisper-1",
          },
        ],
      },
      {
        label: "Whisper Server Configuration",
        visibleWhen: { field: "stt.preset", eq: "custom" },
        fields: [
          {
            id: "stt.modelPath",
            name: "Model Path",
            description: "Path to the Whisper model file.",
            type: "string",
            defaultValue: "@ggerganov/whisper.cpp/main/ggml-base.bin",
          },
          {
            id: "stt.threads",
            name: "CPU Threads",
            description: "Number of threads used for inference.",
            type: "number",
            defaultValue: 4,
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
  {
    id: "resources",
    name: "Resources",
    sections: [
      {
        label: "Activity",
        fields: [
          {
            id: "resources.services",
            name: "Services",
            description: "Live memory and CPU usage for each local service.",
            type: "services",
            defaultValue: "",
          },
        ],
      },
      {
        label: "Storage",
        fields: [
          {
            id: "resources.storage",
            name: "Disk Usage",
            description:
              "Downloaded models and saved sessions.\nSelect items and press Delete (or ⌘⌫) to remove them.",
            type: "storage",
            defaultValue: "",
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
        if (
          field.type !== "command_preview" &&
          field.type !== "services" &&
          field.type !== "storage"
        ) {
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
  if (cond.in !== undefined) return cond.in.includes(val);
  if (cond.nin !== undefined) return !cond.nin.includes(val);
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
          field.type === "storage"
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
