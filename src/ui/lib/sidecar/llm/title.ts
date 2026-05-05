/**
 * Generate a short session title from the first user message.
 */

import { titleCase } from "title-case";
import { settingsState } from "$lib/state";
import { singleShotLLM } from "./client";

export async function generateSessionTitle(firstMessage: string): Promise<string> {
  const settings = settingsState.currentSettings;
  const raw = await singleShotLLM(settings["prompts.titleGenerationPrompt"], firstMessage);
  // Strip <think>...</think> blocks (and any unterminated leading think
  // block) for models/templates that emit reasoning inline despite
  // enable_thinking=false / reasoning_effort=minimal.
  const withoutThink = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
  // Take only the first non-empty line. Models sometimes append explanations
  // after the title.
  const firstLine = withoutThink.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  // Strip surrounding quotes, "Title:" prefix, and trailing punctuation.
  const cleaned = firstLine
    .replace(/^\s*(?:title\s*:\s*)/i, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.!?,;:]+$/, "")
    .trim();
  return titleCase(cleaned);
}
