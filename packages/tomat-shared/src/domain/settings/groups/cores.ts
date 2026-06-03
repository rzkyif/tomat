import type { SettingGroup } from "../types.ts";

// Paired-cores registry. Backed by client settings.json (the {id, name,
// baseUrl, addedAtMs} triples plus a `currentCoreId` pointer) + OS keychain
// (the bearer tokens). The list itself is managed by
// `packages/tomat-client/src/ui/lib/core/cores.ts` via the platform's
// clientSettings.read/write, not by the settingsState save loop. This
// schema entry exists so the per-key destination map in settingsState
// knows the `cores.list` key belongs to the client destination, and so
// the Settings UI has a stable group id to slot a paired-clients panel
// into in the future.
//
// The group is `hidden: true` so it is omitted from the settings UI
// entirely until a real rendering component lands; the `cores.list` field
// has type "cores", which is currently a no-op in SettingsField.
// Registering it means the field-type union is honest about what the schema
// can carry.
export const coresGroup: SettingGroup = {
  id: "cores",
  hidden: true,
  destination: "client",
  name: "Paired Cores",
  icon: "i-material-symbols-hub-rounded",
  iconInactive: "i-material-symbols-hub-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "cores.list",
          name: "Paired Cores",
          description:
            "Cores this client is paired with. Add/remove via the pairing flow; tokens live in the OS keychain.",
          type: "cores",
          defaultValue: "",
          descriptionTier: "always",
        },
      ],
    },
  ],
};
