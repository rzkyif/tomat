import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type SnippetDetailView from "../components/settings/SnippetDetailView.svelte";

// The client derives these from a live snippet draft: it validates the name,
// builds the symbol options (marking the recommended one), maps the placement
// list, and precomputes the `triggerPreview` string (`symbol` + name). These
// scripted stand-ins cover a fully-filled snippet, an empty/new one, and a
// name-collision error state.

const symbolOptions = [
  { value: "#", label: "#" },
  { value: "@", label: "@" },
  { value: "/", label: "/  (Recommended)" },
];

const placementOptions = [
  { value: "prepend-system", label: "Prepend System Prompt" },
  { value: "replace-system", label: "Replace System Prompt" },
  { value: "append-system", label: "Append System Prompt" },
  { value: "prepend-user", label: "Prepend User Prompt" },
  { value: "replace-user", label: "Replace User Prompt" },
  { value: "insert-user", label: "Insert in User Prompt" },
  { value: "append-user", label: "Append User Prompt" },
];

export const snippetDetailSamples = {
  // A saved command snippet: `/` symbol recommended for whole-prompt placement.
  filled: {
    draftName: "summarize",
    draftSymbol: "/",
    draftPlacement: "replace-user",
    draftText: "Summarize the conversation so far in three short bullets.",
    triggerPreview: "/summarize",
    symbolOptions,
    placementOptions,
  },
  // A fresh snippet before anything is typed: empty name, preview falls back to
  // the placeholder word.
  empty: {
    draftName: "",
    draftSymbol: "#",
    draftPlacement: "insert-user",
    draftText: "",
    triggerPreview: "#name",
    symbolOptions,
    placementOptions,
  },
  // The chosen trigger collides with another snippet's trigger.
  error: {
    draftName: "scientist",
    draftSymbol: "@",
    draftPlacement: "prepend-system",
    draftText: "You are a meticulous research scientist.",
    triggerPreview: "@scientist",
    nameError: "This trigger is already used by another snippet",
    symbolOptions,
    placementOptions,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof SnippetDetailView>>>;
