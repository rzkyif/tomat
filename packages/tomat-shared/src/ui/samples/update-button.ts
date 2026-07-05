import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type UpdateButtonView from "../components/settings/UpdateButtonView.svelte";

// The Settings sidebar update button. The client owns the live update state
// machine (client + core + sidecar checks, then the install/restart handoff),
// mapping all of it down to a phase + a resolved label. These scripted stand-ins
// cover one rendition per visible phase, plus a collapsed variant. Labels match
// exactly what the client resolves for each phase (the available label swaps to
// "Install Updates" on hover; this shows the rest text).
export const updateButtonSamples = {
  idle: {
    phase: "idle",
    label: "Check for Updates",
    collapsed: false,
  },
  checking: {
    phase: "checking",
    label: "Checking…",
    collapsed: false,
  },
  available: {
    phase: "available",
    label: "Updates Available",
    blink: true,
    collapsed: false,
  },
  updating: {
    phase: "updating",
    label: "Updating…",
    collapsed: false,
  },
  ready: {
    phase: "clientRestartPending",
    label: "Restart to Update",
    collapsed: false,
  },
  collapsed: {
    phase: "available",
    label: "Updates Available",
    blink: true,
    collapsed: true,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof UpdateButtonView>>>;
