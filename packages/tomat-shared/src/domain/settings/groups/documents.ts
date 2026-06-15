import type { SettingGroup } from "../types.ts";

// Documents: one group, two tabs. "Management" (default) is the full-height
// object_management manager; "Configuration" holds the relevant-documents
// options.
export const documentsGroup: SettingGroup = {
  id: "documents",
  destination: "core",
  name: "Documents",
  description: "Markdown notes the agent can read and edit. Reference one while typing with @name.",
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
          id: "documents.enabled",
          name: "Use Relevant Documents",
          description:
            "Let the agent see short summaries of documents related to your message, and read the full ones it needs.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "documents.maxRelevant",
          name: "Max Relevant Documents",
          description: "How many document summaries to include per message.",
          type: "number_slider",
          defaultValue: 3,
          min: 1,
          max: 10,
          step: 1,
          visibleWhen: { field: "documents.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "documents.showEmptySelection",
          name: "Show Empty Selections",
          description:
            "Keep the document-selection bubble in the chat even when no documents were found relevant to your message. Off hides it; turning it on also reveals past empty ones.",
          type: "boolean",
          defaultValue: false,
          visibleWhen: { field: "documents.enabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      tab: "manage",
      fields: [
        {
          id: "documents.list",
          name: "Documents",
          type: "object_management",
          objectType: "documents",
          defaultValue: "",
        },
      ],
    },
  ],
};
