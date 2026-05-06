import type { SettingGroup } from "../types";

export const generalGroup: SettingGroup = {
  id: "general",
  name: "General",
  icon: "i-material-symbols-tune-rounded",
  iconInactive: "i-material-symbols-tune-rounded",
  sections: [
    {
      label: "Context",
      fields: [
        {
          id: "general.context.userName",
          name: "Your Name",
          description: "How the agent should address you.",
          type: "string",
          defaultValue: "",
          optional: true,
          placeholder: "e.g. Alex",
          descriptionTier: "none",
        },
        {
          id: "general.context.agentName",
          name: "Agent Name",
          description: "A name for the agent. Leave empty to let the agent pick or stay nameless.",
          type: "string",
          defaultValue: "",
          optional: true,
          placeholder: "e.g. Sebastian",
          descriptionTier: "ondemand",
        },
        {
          id: "general.context.language",
          name: "Language",
          description: "The language you prefer to communicate in.",
          type: "string",
          defaultValue: "",
          optional: true,
          placeholder: "e.g. English",
          descriptionTier: "none",
        },
        {
          id: "general.context.locationAuto",
          name: "Auto-Detect Location",
          description:
            "Derive your location from the system timezone instead of typing it manually.\nFully offline, no network calls, no permissions.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "general.context.location",
          name: "Location",
          description: "A location the agent can reference. Sent as plain text. No network calls.",
          type: "string",
          defaultValue: "",
          optional: true,
          placeholder: "e.g. San Francisco, CA",
          visibleWhen: { field: "general.context.locationAuto", eq: false },
          descriptionTier: "none",
        },
        {
          id: "general.context.dateTime",
          name: "Share Current Date and Time",
          description: "Attach the current date and time to the system prompt.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "none",
        },
        {
          id: "general.context.os",
          name: "Share Operating System",
          description: "Attach your operating system to the system prompt.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "none",
        },
      ],
    },
    {
      label: "Sessions",
      fields: [
        {
          id: "general.session.alwaysStartNew",
          name: "Start Fresh Each Time",
          description:
            "When the app starts, always begin a new empty session instead of resuming the last one.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
        {
          id: "general.session.storeSessions",
          name: "Save Chat History",
          description:
            "Persist messages and session titles to disk.\nWhen disabled, sessions live only in memory and are cleared when the app closes.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
