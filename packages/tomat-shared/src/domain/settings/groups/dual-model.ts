import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const dualModelGroup: SettingGroup = {
  id: "dualModel",
  destination: "core",
  name: "Dual Model",
  description:
    "Keep simple messages on your fast default model and send only complex ones to a stronger model. tomat decides per message; you never switch manually.",
  descriptionTier: "always",
  icon: "i-material-symbols-call-split-rounded",
  iconInactive: "i-material-symbols-call-split-rounded",
  sections: [
    {
      fields: [
        {
          id: "dualModel.enabled",
          name: "Enable Dual Model",
          description:
            "Route complex messages to a stronger secondary model automatically. The rule that decides this lives in Prompts > Complexity Check.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Secondary Model",
      visibleWhen: { field: "dualModel.enabled", eq: true },
      fields: [
        {
          id: "dualModel.external.baseUrl",
          name: "Base URL",
          description:
            "The secondary model's API endpoint. Must be HTTPS (HTTP allowed only for localhost).",
          type: "string",
          defaultValue: "",
          placeholder: "https://api.example.com/v1",
          regex: SECURE_URL_VALIDATION,
          descriptionTier: "ondemand",
        },
        {
          id: "dualModel.external.apiKey",
          name: "API Key",
          description: "API key for the secondary model. Stored securely in your keychain.",
          type: "password",
          defaultValue: "",
          placeholder: "sk-...",
          descriptionTier: "ondemand",
        },
        {
          id: "dualModel.external.model",
          name: "Model",
          description: "The secondary model name, e.g. gpt-4o.",
          type: "string",
          defaultValue: "",
          placeholder: "gpt-4o",
          descriptionTier: "ondemand",
        },
        {
          id: "dualModel.external.contextSize",
          name: "Context Window",
          description: "The model's context window, in tokens. Used to track usage.",
          type: "number",
          defaultValue: 128000,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
