import type { SettingGroup } from "../types.ts";

// Core HTTP server settings. Persisted in ~/.tomat/core/settings.json
// (destination: "core") because they affect the binding of the core's
// HTTP listener itself. Toggling requires a core restart.
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
          id: "server.bindHost",
          name: "Network Interface",
          description:
            "Which network interface the core's HTTP server listens on. Leave as 127.0.0.1 to accept connections from this computer only (the default). Set a specific LAN IP to accept connections on just that interface, or 0.0.0.0 to accept on every interface so other devices can pair.\nConnections are unencrypted plain HTTP, so only widen this on a network you trust. Requires a core restart to take effect.",
          type: "string",
          defaultValue: "127.0.0.1",
          placeholder: "127.0.0.1",
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
