import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const llmGroup: SettingGroup = {
  id: "llm",
  destination: "core",
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
      label: "Model",
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
        {
          id: "llm.preset",
          name: "Smart Preset",
          visibleWhen: { field: "llm.provider", eq: "local" },
          description:
            'tomat picks the best model for your device in each tier. The model shown on each card is computed from your hardware and the latest catalog; use "Check for Newer Models" to re-evaluate.',
          type: "model_preset",
          defaultValue: "smallest",
          presetConfig: {
            // The adaptive presets compute their values at runtime (no static
            // `defaults`), so list the keys they manage here: editing any of
            // them flips the preset to Custom.
            managedKeys: [
              "llm.modelPath",
              "llm.mmprojPath",
              "llm.contextSize",
              "llm.threads",
              "llm.gpuLayers",
              "llm.flashAttn",
              "llm.supportImages",
              "llm.idleUnloadSeconds",
            ],
            // These are placeholders: the client fills each card's title, badges,
            // and description from GET /api/v1/models/recommend, and selecting a
            // card calls POST /api/v1/models/select { bucket } rather than
            // applying static defaults.
            options: [
              {
                id: "smallest",
                label: "Smallest",
                title: "Smallest",
                description:
                  "The lightest model that still works well with tomat. Minimal memory use, runs on anything.",
              },
              {
                id: "half",
                label: "Half",
                title: "Balanced",
                description:
                  "The smartest model that uses around half of your device's memory. A comfortable everyday default.",
              },
              {
                id: "full",
                label: "Full",
                title: "Smartest",
                description:
                  "The smartest model your device can run without crashing. Unloads itself when idle to free memory.",
              },
            ],
            secondaryOptions: [
              {
                id: "custom",
                label: "Custom",
                title: "Custom",
                badges: [
                  {
                    icon: "i-material-symbols-build-rounded",
                    label: "Manual setup",
                  },
                ],
                description:
                  "Pick a specific model from the catalog, or configure the model path, context size, threads, and ports yourself.",
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
          id: "llm.gpuLayers",
          name: "GPU Layers",
          description:
            "How many model layers to offload to the GPU.\n\n0 runs entirely on the CPU; a large value such as 999 offloads every layer. Leave blank to let llama.cpp decide.",
          type: "number",
          defaultValue: "",
          optional: true,
          placeholder: "auto",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.flashAttn",
          name: "Flash Attention",
          description:
            "Use flash attention for faster, more memory-efficient attention. Recommended on supported hardware.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.idleUnloadSeconds",
          name: "Idle Unload",
          description:
            "Stop the local model after this many seconds with no activity, freeing its memory; it reloads automatically on the next message.\n\n0 keeps it loaded. The Full preset enables this automatically.",
          type: "number",
          defaultValue: 0,
          suffix: "s",
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
          descriptionTier: "always",
        },
        {
          id: "llm.webui",
          name: "Built-in Web UI",
          description: "Enable the llama.cpp built-in web interface.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
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
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
