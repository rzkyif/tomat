import type { SettingGroup } from "../types.ts";

// Toolkit management lives in its own group with a single object_management
// field, so the manager owns the full panel height (vertical scroll). The
// tool-calling options that used to share this group moved to `toolsGroup`
// below. The manager is intentionally NOT gated behind `tools.enabled`: you can
// install and configure toolkits before turning tool use on.
export const toolkitsGroup: SettingGroup = {
  id: "toolkits",
  destination: "core",
  name: "Toolkits",
  description:
    "Toolkits give the agent tools it can use, like web search or file access. Installed toolkits show here; type @npm to search the npm registry for packages tagged `tools-available`.",
  descriptionTier: "always",
  icon: "i-material-symbols-extension-rounded",
  iconInactive: "i-material-symbols-extension-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "toolkits.list",
          name: "Toolkits",
          type: "object_management",
          objectType: "toolkits",
          defaultValue: "",
        },
      ],
    },
  ],
};

// Tool-calling runtime options, split out of the old combined Tools group so
// toolkit management can be its own single-field group. `tools.enabled` gates
// the rest, exactly as before.
export const toolsGroup: SettingGroup = {
  id: "tools",
  destination: "core",
  name: "Tool Calling",
  description: "Let the agent use tools from your installed toolkits during a chat.",
  descriptionTier: "ondemand",
  icon: "i-material-symbols-build-rounded",
  iconInactive: "i-material-symbols-build-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "tools.enabled",
          name: "Enable Tools",
          description: "Let the agent call tools from your enabled toolkits while chatting.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Tool Selection",
      defaultCollapsed: true,
      visibleWhen: { field: "tools.enabled", eq: true },
      fields: [
        {
          id: "tools.filteringEnabled",
          name: "Select Relevant Tools",
          description:
            "Before each message, offer the model only the tools likely to help instead of all of them. Keeps things fast and focused when you have many tools.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "tools.filteringMinTools",
          name: "Skip When Few Tools",
          description:
            "When you have fewer than this many tools, skip selection and offer them all. 0 always selects.",
          type: "number",
          defaultValue: 0,
          regex: [
            {
              regex: "^([0-9]|[1-9][0-9]{1,2}|1000)$",
              errorMessage: "Must be 0-1000",
            },
          ],
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.alwaysAvailableEnabled",
          name: "Allow Always-Available Tools",
          description:
            "Let toolkits mark tools as always available, so they're offered every message without going through selection.",
          type: "boolean",
          defaultValue: true,
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.maxTools",
          name: "Max Tools Per Message",
          description: "The most tools to offer the model at once.",
          type: "number",
          defaultValue: 30,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.secondPassEnabled",
          name: "Refine Selection With AI",
          description:
            "After the quick relevance match, have the model review the shortlist and drop tools that don't fit. More accurate, a little slower.",
          type: "boolean",
          defaultValue: true,
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.filterReasoning",
          name: "Refinement Thinking",
          description: "Whether the AI refinement step should think before deciding.",
          type: "select",
          defaultValue: "off",
          options: [
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
            { value: "auto", label: "Auto" },
          ],
          visibleWhen: {
            allOf: [
              { field: "tools.filteringEnabled", eq: true },
              { field: "tools.secondPassEnabled", eq: true },
            ],
          },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.filterReasoningBudget",
          name: "Refinement Thinking Budget",
          description: "How many tokens the AI refinement step may spend thinking.",
          type: "number",
          defaultValue: "",
          visibleWhen: {
            allOf: [
              { field: "tools.filteringEnabled", eq: true },
              { field: "tools.filterReasoning", neq: "off" },
            ],
          },
          optional: true,
          placeholder: "optional",
          descriptionTier: "ondemand",
        },
        {
          id: "tools.maxHops",
          name: "Max Tool Rounds Per Message",
          description: "Cap on back-to-back tool calls in one message, to prevent runaway loops.",
          type: "number",
          defaultValue: 5,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Tool Execution",
      defaultCollapsed: true,
      visibleWhen: { field: "tools.enabled", eq: true },
      fields: [
        {
          id: "toolkits.maxWarmWorkers",
          name: "Tools Kept Ready",
          description:
            "How many tools to keep loaded for instant reuse. Higher cuts delay; lower saves memory.",
          type: "number",
          defaultValue: 8,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          descriptionTier: "ondemand",
        },
        {
          id: "toolkits.workerIdleMs",
          name: "Unload Tools After",
          description: "Unload a tool from memory after this long unused.",
          type: "number",
          defaultValue: 300000,
          suffix: "ms",
          regex: [
            {
              regex: "^[0-9]+$",
              errorMessage: "Must be a non-negative integer",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "toolkits.callTimeoutMs",
          name: "Tool Timeout",
          description:
            "Stop a tool if a single call runs longer than this. Waiting on you doesn't count. 0 disables.",
          type: "number",
          defaultValue: 60000,
          suffix: "ms",
          regex: [
            {
              regex: "^[0-9]+$",
              errorMessage: "Must be a non-negative integer",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "toolkits.ignorePostinstallScripts",
          name: "Block Install Scripts",
          description:
            "Stop toolkit dependencies from running setup scripts during install, a common malware path. Leave on unless a toolkit must build native code.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
