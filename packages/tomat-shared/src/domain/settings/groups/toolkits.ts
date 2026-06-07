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
  description: "Installed toolkits are shown by default. Add @npm to search the npm marketplace.",
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
  icon: "i-material-symbols-build-rounded",
  iconInactive: "i-material-symbols-build-outline-rounded",
  sections: [
    {
      fields: [
        {
          id: "tools.enabled",
          name: "Enable Tool Use",
          description:
            "Allow trusted toolkits to inject tools into each chat turn.\nWhen on, relevant tools are added to the model request, letting it call them mid-turn.",
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
          name: "Enable Relevance Filtering",
          description:
            "Filter the available toolset down to a relevance-ranked shortlist before each turn (embedding similarity + optional AI second pass).\nDisable to send every enabled tool to the model on every turn. Simpler, but eats more context and slows down small models when many toolkits are installed.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "always",
        },
        {
          id: "tools.filteringMinTools",
          name: "Skip Filtering If Fewer Tools",
          description:
            "Skip filtering and send all enabled tools to the model when the total tool count is below this number.\nUseful when you only have a handful of tools and would rather not pay the embedding+AI cost. Set to 0 to always filter.",
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
          name: "Bypass Filter for Essential Tools",
          description:
            "When on, tools whose toolkit declares `alwaysAvailable: true` skip the relevance filter and are always sent to the model.\nOnly takes effect when filtering is enabled; disabling filtering already sends every tool, so the bypass is redundant.",
          type: "boolean",
          defaultValue: true,
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "always",
        },
        {
          id: "tools.maxTools",
          name: "Max Tools Per Turn",
          description:
            "Cap on tools passed to the main model. When the AI filter is enabled, applied after filtering as a final cap; when disabled, applied directly to the embedding-similarity ranking.",
          type: "number",
          defaultValue: 30,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.secondPassEnabled",
          name: "Use AI to Refine Tool Selection",
          description:
            "Run a second-pass AI filter to drop clearly unrelated tools after the embedding-similarity pass.\nDisable to use only embedding similarity ranking truncated to Max Tools.",
          type: "boolean",
          defaultValue: true,
          visibleWhen: { field: "tools.filteringEnabled", eq: true },
          descriptionTier: "ondemand",
        },
        {
          id: "tools.filterReasoning",
          name: "Filter Reasoning Mode",
          description:
            "Whether the second-pass filter should produce a reasoning trace before its answer.\nMay improve filtering accuracy on borderline cases but slows down responses.",
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
          name: "Max Tokens for Filter Thinking",
          description: "Number of tokens reserved for the filter reasoning trace.",
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
          name: "Max Tool Calls Per Message",
          description:
            "Hard cap on consecutive tool-call rounds within a single user turn.\nProtects against runaway loops when a tool's output keeps the model requesting more calls.",
          type: "number",
          defaultValue: 5,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Worker Pool",
      defaultCollapsed: true,
      visibleWhen: { field: "tools.enabled", eq: true },
      fields: [
        {
          id: "toolkits.maxWarmWorkers",
          name: "Max Active Tool Processes",
          description:
            "Maximum number of toolkit workers kept alive at once.\nHigher values reduce cold-start latency; lower values cap resident memory when hundreds of toolkits are enabled.",
          type: "number",
          defaultValue: 8,
          regex: [{ regex: "^[1-9][0-9]?$", errorMessage: "Must be 1-99" }],
          descriptionTier: "ondemand",
        },
        {
          id: "toolkits.workerIdleMs",
          name: "Unload Inactive Tools After",
          description:
            "Terminate a warm worker after this long with no tool calls.\nShorter values free memory faster; longer values keep frequently-used toolkits warm.",
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
          name: "Tool Call Timeout",
          description:
            "Hard upper bound for a single tool call before it is aborted with an error.\nThe timer is paused while a tool is waiting for user input, so a slow human response never causes a timeout. Set to 0 to disable.",
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
          name: "Ignore Postinstall Scripts",
          description:
            "Pass `--ignore-scripts` to `bun install` so dependency postinstall hooks don't run.\nRecommended on: postinstall scripts from transitive dependencies are a common vector for surprise code execution. Disable only if a toolkit's dependencies require native builds.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
      ],
    },
  ],
};
