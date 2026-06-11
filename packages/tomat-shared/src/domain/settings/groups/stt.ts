// Speech-to-Text: one hybrid group spanning client and core. The voice-capture
// UX (microphone mode, push-to-talk, transcription post-processing) is stored
// on the client; the enable toggle and the recognition engine (provider,
// whisper-server config, external API) are stored on the core. Each section
// declares its own `destination` so fields route correctly and the header
// shows a Client/Core badge per section.

import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const sttGroup: SettingGroup = {
  id: "stt",
  destination: ["client", "core"],
  name: "Speech-to-Text",
  description:
    "Dictate messages with your voice. Capture settings run on this device; the speech recognition model runs on the core.",
  descriptionTier: "ondemand",
  icon: "i-material-symbols-mic-rounded",
  iconInactive: "i-material-symbols-mic-outline-rounded",
  sections: [
    {
      // The enable toggle is core-persisted: core gates the whisper-server
      // sidecar and the required-downloads snapshot on it, so a client-side
      // value would leave both running off the schema default.
      label: "General",
      destination: "core",
      fields: [
        {
          id: "stt.enabled",
          name: "Enable Speech-to-Text",
          description: "Dictate with your microphone using the mic button or push-to-talk.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Voice Input",
      destination: "client",
      fields: [
        {
          id: "stt.activation",
          name: "Push-to-Talk Mode",
          description:
            "How dictation turns on.\n\nManual: use the mic button. Voice input turns off whenever the app is hidden or closed.\n\nSticky: use the mic button. Voice input stays on through hides, closes, and restarts.\n\nPush to Talk: hold the global shortcut to dictate. Quick taps show or hide the window instead.",
          type: "select",
          defaultValue: "push-to-talk",
          options: [
            { value: "manual", label: "Manual" },
            { value: "sticky", label: "Sticky" },
            { value: "push-to-talk", label: "Push to Talk" },
          ],
          visibleWhen: { field: "stt.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "stt.holdDuration",
          name: "Push-to-Talk Hold",
          description:
            "How long to hold before push-to-talk starts. Quicker taps show or hide the app instead.",
          type: "number",
          defaultValue: 250,
          suffix: "ms",
          visibleWhen: {
            allOf: [
              { field: "stt.enabled", eq: true },
              { field: "stt.activation", eq: "push-to-talk" },
            ],
          },
          descriptionTier: "ondemand",
        },
        {
          id: "stt.autoVolumeEnabled",
          name: "Lower Volume While Listening",
          description: "Turn other audio down while you dictate, so you can hear yourself.",
          type: "boolean",
          defaultValue: false,
          visibleWhen: { field: "stt.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "stt.autoVolumeTarget",
          name: "Volume While Listening",
          description: "The volume to drop to while listening.",
          type: "number_slider",
          defaultValue: 20,
          min: 0,
          max: 100,
          step: 1,
          suffix: "%",
          visibleWhen: {
            allOf: [
              { field: "stt.enabled", eq: true },
              { field: "stt.autoVolumeEnabled", eq: true },
            ],
          },
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
      label: "Transcription",
      destination: "client",
      visibleWhen: { field: "stt.enabled", eq: true },
      fields: [
        {
          id: "stt.llmAutocorrect",
          name: "Clean Up Transcription",
          description: "Use the model to fix transcription mistakes after you dictate.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "stt.llmChainTranscription",
          name: "Merge Into Existing Text",
          description:
            "When the input already has text, blend in new dictation instead of replacing it. Turns off Send After Dictation.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "stt.autoSend",
          name: "Send After Dictation",
          description:
            "Send your message automatically once transcription finishes. Turns off Merge Into Existing Text.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Speech Recognition",
      destination: "core",
      visibleWhen: { field: "stt.enabled", eq: true },
      fields: [
        {
          id: "stt.provider",
          name: "Provider",
          description:
            "Run speech recognition on the core's device (private) or send audio to an external API.",
          type: "select",
          defaultValue: "local",
          options: [
            { value: "local", label: "Local" },
            { value: "external", label: "External" },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "stt.preset",
          name: "Preset",
          visibleWhen: { field: "stt.provider", eq: "local" },
          description:
            "Curated speech recognition models. Editing the settings below switches this to Custom.",
          type: "stt_preset",
          defaultValue: "light-multilingual",
          presetConfig: {
            // Each card's model and threads resolve from the signed model
            // catalog at runtime (no static `defaults`), so list the keys they
            // manage here: editing either flips the preset to Custom.
            managedKeys: ["stt.modelPath", "stt.threads"],
            // The client fills each card's badges (model name, size, language)
            // from GET /api/v1/models/stt/catalog; selecting a card calls
            // POST /api/v1/models/stt/select { presetId }.
            options: [
              {
                id: "light-english",
                label: "Light (English)",
                title: "Light (English)",
                description:
                  "English-only and fast with low memory use. Slightly more accurate than the multilingual model of the same size when you only dictate in English.",
              },
              {
                id: "light-multilingual",
                label: "Light (Multilingual)",
                title: "Light (Multilingual)",
                description: "Solid transcription in about 100 languages with low memory use.",
              },
              {
                id: "accurate",
                label: "Accurate",
                title: "Accurate",
                description:
                  "The most accurate option for every language, including English. Uses about three times the memory of the light models.",
              },
            ],
            secondaryOptions: [
              {
                id: "custom",
                label: "Custom",
                title: "Custom",
                description:
                  "Pick any model and quantization from the catalog, or configure the model path, threads, and ports yourself.",
              },
            ],
          },
        },
      ],
    },
    {
      label: "Model Server Configuration",
      destination: "core",
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
          name: "Model File",
          description:
            "Path to the speech recognition model file, e.g. @user/repo/branch/model.bin.",
          type: "string",
          defaultValue: "@ggerganov/whisper.cpp/main/ggml-small-q8_0.bin",
          descriptionTier: "ondemand",
        },
        {
          id: "stt.threads",
          name: "CPU Threads",
          description: "How many CPU threads to use.",
          type: "number",
          defaultValue: 4,
          descriptionTier: "ondemand",
        },
        {
          id: "stt.host",
          name: "Host",
          description: "Address the speech recognition server binds to.",
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
          id: "stt.port",
          name: "Port",
          description: "Port the speech recognition server listens on.",
          type: "string",
          defaultValue: "7702",
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
          id: "stt.commandPreview",
          name: "Command Preview",
          description: "",
          type: "command_preview",
          defaultValue: "",
          commandType: "stt",
        },
      ],
    },
    {
      label: "External Provider",
      destination: "core",
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
            "The speech recognition API endpoint. Must be HTTPS (HTTP allowed only for localhost).",
          type: "string",
          defaultValue: "",
          placeholder: "https://api.example.com/v1",
          regex: SECURE_URL_VALIDATION,
          descriptionTier: "ondemand",
        },
        {
          id: "stt.external.apiKey",
          name: "API Key",
          description: "API key for speech recognition. Stored securely in your keychain.",
          type: "password",
          defaultValue: "",
          placeholder: "sk-...",
          descriptionTier: "ondemand",
        },
        {
          id: "stt.external.model",
          name: "Model",
          description: "The speech recognition model name, e.g. whisper-1.",
          type: "string",
          defaultValue: "",
          placeholder: "whisper-1",
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
