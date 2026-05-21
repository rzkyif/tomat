// Client-side STT settings — microphone input UX, VAD activation, and
// post-processing prefs. Persisted to ~/.tomat/client/settings.json. The
// engine side (whisper-server config, provider URLs) lives in `sttEngine`.

import type { SettingGroup } from "../types.ts";

export const sttInputGroup: SettingGroup = {
  id: "stt_input",
  destination: "client",
  name: "Speech Input",
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
      label: "Transcription Post-Processing",
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
  ],
};
