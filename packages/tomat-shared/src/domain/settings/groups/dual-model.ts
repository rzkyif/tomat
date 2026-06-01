import type { SettingGroup } from "../types.ts";
import { SECURE_URL_VALIDATION } from "../types.ts";

export const dualModelGroup: SettingGroup = {
  id: "dualModel",
  destination: "core",
  name: "Dual Model",
  icon: "i-material-symbols-call-split-rounded",
  iconInactive: "i-material-symbols-call-split-rounded",
  sections: [
    {
      fields: [
        {
          id: "dualModel.enabled",
          name: "Enable Dual Model",
          description:
            "Route complex prompts to a stronger external model while keeping simple prompts on the default model.\nThe detection prompt is configured in the Prompts group.",
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
            "API endpoint URL. Must use HTTPS for remote hosts; HTTP is only allowed for localhost.",
          type: "string",
          defaultValue: "",
          placeholder: "https://api.example.com/v1",
          regex: SECURE_URL_VALIDATION,
          descriptionTier: "ondemand",
        },
        {
          id: "dualModel.external.apiKey",
          name: "API Key",
          description: "Authentication key.",
          type: "password",
          defaultValue: "",
          placeholder: "sk-...",
          descriptionTier: "none",
        },
        {
          id: "dualModel.external.model",
          name: "Model",
          description: "Model identifier to use.",
          type: "string",
          defaultValue: "",
          placeholder: "gpt-4o",
          descriptionTier: "none",
        },
        {
          id: "dualModel.external.contextSize",
          name: "Context Window Size",
          description: "Maximum context window length, used for usage tracking.",
          type: "number",
          defaultValue: 128000,
          advanced: true,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
