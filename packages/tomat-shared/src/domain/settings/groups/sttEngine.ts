// Core-side STT settings — provider, whisper-server config, external API
// endpoint. Persisted to ~/.tomat/core/settings.json on the paired core.
// The microphone-side UX prefs live in `sttInput`.

import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const sttEngineGroup: SettingGroup = {
  id: "stt_engine",
  destination: "core",
  name: "Speech-to-Text Engine",
  icon: "i-material-symbols-graphic-eq-rounded",
  iconInactive: "i-material-symbols-graphic-eq-rounded",
  sections: [
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
                id: "small",
                label: "Small",
                title: "Whisper Small",
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
                id: "medium",
                label: "Medium",
                title: "Whisper Medium",
                description:
                  "More accurate with accents or background noise. A good default on modern machines.",
                defaults: {
                  "stt.modelPath":
                    "@ggerganov/whisper.cpp/main/ggml-medium.bin",
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
                description:
                  "Configure model path, threads, and ports yourself.",
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
};
