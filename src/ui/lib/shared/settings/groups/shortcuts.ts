import type { SettingGroup } from "../types";

export const shortcutsGroup: SettingGroup = {
  id: "shortcuts",
  name: "Shortcuts",
  icon: "i-material-symbols-keyboard-rounded",
  iconInactive: "i-material-symbols-keyboard-outline-rounded",
  sections: [
    {
      label: "Global",
      fields: [
        {
          id: "shortcuts.toggleWindow",
          name: "Show / Hide Window",
          description: "Click the field and press a key combination to set it. Clear to disable.",
          type: "shortcut",
          defaultValue: "super+ctrl+shift+z",
          optional: true,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Input",
      fields: [
        {
          id: "shortcuts.attachFile",
          name: "Attach File",
          description:
            "Open the file picker to attach a file to the next message.\nOnly active while the chat input is focused.",
          type: "shortcut",
          defaultValue: "super+ctrl+shift+a",
          optional: true,
          descriptionTier: "ondemand",
        },
        {
          id: "shortcuts.captureScreen",
          name: "Capture Full Screen",
          description:
            "Capture the primary monitor as an image attachment.\nOnly active while the chat input is focused.",
          type: "shortcut",
          defaultValue: "super+ctrl+shift+s",
          optional: true,
          descriptionTier: "ondemand",
        },
        {
          id: "shortcuts.captureRegion",
          name: "Capture Screen Area",
          description:
            "Open the region-capture overlay so you can drag-select a rectangle to attach.\nOnly active while the chat input is focused.",
          type: "shortcut",
          defaultValue: "super+ctrl+shift+x",
          optional: true,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
