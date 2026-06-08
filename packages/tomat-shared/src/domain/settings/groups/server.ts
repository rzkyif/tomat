import type { SettingGroup } from "../types.ts";

// Core HTTP server settings. Persisted in ~/.tomat/core/settings.json
// (destination: "core") because they affect the binding of the core's
// HTTP listener itself. Toggling requires a core restart.
export const serverGroup: SettingGroup = {
  id: "server",
  destination: "core",
  name: "Server",
  description: "How the core is reachable on the network and how it updates itself.",
  descriptionTier: "ondemand",
  icon: "i-material-symbols-host-rounded",
  iconInactive: "i-material-symbols-host-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "server.bindHost",
          name: "Network Access",
          description:
            "Who can reach this core. 127.0.0.1 is this computer only; a LAN address or 0.0.0.0 lets other devices pair. Traffic is always encrypted. Restart the core to apply.",
          type: "string",
          defaultValue: "127.0.0.1",
          placeholder: "127.0.0.1",
          descriptionTier: "always",
        },
        {
          id: "updates.allowDowngrade",
          name: "Allow Downgrades",
          description:
            "Let updates install an older version than you're running. Off is safer; turn on only for a deliberate rollback.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
