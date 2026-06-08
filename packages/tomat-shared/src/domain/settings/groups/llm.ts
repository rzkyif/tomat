import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const llmGroup: SettingGroup = {
  id: "llm",
  destination: "core",
  name: "Language Model",
  description:
    "The model that powers your chats. Run one locally on this device, or connect to an external API.",
  descriptionTier: "ondemand",
  icon: "i-material-symbols-psychology-rounded",
  iconInactive: "i-material-symbols-psychology-outline-rounded",
  sections: [
    {
      label: "General",
      fields: [
        {
          id: "llm.supportImages",
          name: "Image Attachments",
          description: "Let yourself attach images to messages. The model must support vision.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.showReasoning",
          name: "Show Thinking",
          description:
            "Show the model's thinking above each reply, when it thinks.\nSaved with the session but never sent back to the model.",
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
            "Run the model on this device (private, no internet) or connect to an external API.",
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
            "Three ready-made sizes (Smallest, Balanced, Smartest), each filled with the best-fitting model for your hardware. Pick one, or choose Custom to set the model and tuning yourself.",
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
                description: "The lightest capable model. Runs on almost anything.",
              },
              {
                id: "half",
                label: "Half",
                title: "Balanced",
                description:
                  "A capable model that uses about half your memory. A good everyday default.",
              },
              {
                id: "full",
                label: "Full",
                title: "Smartest",
                description:
                  "The largest model your device can handle. Unloads itself after 5 minutes idle to free memory.",
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
      label: "Model Server Configuration",
      visibleWhen: {
        allOf: [
          { field: "llm.provider", eq: "local" },
          { field: "llm.preset", eq: "custom" },
        ],
      },
      fields: [
        {
          id: "llm.modelPath",
          name: "Model File",
          description: "Path to the model file to load, e.g. @user/repo/branch/model.gguf.",
          type: "string",
          defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/Qwen3.5-0.8B-Q4_K_M.gguf",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.mmprojPath",
          name: "Vision File",
          description: "Path to the vision add-on file for image support.",
          type: "string",
          defaultValue: "@unsloth/Qwen3.5-0.8B-GGUF/main/mmproj-F16.gguf",
          placeholder: "@user/repo/branch/mmproj-f16.gguf",
          visibleWhen: { field: "llm.supportImages", eq: true },
          optionalWhen: { field: "llm.supportImages", eq: false },
          descriptionTier: "ondemand",
        },
        {
          id: "llm.contextSize",
          name: "Context Window",
          description:
            "How much text the model can consider at once, in tokens. Larger uses more memory.",
          type: "number",
          defaultValue: 4096,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.threads",
          name: "CPU Threads",
          description: "How many CPU threads to use.",
          type: "number",
          defaultValue: 4,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.gpuLayers",
          name: "GPU Layers",
          description:
            "How much of the model to run on the GPU. Higher is faster if it fits; blank lets tomat decide.",
          type: "number",
          defaultValue: "",
          optional: true,
          placeholder: "auto",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.flashAttn",
          name: "Flash Attention",
          description: "Faster, lighter processing on supported hardware.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.idleUnloadSeconds",
          name: "Unload When Idle",
          description:
            "Free memory by unloading the model after this long unused. It reloads on your next message; 0 keeps it loaded.",
          type: "number",
          defaultValue: 0,
          suffix: "s",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.reasoning",
          name: "Thinking",
          description:
            "Whether the model should think before answering. The model may still skip it for simple prompts.",
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
          name: "Thinking Budget",
          description: "How many tokens the model may spend thinking.",
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
            "Load the model straight from disk for faster startup and lower memory. Turn off only if you hit stability issues.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.host",
          name: "Host",
          description: "Address the local model server binds to.",
          type: "string",
          defaultValue: "127.0.0.1",
          regex: [
            {
              regex:
                "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
              errorMessage: "Must be a valid IPv4 address",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "llm.port",
          name: "Port",
          description: "Port the local model server listens on.",
          type: "string",
          defaultValue: "7701",
          regex: [
            { regex: "^\\d+$", errorMessage: "Port must be a number" },
            {
              regex:
                "^(?:[1-9]\\d{0,4}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5])$",
              errorMessage: "Port must be 1-65535",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "llm.webui",
          name: "llama.cpp Web UI",
          description: "Enable llama.cpp's built-in web interface.",
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
            "Your provider's API endpoint. Must be HTTPS (HTTP allowed only for localhost).",
          type: "string",
          defaultValue: "",
          placeholder: "https://api.example.com/v1",
          regex: SECURE_URL_VALIDATION,
          descriptionTier: "ondemand",
        },
        {
          id: "llm.external.apiKey",
          name: "API Key",
          description: "Your provider API key. Stored securely in your device keychain.",
          type: "password",
          defaultValue: "",
          placeholder: "sk-...",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.external.model",
          name: "Model",
          description: "The model name to use, e.g. gpt-4o-mini.",
          type: "string",
          defaultValue: "",
          placeholder: "gpt-4o-mini",
          descriptionTier: "ondemand",
        },
        {
          id: "llm.external.contextSize",
          name: "Context Window",
          description: "The model's context window, in tokens. Used to track usage.",
          type: "number",
          defaultValue: 128000,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
