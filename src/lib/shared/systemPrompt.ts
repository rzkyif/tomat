import { settingsState } from "../state";

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

/**
 * Build the system prompt string from the behaviour preset + context settings.
 * The "disabled" preset suppresses the base prompt but still emits context
 * if any context field/toggle is set. Returns null only when nothing is set.
 */
export function buildSystemPrompt(): string | null {
  const s = settingsState.currentSettings;
  const base =
    s["behaviour.preset"] === "disabled" ? "" : (s["behaviour.systemPrompt"] || "").trim();
  const ctx: string[] = [];

  const userName = (s["behaviour.context.preferredUserName"] || "").trim();
  if (userName) ctx.push(`The user prefers to be called ${userName}.`);

  const agentName = (s["behaviour.context.preferredAgentName"] || "").trim();
  if (agentName) ctx.push(`Your name is ${agentName}.`);

  const language = (s["behaviour.context.preferredLanguage"] || "").trim();
  if (language) ctx.push(`Communicate in ${language}.`);

  const location = (s["behaviour.context.location"] || "").trim();
  if (location) ctx.push(`User location: ${location}.`);

  if (s["behaviour.context.dateTime"]) {
    ctx.push(`Current date and time: ${formatDateTime()}.`);
  }

  if (s["behaviour.context.os"]) {
    ctx.push(`User operating system: ${getOsName()}.`);
  }

  if (!base && ctx.length === 0) return null;

  const contextBlock = ctx.length ? `\n\nContext:\n- ${ctx.join("\n- ")}` : "";
  return `${base}${contextBlock}`.trim();
}
