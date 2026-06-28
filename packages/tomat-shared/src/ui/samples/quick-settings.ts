import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type QuickSettingsView from "../components/quick-settings/QuickSettingsView.svelte";

// The Quick Settings panel chrome. The section list is a renderer-supplied
// snippet (the client feeds live accordion sections), so these stand-ins only
// vary the panel-level state: the default exit-to-chat labels, and the
// pending-downloads variant where both exits route to Settings instead.

export const quickSettingsSamples = {
  // The common case: nothing pending, so the exits go straight to chat.
  default: {
    exitLabel: "Continue to Chat",
    exitTitle: "Back to Chat",
    exitIcon: "i-material-symbols-arrow-forward-rounded",
  },

  // A field here picked something that still needs downloading, so the exits
  // route to Settings (which pops its pending-downloads modal on arrival).
  pendingDownloads: {
    exitLabel: "Review Pending Downloads",
    exitTitle: "Review Pending Downloads",
    exitIcon: "i-material-symbols-download-rounded",
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof QuickSettingsView>>>;
