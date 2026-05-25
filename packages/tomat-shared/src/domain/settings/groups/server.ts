import type { SettingGroup } from "../types.ts";

// Core HTTP server settings. Persisted in ~/.tomat/core/settings.json
// (destination: "core") because they affect the binding of the core's
// HTTP listener itself — toggling requires a core restart.
export const serverGroup: SettingGroup = {
  id: "server",
  destination: "core",
  name: "Server",
  icon: "i-material-symbols-dns-rounded",
  iconInactive: "i-material-symbols-dns-outline-rounded",
  sections: [
    {
      label: "Network",
      fields: [
        {
          id: "server.bindAll",
          name: "Allow Network Access",
          description:
            "Bind the HTTP server to 0.0.0.0 so other devices on this network can pair with this core. When off (default), the core only accepts connections from this computer (127.0.0.1).\nRequires a core restart to take effect.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "always",
        },
      ],
    },
    {
      label: "Updates",
      fields: [
        {
          id: "updates.allowDowngrade",
          name: "Allow Version Downgrade",
          description:
            "Permit the auto-updater to install a manifest version older than the running core. Off by default: a signed manifest is normally only meant to roll forward, and accepting a downgrade re-introduces any fixed vulnerabilities. Turn on only for an intentional rollback.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
