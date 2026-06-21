import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type RelevantMemoriesView from "../components/chat/messages/RelevantMemoriesView.svelte";

export const relevantMemoriesSamples = {
  found: {
    defaultExpanded: true,
    memories: [
      {
        memoryId: "1",
        title: "Installing tomat",
        score: 0.92,
        summary: "One-line installer + launch.",
      },
      { memoryId: "2", title: "Your first chat", score: 0.81 },
    ],
  },
  none: { defaultExpanded: true, memories: [] },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof RelevantMemoriesView>>>;
