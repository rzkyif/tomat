import type { SettingGroup } from "../types.ts";

// Tools: one group with two tabs. "Management" (default) is the full-height
// object_management toolkit manager; "Configuration" holds the tool-calling
// runtime settings. Toolkit management is intentionally NOT gated behind
// `tools.enabled`: you can install and configure toolkits before turning tool
// use on. Setting ids keep their `tools.*` / `toolkits.*` prefixes (persisted
// on disk and on the wire); only the grouping changed.
export const toolsGroup: SettingGroup = {
  id: "tools",
  destination: "core",
  name: "Tools",
  description:
    "Let the agent use tools from your installed toolkits during a chat, like web search or file access. Install and remove toolkits under Management; turn tools on and tune how the agent chooses and runs them under Configuration.",
  descriptionTier: "always",
  icon: "i-material-symbols-build-rounded",
  iconInactive: "i-material-symbols-build-outline-rounded",
  tabs: [
    { id: "manage", label: "Management" },
    { id: "config", label: "Configuration" },
  ],
  sections: [
    {
      tab: "config",
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
      tab: "config",
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
          id: "tools.filterThinkingBudget",
          name: "Refinement Thinking Budget",
          description: "Tokens the AI refinement step may spend thinking. 0 turns thinking off.",
          type: "number",
          defaultValue: 0,
          placeholder: "0",
          visibleWhen: {
            allOf: [
              { field: "tools.filteringEnabled", eq: true },
              { field: "tools.secondPassEnabled", eq: true },
            ],
          },
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
        {
          id: "tools.showEmptySelection",
          name: "Show Empty Selections",
          description:
            "Keep the tool-selection bubble in the chat even when no tools were found relevant to your message. Off hides it; turning it on also reveals past empty ones.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      tab: "config",
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
    {
      tab: "manage",
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
    {
      tab: "manage",
      destination: "client",
      fields: [
        // Hidden persisted flag: set from the risky-permission confirm
        // dialog's "do not show again" checkbox in the toolkit detail view.
        // Never rendered (visibleWhen never matches); the object_management tab
        // shows only its manager. Still registered for persistence + client
        // routing via the flat-sections walk.
        {
          id: "toolkits.skipRiskyGrantWarning",
          name: "Skip Risky Permission Warning",
          description: "",
          type: "boolean",
          defaultValue: false,
          visibleWhen: { field: "toolkits.list", eq: "__never__" },
          descriptionTier: "none",
        },
      ],
    },
  ],
};
