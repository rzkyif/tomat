import type { SettingGroup } from "../types.ts";

// The Usage group spans both destinations: it shows live resource usage and
// on-disk storage for the local client AND the paired core, split into two
// collapsible sections. All fields are render-only (no persisted values).
export const usageGroup: SettingGroup = {
  id: "usage",
  destination: ["client", "core"],
  name: "Usage",
  icon: "i-material-symbols-analytics-rounded",
  iconInactive: "i-material-symbols-analytics-outline-rounded",
  sections: [
    {
      label: "Client",
      fields: [
        {
          id: "usage.clientServices",
          name: "Services",
          description: "Live memory and CPU usage for the desktop app.",
          type: "services",
          scope: "client",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
        {
          id: "usage.clientStorage",
          name: "Storage",
          description:
            "App data stored on this device (settings, logs). Clear logs or reset client settings to defaults.",
          type: "storage",
          scope: "client",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Core",
      fields: [
        {
          id: "usage.coreServices",
          name: "Services",
          description: "Live memory and CPU usage for the core service and its local sidecars.",
          type: "services",
          scope: "core",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
        {
          id: "usage.coreStorage",
          name: "Storage",
          description:
            "Everything the core keeps on disk, by category. Select items and press Delete (or ⌘⌫), or use Clear per category. Items in use are protected; clearing Settings resets everything to defaults.",
          type: "storage",
          scope: "core",
          defaultValue: "",
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
