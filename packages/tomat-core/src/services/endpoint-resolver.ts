// Resolves an LlmEndpointConfig from the current core settings.
//
// All settings keys read here are defined in the shared schema
// (`@tomat/shared/src/domain/settings/groups/{llm,dualModel}.ts`):
//   - llm.provider              : "local" | "external"
//   - llm.host, llm.port        : local llama-server bind addr (default 127.0.0.1:7701)
//   - llm.external.baseUrl/apiKey/model
//   - llm.external.contextSize
//   - llm.contextSize           : local context window
//   - llm.reasoning             : "off" | "on" | "auto"
//   - dualModel.external.baseUrl/apiKey/model        (route="secondary")
//   - dualModel.external.contextSize
//
// External API keys are pulled from the encrypted secrets vault first; a
// plain-text value placed directly in settings.json is honored as a
// lower-precedence fallback (e.g. headless/config-file setups). The client
// routes keys to the vault and core redacts them from GET /settings, so the
// vault is the authoritative source.

import type { LlmEndpointConfig } from "./llm-provider.ts";
import { getSecret } from "./secrets.ts";
import { llmPort } from "../paths.ts";

export type LlmRoute = "default" | "secondary";

export async function resolveEndpoint(
  settings: Record<string, unknown>,
  route: LlmRoute = "default",
): Promise<LlmEndpointConfig> {
  if (route === "secondary") {
    const settingsKey = strSetting(settings, "dualModel.external.apiKey", "");
    const apiKey = (await getSecret("dualModel.external.apiKey")) ||
      settingsKey || "";
    return {
      baseUrl: strSetting(settings, "dualModel.external.baseUrl", ""),
      apiKey,
      model: strSetting(settings, "dualModel.external.model", ""),
      reasoning: "off",
    };
  }
  const provider = strSetting(settings, "llm.provider", "local") as
    | "local"
    | "external";
  const reasoning = strSetting(settings, "llm.reasoning", "off") as
    | "off"
    | "on"
    | "auto";
  if (provider === "external") {
    const settingsKey = strSetting(settings, "llm.external.apiKey", "");
    const apiKey = (await getSecret("llm.external.apiKey")) ||
      settingsKey || "";
    return {
      baseUrl: strSetting(settings, "llm.external.baseUrl", ""),
      apiKey,
      model: strSetting(settings, "llm.external.model", ""),
      reasoning,
    };
  }
  const host = strSetting(settings, "llm.host", "127.0.0.1");
  const port = strSetting(settings, "llm.port", String(llmPort()));
  return {
    baseUrl: `http://${host}:${port}/v1`,
    apiKey: "sk-local",
    model: "default",
    reasoning,
  };
}

/** Context window size for the active provider on the given route, in
 *  tokens. Used by token-budget math (tool filter, session usage). Returns
 *  the user-configured value or a sensible default. */
export function resolveContextSize(
  settings: Record<string, unknown>,
  route: LlmRoute = "default",
): number {
  if (route === "secondary") {
    return numSetting(settings, "dualModel.external.contextSize", 128000);
  }
  const provider = strSetting(settings, "llm.provider", "local");
  if (provider === "external") {
    return numSetting(settings, "llm.external.contextSize", 128000);
  }
  return numSetting(settings, "llm.contextSize", 4096);
}

function strSetting(
  s: Record<string, unknown>,
  key: string,
  def: string,
): string {
  const v = s[key];
  return typeof v === "string" ? v : def;
}

function numSetting(
  s: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = s[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}
