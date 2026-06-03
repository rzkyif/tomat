import type { SettingGroup } from "../types.ts";
import {
  ASSISTANT_PROMPT,
  DEFAULT_AUTOCORRECT_PROMPT,
  DEFAULT_COMPLEXITY_DETECTION_PROMPT,
  DEFAULT_CONTEXT_TEMPLATE,
  DEFAULT_MERGE_TRANSCRIPTION_PROMPT,
  DEFAULT_TITLE_GENERATION_PROMPT,
  TOOL_ONLY_PROMPT,
} from "../../prompts.ts";

export const promptsGroup: SettingGroup = {
  id: "prompts",
  destination: "core",
  name: "Prompts",
  icon: "i-material-symbols-chat-bubble-rounded",
  iconInactive: "i-material-symbols-chat-bubble-outline-rounded",
  sections: [
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
                description: "No system prompt is sent. The model runs with its default behavior.",
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
          name: "Prompt",
          description:
            "The system prompt sent to the agent.\nEditing this manually switches the preset to Custom.",
          type: "multiline",
          defaultValue: "",
          optional: true,
          visibleWhen: {
            field: "prompts.defaultSystemPrompt.preset",
            eq: "custom",
          },
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Context Template",
      defaultCollapsed: true,
      fields: [
        {
          id: "prompts.contextTemplate",
          name: "Template",
          description:
            "Template appended to the system prompt when any context setting (agent name, language, location, date/time, OS, etc.) is enabled.\nUse `{name}` for placeholders and `[name:body]` for conditional segments that disappear when the named setting is unset. Available names: agentName, language, userName, location, dateTime, os.\nThe `[toolsAvailable:body]` segment is special: it does not render in the steady-state context, but its body is appended on turns where at least one toolkit tool passes the relevance filter. Edit or remove that segment to customize the tool-use nudge.",
          type: "multiline",
          defaultValue: DEFAULT_CONTEXT_TEMPLATE,
          regex: [{ regex: "\\S", errorMessage: "Template cannot be empty" }],
          mono: true,
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Title Generation",
      defaultCollapsed: true,
      fields: [
        {
          id: "prompts.titleGenerationPrompt",
          name: "Title Generation Prompt",
          description:
            "Prompt used to auto-generate a short session title from the first user message.",
          type: "multiline",
          defaultValue: DEFAULT_TITLE_GENERATION_PROMPT,
          regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Autocorrect",
      defaultCollapsed: true,
      fields: [
        {
          id: "prompts.autocorrectPrompt",
          name: "Autocorrect Prompt",
          description:
            "Prompt used to clean up speech-to-text transcriptions before they reach the chat input.",
          type: "multiline",
          defaultValue: DEFAULT_AUTOCORRECT_PROMPT,
          regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Merge Transcription",
      defaultCollapsed: true,
      fields: [
        {
          id: "prompts.mergeTranscriptionPrompt",
          name: "Merge Transcription Prompt",
          description:
            "Prompt used to merge a fresh speech-to-text transcription into the existing text already in the chat input.",
          type: "multiline",
          defaultValue: DEFAULT_MERGE_TRANSCRIPTION_PROMPT,
          regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Complexity Detection",
      defaultCollapsed: true,
      fields: [
        {
          id: "prompts.complexityDetectionPrompt",
          name: "Complexity Detection Prompt",
          description:
            "System prompt used by the default model to classify each new user message before it is answered.\nThe reply is matched case-insensitively: if it contains the word `complex` without `simple` the request is routed to the secondary model, otherwise it stays on the default model. A reply that is ambiguous or empty falls back to the default model.",
          type: "multiline",
          defaultValue: DEFAULT_COMPLEXITY_DETECTION_PROMPT,
          regex: [{ regex: "\\S", errorMessage: "Prompt cannot be empty" }],
          descriptionTier: "always",
        },
      ],
    },
  ],
};
