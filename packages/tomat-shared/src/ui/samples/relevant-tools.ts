import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type RelevantToolsView from "../components/chat/messages/RelevantToolsView.svelte";

export const relevantToolsSamples = {
  twoPhase: {
    defaultExpanded: true,
    phase1: [
      { toolId: "fs.read", name: "read_file", description: "", score: 0.71 },
      { toolId: "fs.write", name: "write_file", description: "", score: 0.55 },
    ],
    phase2: [{ toolId: "fs.read", name: "read_file", description: "" }],
    alwaysAvailable: [
      {
        toolId: "sys.now",
        name: "current_time",
        description: "",
      },
    ],
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof RelevantToolsView>>>;
