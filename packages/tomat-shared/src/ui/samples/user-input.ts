import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type UserInputView from "../components/chat/UserInputView.svelte";

export const userInputSamples = {
  empty: { value: "", placeholder: "Enter your instructions..." },
  withText: {
    value: "How do I install tomat on macOS?",
    placeholder: "Enter your instructions...",
  },
  voiceReady: {
    value: "",
    placeholder: "Enter your instructions...",
    showVoice: true,
    voiceTitle: "Hold to talk",
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof UserInputView>>>;
