import type { SettingGroup } from "../types.ts";

export const documentsGroup: SettingGroup = {
  id: "documents",
  destination: "core",
  name: "Documents",
  description: "Markdown notes the agent can read and edit. Reference one while typing with @name.",
  descriptionTier: "always",
  icon: "i-material-symbols-description-rounded",
  iconInactive: "i-material-symbols-description-outline-rounded",
  sections: [
    {
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
    {
      label: "Document Sharing",
      defaultCollapsed: true,
      fields: [
        {
          id: "documents.enabled",
          name: "Share Relevant Documents",
          description:
            "Let the agent see short summaries of documents related to your message, and read the full ones it needs.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "documents.maxRelevant",
          name: "Max Shared Documents",
          description: "How many document summaries to share per message.",
          type: "number_slider",
          defaultValue: 3,
          min: 1,
          max: 10,
          step: 1,
          visibleWhen: { field: "documents.enabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
