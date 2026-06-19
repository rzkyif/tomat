import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type RelevantDocumentsView from "../components/chat/messages/RelevantDocumentsView.svelte";

export const relevantDocumentsSamples = {
  found: {
    defaultExpanded: true,
    docs: [
      {
        documentId: "1",
        title: "Installing tomat",
        score: 0.92,
        summary: "One-line installer + launch.",
      },
      { documentId: "2", title: "Your first chat", score: 0.81 },
    ],
  },
  none: { defaultExpanded: true, docs: [] },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof RelevantDocumentsView>>>;
