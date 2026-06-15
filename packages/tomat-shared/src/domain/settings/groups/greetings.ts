import type { SettingGroup } from "../types.ts";
import { DEFAULT_GREETING_INSTRUCTION } from "../../prompts.ts";

export const greetingsGroup: SettingGroup = {
  id: "greetings",
  destination: "core",
  name: "Greetings",
  description: "Have the agent open a session to greet you when the app starts.",
  descriptionTier: "ondemand",
  icon: "i-material-symbols-waving-hand-rounded",
  iconInactive: "i-material-symbols-waving-hand-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "greetings.enabled",
          name: "Enable Greetings",
          description: "",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "none",
        },
        {
          id: "greetings.runOn",
          name: "When to Greet",
          description: "Greet on every start, or only when tomat opens itself at login.",
          type: "select",
          defaultValue: "autostart",
          options: [
            { value: "autostart", label: "Automatic Start Only" },
            { value: "every_start", label: "Every Start" },
          ],
          visibleWhen: { field: "greetings.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "greetings.sessionTitle",
          name: "Session Title",
          description:
            'Title for the session a greeting opens. Use {datetime} to insert the start time, e.g. "Greeting 2026-06-15 14:30".',
          type: "string",
          defaultValue: "Greeting {datetime}",
          visibleWhen: { field: "greetings.enabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "greetings.instruction",
          name: "Greeting Prompt",
          description:
            "The prompt sent when a greeting runs. Write it as a message from you to the agent.",
          type: "multiline",
          defaultValue: DEFAULT_GREETING_INSTRUCTION,
          visibleWhen: { field: "greetings.enabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
