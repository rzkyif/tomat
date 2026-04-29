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
 *  Returns "" when no context fields are set.
 *
 *  Fields are split into two buckets:
 *  - Behavior settings (agent name, response language) are emitted as plain
 *    instructions because they change how the model responds on every turn.
 *  - Reference data (user name, location, date/time, OS) is wrapped in an
 *    XML-tagged block. The tag boundary signals "structured metadata, not
 *    narrative content" so weaker models are less prone to weaving these
 *    fields into every reply. Imperative directives here ("do not mention…")
 *    backfire on small models — they acknowledge the rule in their output —
 *    so the framing is descriptive instead.
 */
export function buildContextBlock(): string {
  const s = settingsState.currentSettings;
  const behavior: string[] = [];
  const reference: string[] = [];

  const agentName = (s["general.context.agentName"] || "").trim();
  if (agentName) behavior.push(`Your name is ${agentName}.`);

  const language = (s["general.context.language"] || "").trim();
  if (language) behavior.push(`Always respond in ${language}.`);

  const userName = (s["general.context.userName"] || "").trim();
  if (userName) reference.push(`Preferred name: ${userName}`);

  const location = (s["general.context.location"] || "").trim();
  if (location) reference.push(`Location: ${location}`);

  if (s["general.context.dateTime"]) {
    reference.push(`Date and time: ${formatDateTime()}`);
  }

  if (s["general.context.os"]) {
    reference.push(`Operating system: ${getOsName()}`);
  }

  const parts: string[] = [];
  if (behavior.length) parts.push(behavior.join("\n"));
  if (reference.length) {
    parts.push(
      [
        "<user_metadata>",
        "Hidden instruction: only refer to these when they are related to the user's message.",
        "",
        ...reference.map((r) => `- ${r}`),
        "</user_metadata>",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
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

/** Short line appended to the system prompt on turns where at least one
 *  toolkit tool survives the relevance filter. Keeps the default prompt
 *  untouched on tool-less turns. */
const TOOLS_HINT =
  "Tools are available for this turn. Prefer calling a tool over speculating when a tool's description clearly fits the request.";

/** Compose the final system prompt for a specific turn. When `toolsHint` is
 *  true, appends a one-line nudge about tool use to whatever prompt/override
 *  we'd normally send. Returns null when there is nothing at all to send. */
export function buildSystemPromptForTurn(opts: {
  base: string | null;
  toolsHint: boolean;
}): string | null {
  const parts: string[] = [];
  if (opts.base) parts.push(opts.base);
  if (opts.toolsHint) parts.push(TOOLS_HINT);
  if (parts.length === 0) return null;
  return parts.join("\n\n");
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
