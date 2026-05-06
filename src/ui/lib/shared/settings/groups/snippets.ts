import type { SettingGroup } from "../types";

export const snippetsGroup: SettingGroup = {
  id: "snippets",
  name: "Snippets",
  icon: "i-material-symbols-text-snippet-rounded",
  iconInactive: "i-material-symbols-text-snippet-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "prompts.snippets",
          name: "Snippets",
          description:
            "Reusable text fragments triggered via @trigger in the chat input. Snippets can prepend, append, replace, or insert text into either the user message or the system prompt.",
          type: "snippets",
          defaultValue: "",
          descriptionTier: "always",
        },
      ],
    },
  ],
};
