/**
 * Builds the system prompt sent to the LLM for a given turn. Combines the
 * user's chosen base prompt, optional context fields (date, OS, user name,
 * etc.), any per-turn overrides from snippets, and one-off hints like
 * "tools are available this turn" into a single string.
 */

import { getCountryForTimezone } from "countries-and-timezones";
import { settingsState } from "../state";
import { DEFAULT_CONTEXT_TEMPLATE } from "./prompts";
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

/** Derive a "City, Country" string from the OS-reported IANA timezone, using
 *  the `countries-and-timezones` package (IANA-derived data, no network).
 *  Falls back to just the city when the country lookup fails, or "" when the
 *  timezone is something abstract like "UTC" / "GMT" / "Etc/UTC". */
function deriveAutoLocation(): string {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
  if (!tz || tz === "UTC" || tz === "GMT" || tz.startsWith("Etc/")) return "";

  const country = getCountryForTimezone(tz)?.name || "";

  // City is the last path segment, with underscores → spaces (e.g. "New York")
  // and dashes preserved (e.g. "Port-au-Prince").
  const lastSlash = tz.lastIndexOf("/");
  const cityRaw = lastSlash === -1 ? tz : tz.slice(lastSlash + 1);
  const city = cityRaw.replace(/_/g, " ");

  if (!city) return country;
  return country ? `${city}, ${country}` : city;
}

/** Render the user's context-prompt template:
 *  - `[name:body]` is a conditional segment, kept iff `vars[name]` is a
 *    non-empty string. Body may itself contain `{name}` placeholders.
 *  - `{name}` is a placeholder, replaced by `vars[name]` (empty string when
 *    the var is missing).
 *  Conditional matching is non-greedy and does not nest.
 *  After substitution, runs of 2+ consecutive blank lines collapse to a
 *  single blank line so empty conditionals don't leave large gaps.
 */
export function renderContextTemplate(template: string, vars: Record<string, string>): string {
  const condRe = /\[(\w+):([\s\S]*?)\]/g;
  const phaseOne = template.replace(condRe, (_, name: string, body: string) => {
    const v = vars[name];
    return v && v.length > 0 ? body : "";
  });
  const placeholderRe = /\{(\w+)\}/g;
  const phaseTwo = phaseOne.replace(placeholderRe, (_, name: string) => vars[name] ?? "");
  // Collapse 2+ blank lines into a single blank line, then trim outer whitespace.
  return phaseTwo.replace(/\n[ \t]*(\n[ \t]*)+/g, "\n\n").trim();
}

/** The default system prompt base alone, without the context block.
 *  Returns "" when the preset is "disabled" or the custom text is empty. */
export function buildSystemPromptBase(): string {
  const s = settingsState.currentSettings;
  if (s["prompts.defaultSystemPrompt.preset"] === "disabled") return "";
  return (s["prompts.defaultSystemPrompt"] || "").trim();
}

/** The context block alone (everything driven by general.context.*).
 *  Returns "" when no context fields resolve to anything.
 *
 *  Driven by `prompts.contextTemplate`: the user can edit the template freely
 *  using `{name}` placeholders and `[name:body]` conditional segments. See
 *  `renderContextTemplate` and `DEFAULT_CONTEXT_TEMPLATE` for the syntax.
 */
export function buildContextBlock(): string {
  const s = settingsState.currentSettings;

  const location = s["general.context.locationAuto"]
    ? deriveAutoLocation()
    : (s["general.context.location"] || "").trim();

  const vars: Record<string, string> = {
    agentName: (s["general.context.agentName"] || "").trim(),
    language: (s["general.context.language"] || "").trim(),
    userName: (s["general.context.userName"] || "").trim(),
    location,
    dateTime: s["general.context.dateTime"] ? formatDateTime() : "",
    os: s["general.context.os"] ? getOsName() : "",
  };

  const template = (s["prompts.contextTemplate"] as string) || DEFAULT_CONTEXT_TEMPLATE;
  return renderContextTemplate(template, vars);
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
