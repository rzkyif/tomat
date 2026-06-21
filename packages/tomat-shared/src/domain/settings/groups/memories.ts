import type { SettingGroup } from "../types.ts";

// Memories: one group, two tabs. "Management" (default) is the full-height
// object_management manager; "Configuration" holds the relevant-memories
// options.
export const memoriesGroup: SettingGroup = {
  id: "memories",
  destination: "core",
  name: "Memories",
  description:
    "Markdown memories the agent can read and edit. Reference one while typing with @name.",
  descriptionTier: "always",
  icon: "i-material-symbols-description-rounded",
  iconInactive: "i-material-symbols-description-outline-rounded",
  tabs: [
    { id: "manage", label: "Management" },
    { id: "config", label: "Configuration" },
  ],
  sections: [
    {
      tab: "config",
      fields: [
        {
          id: "memories.enabled",
          name: "Use Relevant Memories",
          description:
            "Let the agent see short summaries of memories related to your message, and read the full ones it needs.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "memories.maxRelevant",
          name: "Max Relevant Memories",
          description: "How many memory summaries to include per message.",
          type: "number_slider",
          defaultValue: 3,
          min: 1,
          max: 10,
          step: 1,
          visibleWhen: { field: "memories.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "memories.showEmptySelection",
          name: "Show Empty Selections",
          description:
            "Keep the memory-selection bubble in the chat even when no memories were found relevant to your message. Off hides it; turning it on also reveals past empty ones.",
          type: "boolean",
          defaultValue: false,
          visibleWhen: { field: "memories.enabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      tab: "manage",
      fields: [
        {
          id: "memories.list",
          name: "Memories",
          type: "object_management",
          objectType: "memories",
          defaultValue: "",
        },
      ],
    },
  ],
};
