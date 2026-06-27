// Resolves an LlmEndpointConfig from the current core settings.
//
// All settings keys read here are defined in the shared schema
// (`@tomat/shared/src/domain/settings/groups/{llm,dualModel}.ts`):
//   - llm.provider              : "local" | "external"
//   - llm.host, llm.port        : local llama-server bind addr (default 127.0.0.1:7701)
//   - llm.external.baseUrl/apiKey/model
//   - llm.external.contextSize
//   - llm.contextSize           : local context window
//   - llm.reasoning             : "off" | "on"
//   - llm.reasoningEffort       : "low" | "medium" | "high" (external only)
//   - llm.temperature, llm.topP : sampling, sent to both providers
//   - llm.topK, llm.minP, llm.repeatPenalty, llm.reasoningBudget : local only
//   - dualModel.external.baseUrl/apiKey/model        (route="secondary")
//   - dualModel.external.contextSize
//
// External API keys are pulled from the encrypted secrets vault first; a
// plain-text value placed directly in settings.json is honored as a
// lower-precedence fallback (e.g. headless/config-file setups). The client
// routes keys to the vault and core redacts them from GET /settings, so the
// vault is the authoritative source.

import type { LlmEndpointConfig } from "./llm-provider.ts";
import { DEFAULT_SAMPLING } from "@tomat/shared";
import { getSecret } from "./secrets.ts";
import { numSetting, strSetting } from "./settings-access.ts";
import { llmPort } from "../paths.ts";

export type LlmRoute = "default" | "secondary";

export async function resolveEndpoint(
  settings: Record<string, unknown>,
  route: LlmRoute = "default",
): Promise<LlmEndpointConfig> {
  if (route === "secondary") {
    const settingsKey = strSetting(settings, "dualModel.external.apiKey", "");
    const apiKey = (await getSecret("dualModel.external.apiKey")) || settingsKey || "";
    return {
      baseUrl: strSetting(settings, "dualModel.external.baseUrl", ""),
      apiKey,
      model: strSetting(settings, "dualModel.external.model", ""),
      reasoning: "off",
    };
  }
  const provider = strSetting(settings, "llm.provider", "local") as "local" | "external";
  // Default mirrors the shared schema (settings.json is sparse): thinking is on
  // unless the user turns it off. A legacy "auto" reads as "on" (the two are
  // equivalent for thinking; "auto" was dropped from the toggle).
  const reasoning = strSetting(settings, "llm.reasoning", "on") === "off" ? "off" : "on";
  // OpenAI-style samplers apply to both providers; read with the schema defaults
  // (sparse store) so a value is always sent.
  const temperature = numSetting(settings, "llm.temperature", DEFAULT_SAMPLING.temperature);
  const topP = numSetting(settings, "llm.topP", DEFAULT_SAMPLING.topP);
  if (provider === "external") {
    const settingsKey = strSetting(settings, "llm.external.apiKey", "");
    const apiKey = (await getSecret("llm.external.apiKey")) || settingsKey || "";
    // OpenAI-style endpoints take an effort level rather than a token budget.
    const reasoningEffort = strSetting(settings, "llm.reasoningEffort", "high") as
      | "minimal"
      | "low"
      | "medium"
      | "high";
    return {
      baseUrl: strSetting(settings, "llm.external.baseUrl", ""),
      apiKey,
      model: strSetting(settings, "llm.external.model", ""),
      reasoning,
      reasoningEffort,
      temperature,
      topP,
    };
  }
  const host = strSetting(settings, "llm.host", "127.0.0.1");
  const port = strSetting(settings, "llm.port", String(llmPort()));
  return {
    baseUrl: `http://${host}:${port}/v1`,
    apiKey: "sk-local",
    model: "default",
    reasoning,
    temperature,
    topP,
    // llama.cpp-only samplers, plus the per-turn thinking budget (0/unset =
    // unrestricted, so omit it). Presets write all of these on model select.
    topK: numSetting(settings, "llm.topK", DEFAULT_SAMPLING.topK),
    minP: numSetting(settings, "llm.minP", DEFAULT_SAMPLING.minP),
    repeatPenalty: numSetting(settings, "llm.repeatPenalty", DEFAULT_SAMPLING.repeatPenalty),
    reasoningBudget: numSetting(settings, "llm.reasoningBudget", 0) || undefined,
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
