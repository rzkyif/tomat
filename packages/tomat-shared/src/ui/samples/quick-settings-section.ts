import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type QuickSettingsSectionView from "../components/quick-settings/QuickSettingsSectionView.svelte";

// One accordion section's header chrome. The body (curated schema fields) is a
// renderer-supplied snippet, so these scripted stand-ins only vary the header
// state: expanded vs collapsed, and with an on/off toggle (a gated module like
// Text-to-Speech) vs without one (an always-on module like General).

export const quickSettingsSectionSamples = {
  // An always-on module, expanded onto its fields.
  expanded: {
    title: "General",
    open: true,
    enabled: true,
    hasToggle: false,
  },

  // The same module collapsed to a header row.
  collapsed: {
    title: "General",
    open: false,
    enabled: true,
    hasToggle: false,
  },

  // A gated module: the header carries an on/off toggle, on and expanded.
  withToggle: {
    title: "Text-to-Speech",
    open: true,
    enabled: true,
    hasToggle: true,
  },

  // The gated module switched off: the toggle reads off and the section is
  // collapsed and not expandable.
  withToggleOff: {
    title: "Text-to-Speech",
    open: false,
    enabled: false,
    hasToggle: true,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof QuickSettingsSectionView>>>;
