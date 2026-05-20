import type { SettingGroup } from "../types";
import { SECURE_URL_VALIDATION } from "../types";

export const sttGroup: SettingGroup = {
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
            "When text is already in the input, use the language model to merge a new transcription into it rather than replacing it.\n\nDisable to always append as a new line.\n\nMutually exclusive with Auto Send: enabling this turns Auto Send off.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "stt.autoSend",
          name: "Auto Send After Transcription",
          description:
            "Automatically send the message as soon as transcription completes.\n\nMutually exclusive with Merge Voice Into Existing Text: enabling this turns merging off.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
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
          type: "number_slider",
          defaultValue: 20,
          min: 0,
          max: 100,
          step: 1,
          suffix: "%",
          visibleWhen: { field: "stt.autoVolumeEnabled", eq: true },
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
                  "stt.modelPath": "@distil-whisper/distil-small.en/main/ggml-distil-small.en.bin",
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
                  "stt.modelPath": "@distil-whisper/distil-medium.en/main/ggml-medium-32-2.en.bin",
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
};
