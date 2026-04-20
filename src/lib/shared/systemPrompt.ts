/**
 * Builds the system prompt sent to the LLM for a given turn. Combines the
 * user's chosen base prompt, optional context fields (date, OS, user name,
 * etc.), any per-turn overrides from snippets, and one-off hints like
 * "tools are available this turn" into a single string.
 */

import { settingsState } from "../state";
import type { SnippetOverride } from "./snippets";

function getOsName(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "macOS";
  if (/Win/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

function formatDateTime(): string {
  const d = new Date();
  const formatted = d.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatted} (${tz})`;
}

/** The default system prompt base alone, without the context block.
 *  Returns "" when the preset is "disabled" or the custom text is empty. */
export function buildSystemPromptBase(): string {
  const s = settingsState.currentSettings;
  if (s["prompts.defaultSystemPrompt.preset"] === "disabled") return "";
  return (s["prompts.defaultSystemPrompt"] || "").trim();
}

/** The context block alone (everything driven by general.context.*).
 *  Returns "" when no context fields are set. */
export function buildContextBlock(): string {
  const s = settingsState.currentSettings;
  const ctx: string[] = [];

  const userName = (s["general.context.userName"] || "").trim();
  if (userName) ctx.push(`The user prefers to be called ${userName}.`);

  const agentName = (s["general.context.agentName"] || "").trim();
  if (agentName) ctx.push(`Your name is ${agentName}.`);

  const language = (s["general.context.language"] || "").trim();
  if (language) ctx.push(`Communicate in ${language}.`);

  const location = (s["general.context.location"] || "").trim();
  if (location) ctx.push(`User location: ${location}.`);

  if (s["general.context.dateTime"]) {
    ctx.push(`Current date and time: ${formatDateTime()}.`);
  }

  if (s["general.context.os"]) {
    ctx.push(`User operating system: ${getOsName()}.`);
  }

  return ctx.length ? `Context:\n- ${ctx.join("\n- ")}` : "";
}

/**
 * Build the system prompt string from the system prompt preset + context settings.
 * The "disabled" preset suppresses the base prompt but still emits context
 * if any context field/toggle is set. Returns null only when nothing is set.
 *
 * Used as the fallback when no snippet-driven override exists on the user
 * message. Snippet paths go through `applySystemPromptOverride` with the
 * base and context passed separately so snippet text lands between them.
 */
export function buildSystemPrompt(): string | null {
  const base = buildSystemPromptBase();
  const context = buildContextBlock();
  if (!base && !context) return null;
  return [base, context].filter((s) => s).join("\n\n");
}

/**
 * Compose the final system prompt from a snippet-triggered override, the
 * default base, and the context block. Ordering:
 *   [prepend-system]
 *   [replace-system ?? base]
 *   [append-system]
 *   [context]
 * Works even when `base` is empty (preset = "None"): prepend/replace/append
 * still contribute, and context is still appended last.
 */
export function applySystemPromptOverride(
  base: string,
  override?: SnippetOverride,
  context: string = "",
): string | null {
  const parts: string[] = [];
  if (override?.prepend) parts.push(override.prepend);
  const core = override?.replace !== undefined ? override.replace : base;
  if (core) parts.push(core);
  if (override?.append) parts.push(override.append);
  if (context) parts.push(context);
  const combined = parts.join("\n\n").trim();
  return combined ? combined : null;
}
