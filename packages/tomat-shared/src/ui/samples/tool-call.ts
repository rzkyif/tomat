import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type ToolCallView from "../components/chat/messages/ToolCallView.svelte";

// One tool call per status, plus an awaiting-input form (driven by
// `draftsOverride` so the gallery shows a selection without live interaction)
// and a well-known document result. `documentContent` is a snippet prop, so the
// gallery supplies the markdown renderer; `OmitSnippetProps` strips it here.
export const toolCallSamples = {
  completed: {
    toolName: "feed_cat",
    status: "completed",
    args: { portion: "1 scoop", bowl: "kitchen" },
    result: { fed: true, dispensedGrams: 45 },
    expanded: true,
  },
  running: {
    toolName: "close_garage",
    status: "running",
    description: "Closing the garage door",
    progress: 0.4,
    expanded: true,
  },
  failed: {
    toolName: "open",
    status: "failed",
    error: "only http(s) URLs are allowed",
    expanded: true,
  },
  awaitingChoice: {
    toolName: "feed_cat",
    status: "awaiting_user",
    expanded: true,
    askUser: {
      requestId: "sample-req",
      questions: [
        {
          question: "Which bowl should I fill?",
          options: [
            { label: "Kitchen", value: "kitchen", description: "the usual spot" },
            { label: "Patio", value: "patio" },
          ],
        },
      ],
    },
    draftsOverride: {
      0: { text: "", picks: ["kitchen"], freestyleActive: false, rows: [] },
    },
  },
  documentResult: {
    toolName: "show_todos",
    status: "completed",
    expanded: true,
    result: {
      kind: "document_content",
      title: "Today",
      content: "# Today\n\n- water the plants\n- call the vet",
    },
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof ToolCallView>>>;
