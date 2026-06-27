import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type ToolCallView from "../components/chat/messages/ToolCallView.svelte";

// One tool call per status, plus an awaiting-input form (driven by
// `draftsOverride` so the gallery shows a selection without live interaction)
// and a well-known memory result. `memoryContent` is a snippet prop, so the
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
  labelled: {
    toolName: "feed_cat",
    status: "completed",
    label: "Fed the cat",
    args: { portion: "1 scoop" },
    result: { fed: true },
    expanded: true,
  },
  cancelled: {
    toolName: "close_garage",
    status: "cancelled",
    description: "Closing the garage door",
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
            {
              label: "Kitchen",
              value: "kitchen",
              description: "the usual spot",
            },
            { label: "Patio", value: "patio" },
          ],
        },
      ],
    },
    draftsOverride: {
      0: { text: "", picks: ["kitchen"], freestyleActive: false, rows: [] },
    },
  },
  awaitingDiff: {
    toolName: "edit_file",
    status: "awaiting_user",
    expanded: true,
    askUser: {
      requestId: "sample-req-diff",
      questions: [
        {
          kind: "diff",
          question: "Apply this change?",
          title: "config.toml",
          before: "timeout = 30\nretries = 1\n",
          after: "timeout = 60\nretries = 3\n",
        },
      ],
    },
    draftsOverride: {
      0: { text: "", picks: ["accept"], freestyleActive: false, rows: [] },
    },
  },
  awaitingFiles: {
    toolName: "open_files",
    status: "awaiting_user",
    expanded: true,
    askUser: {
      requestId: "sample-req-files",
      questions: [
        {
          kind: "files",
          question: "Which files should I read?",
          multiselect: true,
          entries: [
            { path: "src/main.ts", label: "main.ts", description: "entry point" },
            { path: "src/config.ts", label: "config.ts" },
            { path: "README.md", label: "README.md" },
          ],
        },
      ],
    },
    draftsOverride: {
      0: { text: "", picks: ["src/main.ts", "README.md"], freestyleActive: false, rows: [] },
    },
  },
  awaitingImage: {
    toolName: "review_screenshot",
    status: "awaiting_user",
    expanded: true,
    askUser: {
      requestId: "sample-req-image",
      questions: [
        {
          kind: "image",
          question: "Does this look right?",
          mime: "image/png",
          dataB64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          actions: [
            { label: "Looks good", value: "approve" },
            { label: "Try again", value: "retry" },
          ],
        },
      ],
    },
    draftsOverride: {
      0: { text: "", picks: ["approve"], freestyleActive: false, rows: [] },
    },
  },
  awaitingTable: {
    toolName: "fill_table",
    status: "awaiting_user",
    expanded: true,
    askUser: {
      requestId: "sample-req-table",
      questions: [
        {
          kind: "table",
          question: "Confirm the schedule",
          columns: ["Day", "Task"],
          rows: [["Mon", "water plants"]],
        },
      ],
    },
    draftsOverride: {
      0: {
        text: "",
        picks: [],
        freestyleActive: false,
        rows: [
          ["Mon", "water plants"],
          ["Wed", "call vet"],
        ],
      },
    },
  },
  memoryResult: {
    toolName: "show_todos",
    status: "completed",
    expanded: true,
    result: {
      kind: "memory_content",
      title: "Today",
      content: "# Today\n\n- water the plants\n- call the vet",
    },
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof ToolCallView>>>;
