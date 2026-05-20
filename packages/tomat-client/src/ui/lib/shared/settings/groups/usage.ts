import type { SettingGroup } from "../types";

export const usageGroup: SettingGroup = {
  id: "usage",
  name: "Usage",
  icon: "i-material-symbols-analytics-rounded",
  iconInactive: "i-material-symbols-analytics-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "usage.services",
          name: "Services",
          description: "Live memory and CPU usage for each local service.",
          type: "services",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
        {
          id: "usage.storage",
          name: "Storage",
          description:
            "Downloaded models and saved sessions.\nSelect items and press Delete (or ⌘⌫) to remove them.",
          type: "storage",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
