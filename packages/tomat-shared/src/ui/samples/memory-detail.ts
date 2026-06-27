import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type MemoryDetailView from "../components/settings/MemoryDetailView.svelte";

export const memoryDetailSamples = {
  knowledge: {
    enabled: true,
    isSkill: false,
    editable: true,
    draftTitle: "Project conventions",
    contentLoaded: true,
    draftContent:
      "Always write the brand lowercase as tomat.\nPrefer maintained packages over hand-rolled code.",
  },
  skill: {
    enabled: true,
    isSkill: true,
    editable: true,
    draftTitle: "Summarize a thread",
    contentLoaded: true,
    draftContent: "# Summarize a thread\n\nRead every message, then return a 3-bullet recap.",
    suggestedTools: ["read_session", "search_messages"],
    files: ["SKILL.md", "examples/recap.md"],
  },
  readOnly: {
    enabled: false,
    isSkill: false,
    editable: false,
    draftTitle: "Bundled tone guide",
    contentLoaded: true,
    draftContent: "Keep replies concise and concrete.",
  },
  titleError: {
    enabled: true,
    isSkill: false,
    editable: true,
    draftTitle: "",
    titleError: "Give this memory a title.",
    contentLoaded: true,
    draftContent: "Always write the brand lowercase as tomat.",
  },
  contentLoading: {
    enabled: true,
    isSkill: false,
    editable: true,
    draftTitle: "Project conventions",
    contentLoaded: false,
    draftContent: "",
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof MemoryDetailView>>>;
