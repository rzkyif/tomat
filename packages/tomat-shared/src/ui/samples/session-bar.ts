import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type SessionBarView from "../components/chat/SessionBarView.svelte";

export const sessionBarSamples = {
  default: {
    tokenUsage: { used: 980, max: 8192 },
    showTitle: true,
    defaultTitle: "Installing tomat",
    titleText: "Installing tomat",
  },
  nearFull: {
    tokenUsage: { used: 7800, max: 8192 },
    showTitle: true,
    titleText: "Long debugging session",
    showButtonGroup: true,
  },
  newSession: {
    tokenUsage: null,
    showTitle: true,
    titleText: "",
    defaultTitle: "New session",
    isNewSession: true,
  },
  withCoreChip: {
    tokenUsage: { used: 1200, max: 8192 },
    showChip: true,
    coreName: "laptop",
    showTitle: true,
    titleText: "Installing tomat",
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof SessionBarView>>>;
