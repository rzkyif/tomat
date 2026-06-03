import type { SettingGroup } from "../types.ts";

export const appearanceGroup: SettingGroup = {
  id: "appearance",
  destination: "client",
  name: "Appearance",
  icon: "i-material-symbols-palette",
  iconInactive: "i-material-symbols-palette-outline",
  sections: [
    {
      label: "Theme",
      fields: [
        {
          id: "appearance.theme",
          name: "Color Mode",
          description: "Choose between light, dark, or system-matching theme.",
          type: "select",
          defaultValue: "auto",
          options: [
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "auto", label: "Auto (System)" },
          ],
          descriptionTier: "none",
        },
        {
          id: "appearance.textSize",
          name: "Text Size",
          description: "Base text size for the entire app.\nAccepted range: 12–32 pixels.",
          type: "number",
          defaultValue: 16,
          suffix: "px",
          regex: [
            {
              regex: "^(?:1[2-9]|2[0-9]|3[0-2])$",
              errorMessage: "Must be between 12 and 32",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.defaultFont",
          name: "Default Font",
          description: "Font used throughout the app. Set to Default to use the system font stack.",
          type: "select",
          optionsSource: "fonts",
          defaultValue: "default",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.monoFont",
          name: "Mono Font",
          description:
            "Font used for code, command previews, and other monospace text. Set to Default to use the system monospace stack.",
          type: "select",
          optionsSource: "fonts",
          defaultValue: "default",
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Bubbles",
      fields: [
        {
          id: "appearance.userBubbleColor",
          name: "User Bubble Color",
          description:
            "Color of your message bubbles. Light/dark variants are derived automatically; the picker reflects the current theme but only the light value is saved. Supports transparency via the alpha slider.",
          type: "color",
          defaultValue: "#86efacff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.agentBubbleColor",
          name: "Agent Bubble Color",
          description: "Color of agent message bubbles when the primary model is used.",
          type: "color",
          defaultValue: "#93c5fdff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.secondaryAgentBubbleColor",
          name: "Secondary Agent Bubble Color",
          description:
            "Color of agent message bubbles when the secondary model is used (if dual model is enabled).",
          type: "color",
          defaultValue: "#d8b4feff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.bubbleShadowColor",
          name: "Shadow Color",
          description:
            "Color of the centered drop shadow around bubbles. It inverts automatically between light and dark themes (a black shadow in light becomes white in dark). Set alpha to 0 to disable the shadow.",
          type: "color",
          defaultValue: "#00000033",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.bubbleShadowDistance",
          name: "Shadow Distance",
          description:
            "How far the drop shadow and blur reach out from the bubble edge.\nThe maximum keeps the effect inside the window's padding at the default text size. Accepted range: 0-40 pixels.",
          type: "number_slider",
          defaultValue: 20,
          min: 0,
          max: 40,
          step: 1,
          suffix: "px",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.bubbleBlurEnabled",
          name: "Shadow Blur",
          description:
            "Blur whatever is drawn behind the bubble in a halo around its edge, so it stands out from the apps behind the transparent window. Turn off for a plain drop shadow.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.bubbleBlurRings",
          name: "Shadow Blur Steps",
          description:
            "Number of concentric blur rings drawn around each bubble. More steps make the blur fade out more smoothly, at a higher rendering cost.",
          type: "number_slider",
          defaultValue: 3,
          min: 1,
          max: 6,
          step: 1,
          editableWhen: { field: "appearance.bubbleBlurEnabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Theme Colors",
      fields: [
        {
          id: "appearance.defaultColor",
          name: "Default Color",
          description:
            "Source color for the entire neutral scale used across the app (backgrounds, borders, text, etc.). All nine light shades and their dark variants are derived from this single hex via OKLCH lightness adjustments. Pick a desaturated near-gray for a classic neutral, or a tinted hex for a themed app.",
          type: "color",
          lockedLightness: 0.985,
          defaultValue: "#737373ff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.systemMessageDefaultColor",
          name: "System Message Override",
          description:
            "Override the default color for system-message bubbles (reasoning, tool call, relevant tools). Set alpha to 0 (fully transparent) to inherit the global Default Color.",
          type: "color",
          lockedLightness: 0.985,
          defaultValue: "#00000000",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.userInputDefaultColor",
          name: "User Input Override",
          description:
            "Override the default color for the user input area at the bottom. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
          type: "color",
          lockedLightness: 0.985,
          defaultValue: "#00000000",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.sessionBarDefaultColor",
          name: "Session Bar Override",
          description:
            "Override the default color for the session bar. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
          type: "color",
          lockedLightness: 0.985,
          defaultValue: "#00000000",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.settingsDefaultColor",
          name: "Settings Override",
          description:
            "Override the default color for the settings panel. Set alpha to 0 (fully transparent) to inherit the global Default Color.",
          type: "color",
          lockedLightness: 0.985,
          defaultValue: "#00000000",
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Accent Colors",
      fields: [
        {
          id: "appearance.accentRed",
          name: "Red Accent",
          description:
            "Source color for the red accent scale (used for errors and destructive actions). All shades are derived from this hex.",
          type: "color",
          lockedLightness: 0.922,
          defaultValue: "#ef4444ff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.accentBlue",
          name: "Blue Accent",
          description:
            "Source color for the blue accent scale. All shades are derived from this hex.",
          type: "color",
          lockedLightness: 0.922,
          defaultValue: "#3b82f6ff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.accentPurple",
          name: "Purple Accent",
          description:
            "Source color for the purple accent scale. All shades are derived from this hex.",
          type: "color",
          lockedLightness: 0.922,
          defaultValue: "#a855f7ff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.accentGreen",
          name: "Green Accent",
          description:
            "Source color for the green accent scale (used for success states). All shades are derived from this hex.",
          type: "color",
          lockedLightness: 0.922,
          defaultValue: "#22c55eff",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.accentYellow",
          name: "Yellow Accent",
          description:
            "Source color for the yellow accent scale (used for warnings/loading). All shades are derived from this hex.",
          type: "color",
          lockedLightness: 0.922,
          defaultValue: "#eab308ff",
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Style",
      fields: [
        {
          id: "appearance.roundedSmall",
          name: "Small Roundedness",
          description: "Corner radius used by smaller chrome (code blocks, ToolCall internals).",
          type: "number_slider",
          defaultValue: 6,
          min: 0,
          max: 16,
          step: 1,
          suffix: "px",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.roundedMedium",
          name: "Medium Roundedness",
          description:
            "Corner radius used by inputs, form controls, and small cards (FieldCard, MultilineField, etc.).",
          type: "number_slider",
          defaultValue: 8,
          min: 0,
          max: 20,
          step: 1,
          suffix: "px",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.roundedLarge",
          name: "Large Roundedness",
          description:
            "Corner radius used by message bubbles, modals, and prominent surfaces (SessionBar, system messages).",
          type: "number_slider",
          defaultValue: 16,
          min: 0,
          max: 32,
          step: 1,
          suffix: "px",
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.animationsEnabled",
          name: "Enable Animations",
          description:
            "Smoothly animate message entry, settings transitions, and expandable sections.",
          type: "boolean",
          defaultValue: true,
          descriptionTier: "none",
        },
        {
          id: "appearance.animationSpeedMultiplier",
          name: "Animation Speed",
          description:
            "Speed multiplier for all UI animations.\nHigher values = faster. Accepted range: 25–400%.",
          type: "number_slider",
          defaultValue: 100,
          min: 25,
          max: 400,
          step: 25,
          suffix: "%",
          editableWhen: { field: "appearance.animationsEnabled", eq: true },
          descriptionTier: "ondemand",
        },
      ],
    },
    {
      label: "Layout",
      fields: [
        {
          id: "layout.monitor",
          name: "Monitor",
          description: "Choose which monitor to display the app on.",
          type: "select",
          optionsSource: "monitors",
          defaultValue: "primary",
          descriptionTier: "none",
        },
        {
          id: "layout.alignment",
          name: "Window Alignment",
          description: "Align the window to the left, center, or right of the monitor.",
          type: "select",
          defaultValue: "center",
          options: [
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ],
          descriptionTier: "none",
        },
        {
          id: "layout.width",
          name: "Window Width",
          description: "Width of the app window.\nAccepted range: 400–1200 pixels.",
          type: "number",
          defaultValue: 700,
          suffix: "px",
          regex: [
            {
              regex: "^(?:4[0-9]{2}|[5-9][0-9]{2}|1[01][0-9]{2}|1200)$",
              errorMessage: "Must be between 400 and 1200",
            },
          ],
          descriptionTier: "ondemand",
        },
        {
          id: "appearance.settings.sidebarCollapsed",
          name: "Collapse Settings Sidebar",
          description: "Shrink the settings sidebar to a thin icon strip.",
          type: "boolean",
          defaultValue: false,
          descriptionTier: "none",
        },
        {
          id: "appearance.settings.horizontalThreshold",
          name: "Horizontal Layout Threshold",
          description:
            "Container width at which fields switch to a horizontal layout (label left, input right).\nAccepted range: 400–2999 pixels.",
          type: "number",
          defaultValue: 450,
          suffix: "px",
          descriptionTier: "ondemand",
          regex: [
            {
              regex: "^([4-9][0-9]{2}|[12][0-9]{3})$",
              errorMessage: "Must be between 400 and 2999",
            },
          ],
        },
      ],
    },
  ],
};
