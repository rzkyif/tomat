import type { SettingGroup } from "../types";
import { SECURE_URL_VALIDATION } from "../types";

export const llmGroup: SettingGroup = {
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
};
