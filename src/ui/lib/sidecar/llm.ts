/**
 * Talks to whatever LLM the user has configured: either the local
 * llama-server sidecar or an external OpenAI-compatible endpoint. Handles
 * client setup, error classification, dual-model routing, and the
 * higher-level chat-completion calls used by the rest of the app.
 */

import OpenAI from "openai";
import { titleCase } from "title-case";
import { settingsState, messagesState, toolkitsState } from "../state";
import { setInterruptController } from "$lib/shared/interrupt";
import { buildSystemPrompt, buildSystemPromptForTurn } from "$lib/shared/systemPrompt";
import { readSessionAttachment, base64ToUtf8 } from "$lib/shared/attachments";
import {
  getTextContent,
  type LLMErrorType,
  type Message,
  type MessageContent,
  type PendingToolCall,
  type RelevantToolPhase1Entry,
  type RelevantToolPhase2Entry,
} from "$lib/shared/types";
import { tokenize, tokenizeMany } from "$lib/shared/tokenize";
import type { ToolDescriptor } from "../state/toolkits.svelte";

// --- Error mapping ---

export interface LLMError {
  type: LLMErrorType;
  detail?: string;
}

/** Map OpenAI/llama API errors to our error types */
export function mapError(err: any): LLMError {
  const errorType = err?.type || err?.error?.type || "";
  const errorCode = err?.code || err?.status || err?.error?.code || "";
  const errorMessage = err?.message || err?.error?.message || "";

  let type: LLMErrorType;

  if (
    errorType.includes("context_size") ||
    errorCode === 413 ||
    errorCode === "context_length_exceeded" ||
    errorMessage.toLowerCase().includes("context length")
  ) {
    type = "context_length_exceeded_error";
  } else if (errorType.includes("rate_limit") || errorCode === 429) {
    type = "rate_limit_error";
  } else if (errorType.includes("authentication") || errorCode === 401) {
    type = "authentication_error";
  } else if (errorType.includes("invalid_request") || errorCode === 400 || errorCode === 422) {
    type = "invalid_request_error";
  } else if ((errorCode >= 500 && errorCode < 600) || errorType.includes("server_error")) {
    type = "server_error";
  } else {
    type = "unknown_error";
  }

  return { type, detail: errorMessage || undefined };
}

// --- Client creation ---

/** Create an OpenAI-compatible client */
export function createOpenAIClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL, apiKey, dangerouslyAllowBrowser: true });
}

/** Create an OpenAI client pointing at the configured LLM server */
export function getLLMClient(): OpenAI {
  const settings = settingsState.currentSettings;
  const provider = settings["llm.provider"];

  if (provider === "external") {
    return createOpenAIClient(settings["llm.external.baseUrl"], settings["llm.external.apiKey"]);
  } else {
    const host = settings["llm.host"] || "127.0.0.1";
    const port = settings["llm.port"] || "7701";
    return createOpenAIClient(`http://${host}:${port}/v1`, "local");
  }
}

/** Create an OpenAI client for the configured Dual-Model secondary endpoint. */
export function getSecondaryLLMClient(): OpenAI {
  const settings = settingsState.currentSettings;
  return createOpenAIClient(
    settings["dualModel.external.baseUrl"],
    settings["dualModel.external.apiKey"],
  );
}

// --- Context size ---

/** Get the configured context size for the current LLM */
export function getContextSize(): number {
  const settings = settingsState.currentSettings;
  if (settings["llm.provider"] === "external") {
    return settings["llm.external.contextSize"] || 128000;
  }
  return settings["llm.contextSize"] || 4096;
}

/**
 * When dual-model routing is enabled, ask the default model whether the last
 * user message warrants the stronger external model.
 */
export async function routeSelection(): Promise<"default" | "secondary"> {
  const settings = settingsState.currentSettings;
  if (!settings["dualModel.enabled"]) return "default";

  const hasSecondaryConfig =
    typeof settings["dualModel.external.baseUrl"] === "string" &&
    settings["dualModel.external.baseUrl"].length > 0 &&
    typeof settings["dualModel.external.model"] === "string" &&
    settings["dualModel.external.model"].length > 0;
  if (!hasSecondaryConfig) return "default";

  // `messagesState.messages` is stored newest-first (see addMessage's
  // `unshift`), so `.find(...)` without reversing returns the MOST RECENT
  // user message - which is what we want to classify. Reversing would match
  // the first user message in the session, so follow-ups would be routed
  // based on the very first question every time.
  const lastUser = messagesState.messages.find((m) => m.role === "user");
  if (!lastUser) return "default";

  const detectionPrompt = settings["prompts.complexityDetectionPrompt"];

  try {
    const verdict = await singleShotLLM(detectionPrompt, lastUser.content);
    const norm = verdict.trim().toLowerCase();
    // Lenient match: small local models rarely comply perfectly with
    // "reply with one word". Accept any mention of "complex" that isn't
    // dominated by "simple".
    const hasComplex = /\bcomplex(?:ity|ness)?\b/.test(norm);
    const hasSimple = /\bsimple(?:st)?\b/.test(norm);
    const route: "default" | "secondary" = hasComplex && !hasSimple ? "secondary" : "default";
    console.log(`[llm] dual-model detection verdict=${JSON.stringify(verdict)} -> ${route}`);
    return route;
  } catch (e) {
    console.warn("[llm] dual-model routing failed; falling back to default:", e);
    return "default";
  }
}

// --- Utility LLM calls ---

export type ReasoningMode = "off" | "on" | "auto";

export interface SingleShotOptions {
  reasoning?: { mode: ReasoningMode; budget?: number };
}

/** Single-shot non-streaming LLM call for utilities (title gen, autocorrect,
 *  routing, tool filtering). By default reasoning is forced off; pass
 *  `options.reasoning` to opt-in for callers that benefit from reasoning. */
export async function singleShotLLM(
  systemPrompt: string,
  userMessage: MessageContent,
  options?: SingleShotOptions,
): Promise<string> {
  const client = getLLMClient();
  const settings = settingsState.currentSettings;
  const provider = settings["llm.provider"];
  const model = provider === "external" ? settings["llm.external.model"] : "default";

  const apiContent = await contentToApi(userMessage);
  const request: OpenAI.ChatCompletionCreateParamsNonStreaming & {
    chat_template_kwargs?: Record<string, unknown>;
    reasoning_effort?: string;
    reasoning?: { effort: string; budget: number };
  } = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: apiContent as OpenAI.ChatCompletionUserMessageParam["content"] },
    ],
    stream: false as const,
  };

  const mode: ReasoningMode = options?.reasoning?.mode ?? "off";

  // llama.cpp's documented per-request toggle is chat_template_kwargs.enable_thinking
  // (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
  // For OpenAI-compatible external servers, reasoning_effort is the standard
  // signal; servers that don't support it ignore unknown fields.
  if (mode === "off") {
    if (provider === "external") {
      request.reasoning_effort = "minimal";
    } else {
      request.chat_template_kwargs = { enable_thinking: false };
    }
  } else {
    const effort = mode === "on" ? "high" : "low";
    if (provider === "external") {
      request.reasoning_effort = effort;
    } else {
      request.chat_template_kwargs = { enable_thinking: true };
    }
    const budget = options?.reasoning?.budget;
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      request.reasoning = { effort, budget };
    }
  }

  const response = await client.chat.completions.create(request);

  return response.choices?.[0]?.message?.content?.trim() || "";
}

/** Generate a short session title from the first user message */
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

/** Correct transcription mistakes using the LLM */
export async function autocorrectTranscription(text: string): Promise<string> {
  const settings = settingsState.currentSettings;
  return singleShotLLM(settings["prompts.autocorrectPrompt"], text);
}

/** Merge a new transcription into existing textarea text via single-shot LLM. */
export async function mergeTranscription(existing: string, transcription: string): Promise<string> {
  const settings = settingsState.currentSettings;
  const userMessage = `<existing>\n${existing}\n</existing>\n<new>\n${transcription}\n</new>`;
  return singleShotLLM(settings["prompts.mergeTranscriptionPrompt"], userMessage);
}

// --- Message sending ---

type ApiMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ApiMessage =
  | {
      role: "user" | "assistant" | "system";
      content: string | ApiMessagePart[];
    }
  | {
      // Assistant turns that request tools. content may be null per the spec.
      role: "assistant";
      content: string | null;
      tool_calls: OpenAI.ChatCompletionMessageToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

/** Convert our MessageContent to the OpenAI API format. Materializes any
 *  on-disk attachment parts by reading them from the session directory. */
async function contentToApi(content: MessageContent): Promise<string | ApiMessagePart[]> {
  if (typeof content === "string") return content;

  const parts: ApiMessagePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
    } else if (part.type === "document") {
      parts.push({
        type: "text",
        text: `[Attached document: ${part.filename}]\n\n${part.markdown}`,
      });
    } else if (part.type === "image_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mime};base64,${b64}` },
        });
      } catch (e) {
        console.warn("[llm] failed to load image attachment:", part.path, e);
      }
    } else if (part.type === "document_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        const markdown = base64ToUtf8(b64);
        parts.push({
          type: "text",
          text: `[Attached document: ${part.filename}]\n\n${markdown}`,
        });
      } catch (e) {
        console.warn("[llm] failed to load document attachment:", part.path, e);
      }
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

// --- Tool filtering (phase 1 + phase 2) ---

/** Largest phase-1 candidate count we'll ever request from the sidecar.
 *  Bounds prompt size and tokenize cost regardless of how many tools the user
 *  has installed. */
const PHASE1_HARD_CAP = 150;
/** Lowest phase-1 candidate count we accept after budget fitting. If even this
 *  many entries don't fit, we keep them anyway - better an oversized prompt
 *  than zero tools. */
const PHASE1_FLOOR = 10;
/** Tokens reserved for the LLM's response when computing the catalog budget. */
const OUTPUT_RESERVE_TOKENS = 1024;
/** Use only this fraction of the available window. Leaves headroom for
 *  template overhead, BPE merges across boundaries, and tokenizer drift on
 *  external (char/4) estimates. */
const SAFETY_MARGIN = 0.8;

const PHASE2_PROMPT_HEADER = [
  "You are a fast tool-shortlist reducer. The user has a request, and we have a candidate list of tools that *might* be useful. Your job is to drop only the tools that are CLEARLY UNRELATED to the user's request. When in doubt, KEEP the tool. The downstream model will make the final call.",
  "",
  "Reply with a JSON array of tool names to KEEP. Reply with ONLY the JSON array, no prose.",
  "",
  'Examples of "clearly unrelated":',
  "- A weather tool when the user asks to send an email.",
  "- A file-renaming tool when the user asks for the current time.",
  "",
  "Examples of borderline (KEEP these):",
  '- "Open Google" → keep `open_website` (Google is reachable as a URL).',
  '- "Find that doc" → keep both `search_files` and `search_web` (intent ambiguous).',
  "",
  "Catalog:",
].join("\n");

function buildPhase2SystemPrompt(catalog: string): string {
  return `${PHASE2_PROMPT_HEADER}\n${catalog}`;
}

function catalogEntry(c: { name: string; description: string }): string {
  return `- ${c.name}: ${c.description}`;
}

interface FilterResult {
  /** Tool names selected by the filter LLM, or all candidate names on error. */
  kept: string[];
  /** Stringified failure reason when the filter LLM call fails. The caller
   *  surfaces this on the bubble; tools still flow through via the kept list. */
  errorMessage?: string;
}

/** Phase 2: ask the LLM to drop only the clearly-unrelated phase-1 candidates.
 *  Tolerates arbitrary JSON arrays surrounded by prose; small models rarely
 *  reply cleanly. On any failure, falls back to "keep every candidate" so the
 *  main model still sees the tools. */
async function llmFilterTools(
  userText: string,
  candidates: { id: string; name: string; description: string }[],
): Promise<FilterResult> {
  if (candidates.length === 0) return { kept: [] };
  const allowed = candidates.map((c) => c.name);
  const catalog = candidates.map(catalogEntry).join("\n");
  const settings = settingsState.currentSettings;
  const system = buildPhase2SystemPrompt(catalog);
  const reasoningMode = (settings["tools.filterReasoning"] || "off") as "off" | "on" | "auto";
  const reasoningBudgetRaw = settings["tools.filterReasoningBudget"];
  const reasoningBudget =
    reasoningBudgetRaw !== undefined && reasoningBudgetRaw !== null && reasoningBudgetRaw !== ""
      ? Number(reasoningBudgetRaw)
      : undefined;

  let raw: string;
  try {
    raw = await singleShotLLM(system, userText, {
      reasoning: { mode: reasoningMode, budget: reasoningBudget },
    });
  } catch (err) {
    console.warn("[llm] tool filter LLM call failed:", err);
    return {
      kept: allowed,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  const allowedSet = new Set(allowed);
  const picks = extractToolNames(raw, allowedSet);
  if (picks === null) {
    // Couldn't extract any candidates from the response. Surface the raw
    // output so the user can see exactly what the filter LLM said. Fall
    // back to keeping all candidates so the main model still has tools.
    return {
      kept: allowed,
      errorMessage: `Filter LLM did not return a recognizable list. Raw response:\n${raw || "<empty>"}`,
    };
  }
  // Dedupe while preserving first-seen order. Small filter LLMs sometimes
  // emit the same tool name multiple times (and we drop hallucinated names
  // here too, since allowedSet is the source of truth).
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const name of picks) {
    if (!allowedSet.has(name) || seen.has(name)) continue;
    seen.add(name);
    kept.push(name);
  }
  return { kept };
}

/** Extract a tool-name list from a filter-LLM response. Tries strict JSON
 *  first, then falls back to a lenient pass that handles bare-identifier
 *  arrays like `[open_website, send_email]` and free-form prose containing
 *  identifier-shaped names. Caller dedupes and intersects with the allowed
 *  set, so this can be aggressive. Returns null only when nothing usable
 *  was found at all. */
function extractToolNames(raw: string, allowed: Set<string>): string[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  // Scope: bracketed substring if present, otherwise the whole response.
  // small models sometimes drop the brackets.
  const scope = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  // Strict JSON first. Caller passes through whatever array we return; if a
  // string-only array round-trips cleanly we're done.
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(scope);
      if (Array.isArray(parsed)) {
        const strs = parsed.filter((v): v is string => typeof v === "string");
        if (strs.length > 0) return strs;
      }
    } catch {
      // fall through to lenient parsing
    }
  }

  // Lenient: pluck every identifier-shaped token. Tool names are typically
  // snake_case ASCII, but we accept anything matching `[A-Za-z_][\w]*` so we
  // can also recognize camelCase-named tools. Quotes (single or double),
  // backticks, and surrounding punctuation are stripped naturally because
  // we just match the identifier.
  const matches = scope.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!matches) return null;
  // Filter to only tokens that are actual tool names. This keeps obvious
  // hallucinations (and stray English words) out of the result. If the
  // intersection is empty, return [] (an explicit "filter kept nothing")
  // rather than null so we don't fall back to "keep every candidate".
  const inAllowed = matches.filter((m) => allowed.has(m));
  return inAllowed;
}

/** Trim a sorted-by-score candidate list to the largest prefix that fits
 *  inside `budgetTokens`. Single batched tokenize round (one /tokenize call
 *  per entry in parallel for local; vectorized char/4 for external).
 *
 *  Per-entry sums are an upper bound on the concatenated tokenization (BPE
 *  merges across boundaries can only ever reduce the count), so the prefix
 *  scan is correct as a budget gate even if a few tokens of capacity are
 *  wasted to safety. */
async function fitCandidatesInBudget(
  candidates: ToolDescriptor[],
  fixedOverheadText: string,
  budgetTokens: number,
): Promise<ToolDescriptor[]> {
  if (candidates.length === 0) return [];
  const entries = candidates.map((c) => `${catalogEntry(c)}\n`);
  const [headerTokens, ...entryTokens] = await tokenizeMany([fixedOverheadText, ...entries]);
  let running = headerTokens;
  for (let i = 0; i < candidates.length; i++) {
    if (running + entryTokens[i] > budgetTokens) {
      return candidates.slice(0, i);
    }
    running += entryTokens[i];
  }
  return candidates;
}

/** Compute how many tokens are available for the phase-1 catalog given the
 *  active LLM's context size and (when known) the prior turn's usage. Negative
 *  values mean "no headroom"; the caller should still try to fit at least
 *  PHASE1_FLOOR candidates. */
function computeBudgetTokens(secondPass: boolean, userPromptTokens: number): number {
  const ctx = getContextSize();
  if (secondPass) {
    // Phase 2 is a fresh single-shot call, so we don't subtract prior usage.
    return Math.floor((ctx - OUTPUT_RESERVE_TOKENS) * SAFETY_MARGIN);
  }
  // Tools go onto the main turn's prompt; subtract what's already there.
  const used = messagesState.tokenUsage?.totalTokens ?? 0;
  return Math.floor((ctx - used - userPromptTokens - OUTPUT_RESERVE_TOKENS) * SAFETY_MARGIN);
}

/** Build the OpenAI `tools` array for this turn and drive the RelevantTools
 *  bubble through its lifecycle. Returns undefined when tool use is disabled
 *  or no tools survive. */
async function selectToolsForTurn(
  userText: string,
  userMessageId: string | undefined,
): Promise<OpenAI.ChatCompletionTool[] | undefined> {
  const settings = settingsState.currentSettings;

  const removeBubble = () => {
    if (userMessageId) messagesState.removeToolFilterMessage(userMessageId);
  };

  // No-bubble cases. Every guard below means "we send 0 tools and don't
  // want to clutter the chat with a bubble". The bubble only exists to show
  // *what filtering did*; if no filtering happened (or there was nothing to
  // filter), there's nothing to show.
  if (!settings["tools.enabled"]) {
    removeBubble();
    return undefined;
  }
  // No enabled toolkits with indexed tools, so there's literally nothing to
  // send, so don't show a bubble. (Previously this surfaced an error bubble;
  // the user explicitly preferred silence here so a fresh session with no
  // toolkits stays clean.)
  if (!toolkitsState.hasEnabledTools()) {
    removeBubble();
    return undefined;
  }
  // Empty user text (e.g. attachments-only turn). No filter to run.
  if (!userText.trim()) {
    removeBubble();
    return undefined;
  }

  // Filtering can be globally disabled, or auto-skipped when the user's total
  // tool count is below their configured threshold. In either case we ship
  // every enabled tool to the model (clipped to PHASE1_HARD_CAP as a safety
  // net so we don't accidentally blow past the model's context window) and
  // surface them in the bubble's "Always Available" section. From the
  // model's perspective every tool sent this turn was unconditional.
  const filteringEnabled = settings["tools.filteringEnabled"] !== false;
  const allEnabled = toolkitsState.allEnabledTools();
  const minTools = clampInt(settings["tools.filteringMinTools"], 0, 0, 1000);
  if (!filteringEnabled || allEnabled.length < minTools) {
    if (allEnabled.length === 0) {
      removeBubble();
      return undefined;
    }
    const sliced = allEnabled.slice(0, PHASE1_HARD_CAP);
    const bypassEntries: RelevantToolPhase2Entry[] = sliced.map((t) => ({
      name: t.name,
      description: t.description,
    }));
    if (userMessageId) {
      messagesState.upsertToolFilterMessage(userMessageId, {
        status: "complete",
        phase1: null,
        phase2: null,
        alwaysAvailable: bypassEntries,
      });
    }
    try {
      const tools = await toolkitsState.toolSchemas(sliced.map((t) => t.id));
      return tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined;
    } catch (err) {
      console.warn("[llm] toolSchemas (unfiltered) call threw:", err);
      return undefined;
    }
  }

  const secondPassEnabled = settings["tools.secondPassEnabled"] !== false;
  const maxTools = clampInt(settings["tools.maxTools"], 30, 1, 99);

  const updateBubble = (patch: Parameters<typeof messagesState.updateRelevantTools>[1]) => {
    if (userMessageId) messagesState.updateRelevantTools(userMessageId, patch);
  };
  const errorBubble = (msg: string) => {
    updateBubble({ status: "error", errorMessage: msg });
  };

  // Reset the bubble to a fresh "filtering" spinner regardless of how we got
  // here (initial send, reprocess, edit-and-resend). Done AFTER the gating
  // checks so we don't briefly flash a bubble for a no-op turn.
  if (userMessageId) {
    messagesState.upsertToolFilterMessage(userMessageId, {
      status: "filtering",
      phase1: null,
      phase2: null,
      alwaysAvailable: null,
    });
  }

  // Hoist always-available bypass setup so the early-out paths (vector
  // unavailable, no phase-1 candidates, filter LLM kept nothing) can still
  // ship those tools. The bypass exists precisely so high-value tools
  // aren't gated on the filter pipeline succeeding.
  const alwaysAvailableEnabled = settings["tools.alwaysAvailableEnabled"] !== false;
  const alwaysTools = alwaysAvailableEnabled
    ? toolkitsState.allEnabledTools().filter((t) => t.alwaysAvailable)
    : [];

  // Compute the always-available union and the bubble entries describing
  // which tools were appended (skipping any already covered by the filter
  // result). Returns the final ordered id list + the snapshot for the
  // bubble's "Always Available" section.
  function applyAlwaysBypass(filteredIds: string[]): {
    finalIds: string[];
    bypassEntries: RelevantToolPhase2Entry[];
  } {
    if (alwaysTools.length === 0) {
      return { finalIds: filteredIds, bypassEntries: [] };
    }
    const seen = new Set(filteredIds);
    const finalIds = [...filteredIds];
    const bypassEntries: RelevantToolPhase2Entry[] = [];
    for (const t of alwaysTools) {
      if (seen.has(t.id)) continue;
      finalIds.push(t.id);
      seen.add(t.id);
      bypassEntries.push({ name: t.name, description: t.description });
    }
    return { finalIds, bypassEntries };
  }

  // Wrap bypass entries for the bubble: returns null when the bypass section
  // shouldn't appear at all (toggle off, no tagged tools, or nothing to add
  // because every tagged tool was already in the filter result). The bubble
  // hides any null bucket entirely so the user sees only sections that
  // actually contributed tools this turn.
  function bypassBucket(entries: RelevantToolPhase2Entry[]): RelevantToolPhase2Entry[] | null {
    if (!alwaysAvailableEnabled || alwaysTools.length === 0 || entries.length === 0) {
      return null;
    }
    return entries;
  }

  const vector = await toolkitsState.embed(userText);
  if (!vector) {
    console.info("[llm] embedding model not ready; skipping tool injection");
    errorBubble(
      "Embedding model not ready. The Bun sidecar's embedding model is still loading or unreachable. Try again in a moment.",
    );
    return undefined;
  }

  // Always request the hard cap from the sidecar; it returns however many
  // exist, sorted by score. Frontend then trims by token budget.
  let rawCandidates: ToolDescriptor[];
  try {
    rawCandidates = await toolkitsState.filter(vector, PHASE1_HARD_CAP);
  } catch (err) {
    console.warn("[llm] phase-1 filter call threw:", err);
    errorBubble(
      `Phase 1 (embedding similarity) call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (rawCandidates.length === 0) {
    // Embedding ran, found nothing. Skip phase 2 (no tools to filter) but
    // still let the always-available bypass inject tools.
    const { finalIds, bypassEntries } = applyAlwaysBypass([]);
    updateBubble({
      status: "complete",
      phase1: [],
      phase2: secondPassEnabled ? [] : null,
      alwaysAvailable: bypassBucket(bypassEntries),
    });
    if (finalIds.length === 0) return undefined;
    try {
      const tools = await toolkitsState.toolSchemas(finalIds);
      return tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined;
    } catch (err) {
      console.warn("[llm] toolSchemas (phase1-empty) call threw:", err);
      return undefined;
    }
  }

  // Fit the candidates against the appropriate budget. For phase 2, we tokenize
  // against the actual filter prompt (header + user text). For "no phase 2",
  // we tokenize against just the user prompt (the main turn's overhead is
  // already accounted for via tokenUsage).
  let fitted: ToolDescriptor[];
  try {
    const fixedOverhead = secondPassEnabled ? `${PHASE2_PROMPT_HEADER}\n\n${userText}` : userText;
    const userPromptTokens = await tokenize(userText);
    const budget = computeBudgetTokens(secondPassEnabled, userPromptTokens);
    fitted = await fitCandidatesInBudget(rawCandidates, fixedOverhead, budget);
    if (fitted.length < PHASE1_FLOOR) {
      // Floor: accept overflow rather than ship a tiny menu. The filter LLM
      // (or the main LLM, if phase 2 is disabled) handles oversized prompts
      // more gracefully than running with too few tools.
      fitted = rawCandidates.slice(0, Math.min(PHASE1_FLOOR, rawCandidates.length));
    }
  } catch (err) {
    console.warn("[llm] phase-1 budget fitting threw:", err);
    // Tokenization or sizing math blew up. Fall through with a conservative
    // default (top-N by score) so the user still gets tools, and surface
    // the underlying error on the bubble.
    fitted = rawCandidates.slice(0, Math.min(PHASE1_FLOOR, rawCandidates.length));
    errorBubble(
      `Phase 1 budget sizing failed (using top-${fitted.length} fallback): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const phase1Snapshot: RelevantToolPhase1Entry[] = fitted.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    score: c.score,
  }));
  updateBubble({ phase1: phase1Snapshot });

  if (!secondPassEnabled) {
    // Skip the LLM filter entirely. Cap at maxTools and ship.
    const truncated = fitted.slice(0, maxTools);
    const truncatedPhase1 = phase1Snapshot.slice(0, maxTools);
    const { finalIds, bypassEntries } = applyAlwaysBypass(truncated.map((c) => c.id));
    updateBubble({
      status: "complete",
      phase1: truncatedPhase1,
      phase2: null,
      alwaysAvailable: bypassBucket(bypassEntries),
    });
    if (finalIds.length === 0) return undefined;
    try {
      const tools = await toolkitsState.toolSchemas(finalIds);
      return tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined;
    } catch (err) {
      console.warn("[llm] toolSchemas call threw:", err);
      errorBubble(
        `Failed to fetch tool schemas: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  const filterResult = await llmFilterTools(userText, fitted);
  let keptNames = filterResult.kept;
  if (keptNames.length === 0 && !filterResult.errorMessage) {
    // The filter said "keep nothing". Always-available bypass still runs.
    const { finalIds, bypassEntries } = applyAlwaysBypass([]);
    updateBubble({
      status: "complete",
      phase2: [],
      alwaysAvailable: bypassBucket(bypassEntries),
    });
    if (finalIds.length === 0) return undefined;
    try {
      const tools = await toolkitsState.toolSchemas(finalIds);
      return tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined;
    } catch (err) {
      console.warn("[llm] toolSchemas (bypass-only) call threw:", err);
      return undefined;
    }
  }
  // Cap at maxTools as a final safety net.
  if (keptNames.length > maxTools) keptNames = keptNames.slice(0, maxTools);

  const keptIds = keptNames
    .map((name) => fitted.find((c) => c.name === name)?.id)
    .filter((v): v is string => typeof v === "string");
  const phase2Snapshot: RelevantToolPhase2Entry[] = keptNames
    .map((name) => fitted.find((c) => c.name === name))
    .filter((c): c is ToolDescriptor => c !== undefined)
    .map((c) => ({ name: c.name, description: c.description }));

  const { finalIds, bypassEntries } = applyAlwaysBypass(keptIds);

  if (filterResult.errorMessage) {
    updateBubble({
      status: "error",
      phase2: phase2Snapshot,
      alwaysAvailable: bypassBucket(bypassEntries),
      errorMessage: filterResult.errorMessage,
    });
  } else {
    updateBubble({
      status: "complete",
      phase2: phase2Snapshot,
      alwaysAvailable: bypassBucket(bypassEntries),
    });
  }

  if (finalIds.length === 0) return undefined;
  try {
    const tools = await toolkitsState.toolSchemas(finalIds);
    return tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined;
  } catch (err) {
    console.warn("[llm] toolSchemas call threw:", err);
    errorBubble(
      `Failed to fetch tool schemas: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// --- Main streaming driver ---

interface RunStreamOpts {
  route: "default" | "secondary";
  /** Messages (chronological order) to include in the request body. Includes
   *  user, assistant (with pendingToolCalls re-inflated as `tool_calls`), and
   *  `role: "tool"` messages whose toolCall.status === "complete". The
   *  incomplete tool messages are deliberately skipped so interrupted prior
   *  turns don't leak half-finished state into the next request. */
  contextMessages: Message[];
  /** User message whose systemPromptOverride should be consulted for this
   *  turn, if any. Also drives the RelevantTools bubble update target via
   *  its `id`. */
  lastUserMsg: { id?: string; systemPromptOverride?: string } | undefined;
  /** When set, fire-and-forget title generation from this first user message. */
  firstUserContentForTitle: MessageContent | null;
  signal: AbortSignal;
}

/** Materialize in-state Messages into OpenAI-shaped wire messages. Handles
 *  the full tool-call round-trip: assistant messages with pendingToolCalls
 *  become `{ role: "assistant", content, tool_calls: [...] }` and
 *  `role: "tool"` messages become `{ role: "tool", tool_call_id, content }`
 *  using the stringified result from the stored `toolCall.result`.
 *
 *  Guarantees the output is OpenAI-valid: every assistant message with
 *  `tool_calls` is followed by exactly one `tool`-role message per call id.
 *  If a tool result is missing (session was closed mid-call, or the user
 *  cancelled), we synthesize a JSON error payload so the LLM sees a
 *  terminal answer for every tool it requested. Sending a tool_calls
 *  assistant message without matching tool responses is a 400 from the
 *  OpenAI API. */
async function materializeContext(messages: Message[]): Promise<ApiMessage[]> {
  // Build a quick lookup so we can pair assistant-with-tool_calls messages
  // with their completed tool responses even if a cancelled/failed tool
  // message broke the chain.
  const toolByCallId = new Map<string, Message>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCall?.toolCallId) {
      toolByCallId.set(m.toolCall.toolCallId, m);
    }
  }

  const out: ApiMessage[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: await contentToApi(m.content) });
    } else if (m.role === "assistant") {
      if (m.pendingToolCalls && m.pendingToolCalls.length > 0) {
        // Assistant turn that requested tools. Content may be empty - the
        // OpenAI API accepts null content when tool_calls is populated.
        const text = typeof m.content === "string" ? m.content : getTextContent(m.content);
        out.push({
          role: "assistant",
          content: text || null,
          tool_calls: m.pendingToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments || "{}" },
          })),
        });
        // Emit a tool response for every requested call, synthesizing a
        // placeholder error for ones without a stored result. Preserves
        // OpenAI's strict pairing rule.
        for (const tc of m.pendingToolCalls) {
          const toolMsg = toolByCallId.get(tc.id);
          let resultStr: string;
          if (toolMsg?.toolCall?.status === "complete") {
            resultStr = JSON.stringify(toolMsg.toolCall.result ?? null);
          } else if (toolMsg?.toolCall?.status === "failed") {
            resultStr = JSON.stringify({
              error: toolMsg.toolCall.error ?? "tool failed",
            });
          } else if (toolMsg?.toolCall?.status === "cancelled") {
            resultStr = JSON.stringify({
              error: toolMsg.toolCall.error ?? "tool cancelled",
            });
          } else {
            resultStr = JSON.stringify({ error: "tool response missing" });
          }
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            content: resultStr,
          });
        }
      } else {
        out.push({ role: "assistant", content: await contentToApi(m.content) });
      }
    }
    // Standalone `role: "tool"` messages are now redundant with the
    // emit-after-assistant logic above - skip them to avoid duplicate
    // tool_call_id responses.
    // system/error roles are skipped: system is prepended separately,
    // error bubbles are UI-only (never part of the wire transcript).
  }
  return out;
}

async function runStream(opts: RunStreamOpts): Promise<void> {
  const settings = settingsState.currentSettings;
  const provider = settings["llm.provider"];
  const usingSecondary = opts.route === "secondary";
  const client = usingSecondary ? getSecondaryLLMClient() : getLLMClient();

  let apiMessages: ApiMessage[] = await materializeContext(opts.contextMessages);

  const baseSystemPrompt = opts.lastUserMsg?.systemPromptOverride ?? buildSystemPrompt();

  const userText = (() => {
    // The last user message drives tool selection. Scan from the end since
    // the tail may be a tool-role message if this turn is a follow-up after
    // the LLM already emitted a tool_call earlier in the session.
    for (let i = opts.contextMessages.length - 1; i >= 0; i--) {
      const m = opts.contextMessages[i];
      if (m.role === "user") return getTextContent(m.content);
    }
    return "";
  })();

  // Phase-1 + phase-2 tool filter. Skipped automatically when tool use is
  // disabled or no tools survive. The user message id drives the
  // RelevantTools bubble through its lifecycle.
  const tools = await selectToolsForTurn(userText, opts.lastUserMsg?.id);
  const systemPrompt = buildSystemPromptForTurn({
    base: baseSystemPrompt,
    toolsHint: !!tools && tools.length > 0,
  });
  if (systemPrompt) {
    apiMessages.unshift({ role: "system", content: systemPrompt });
  }
  messagesState.setDisplaySystemPrompt(systemPrompt);

  const useReasoning =
    !usingSecondary && provider !== "external" && settings["llm.reasoning"] === "on";
  const reasoningBudget = settings["llm.reasoningBudget"];
  const model = usingSecondary
    ? settings["dualModel.external.model"]
    : provider === "external"
      ? settings["llm.external.model"]
      : "default";
  const maxHops = clampInt(settings["tools.maxHops"], 5, 1, 99);

  if (opts.firstUserContentForTitle !== null) {
    const content = opts.firstUserContentForTitle;
    const textForTitle =
      typeof content === "string"
        ? content
        : content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ");

    generateSessionTitle(textForTitle)
      .then((title) => {
        if (title) {
          messagesState.updateTitle(title);
        }
      })
      .catch((e) => console.warn("[llm] Title generation failed:", e));
  }

  let hop = 0;
  // Always stream the first turn. Subsequent tool-continuation hops also
  // stream so the UI keeps its live feel.
  while (true) {
    const request: OpenAI.ChatCompletionCreateParamsStreaming & {
      reasoning?: { effort: string; budget: number };
    } = {
      model,
      messages: apiMessages as OpenAI.ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (useReasoning && reasoningBudget) {
      request.reasoning = { effort: "high", budget: Number(reasoningBudget) };
    }
    if (tools && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = "auto";
    }

    if (hop > 0) {
      // We've already closed out the previous assistant bubble. Start a
      // fresh streaming slot for the next assistant turn (which may or may
      // not emit more tool_calls).
      messagesState.startStreaming(opts.route);
    }

    const completionStream = await client.chat.completions.create(request, {
      signal: opts.signal,
    });

    // Accumulators for tool_calls arriving as streamed deltas.
    const pendingCalls: PendingToolCall[] = [];
    let finishReason: string | null = null;

    for await (const chunk of completionStream) {
      const choice = chunk.choices?.[0];
      const choiceDelta = choice?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice["delta"] & {
            reasoning_content?: string | null;
            reasoning?: string | null;
          })
        | undefined;

      const reasoningDelta = choiceDelta?.reasoning_content || choiceDelta?.reasoning || "";
      if (reasoningDelta) {
        messagesState.appendReasoning(reasoningDelta);
      }

      const contentDelta = choiceDelta?.content || "";
      if (contentDelta) {
        messagesState.appendToStreaming(contentDelta);
      }

      const tcDelta = choiceDelta?.tool_calls;
      if (tcDelta && Array.isArray(tcDelta)) {
        for (const d of tcDelta) {
          // OpenAI streams tool_calls indexed by position. Each chunk may
          // carry a partial `arguments` string that must be concatenated in
          // order; `id` and `function.name` typically arrive in the first
          // chunk for that index.
          const idx = typeof d.index === "number" ? d.index : pendingCalls.length;
          while (pendingCalls.length <= idx) {
            pendingCalls.push({ id: "", name: "", arguments: "" });
          }
          const slot = pendingCalls[idx];
          if (typeof d.id === "string" && d.id) slot.id = d.id;
          if (d.function) {
            if (typeof d.function.name === "string" && d.function.name) slot.name = d.function.name;
            if (typeof d.function.arguments === "string") {
              slot.arguments += d.function.arguments;
            }
          }
        }
      }

      if (chunk.usage) {
        messagesState.updateTokenUsage({
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        });
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // No tool calls? Normal end-of-turn.
    if (finishReason !== "tool_calls" || pendingCalls.length === 0) {
      return;
    }

    // We're branching into a tool-call loop. Attach the pending calls to
    // the assistant bubble for session replay and close out the streaming
    // slot without emitting a TTS finalize.
    const validCalls = pendingCalls.filter((c) => c.id && c.name);
    if (validCalls.length === 0) {
      // Malformed tool_calls - treat as a normal finish.
      return;
    }
    messagesState.setPendingToolCalls(validCalls);
    messagesState.finishStreamingForToolCalls();

    // Append the assistant message (with tool_calls) to the API context so
    // the next hop gets the full, canonical shape.
    apiMessages.push({
      role: "assistant",
      content: null,
      tool_calls: validCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      })),
    });

    // Dispatch each tool call to the Bun worker pool and await its result
    // (possibly with askUser round-trips in between). Serialize for now -
    // parallel tool calls against a shared toolkit are likely but the
    // askUser UX would get confusing if two forms showed up at once.
    const chatContext = {
      userMessage: userText,
      sessionId: messagesState.sessionId,
    };
    for (const call of validCalls) {
      const outcome = await toolkitsState.dispatchToolCall({
        toolCallId: call.id,
        toolName: call.name,
        argsRaw: call.arguments || "{}",
        chatContext,
      });
      const resultContent = outcome.ok
        ? JSON.stringify(outcome.result ?? null)
        : JSON.stringify({
            error: outcome.cancelled ? "tool cancelled by user" : (outcome.error ?? "tool failed"),
          });
      apiMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultContent,
      });
    }

    hop += 1;
    if (hop >= maxHops) {
      messagesState.receiveErrorMessage(
        "server_error",
        `Tool hop limit (${maxHops}) reached - stopping.`,
      );
      return;
    }
  }
}

export async function sendMessages(): Promise<void> {
  const controller = new AbortController();
  setInterruptController(controller);

  const route = await routeSelection();
  messagesState.startStreaming(route);

  try {
    const settings = settingsState.currentSettings;

    // Build chronological context from all non-system messages. Keeps user,
    // assistant (including ones that emitted tool_calls), and completed
    // `role: "tool"` rounds so the LLM has the full transcript on follow-up
    // turns. System, error, reasoning, and tool_filter roles are filtered
    // out here. System is re-prepended from settings, error/reasoning/
    // tool_filter bubbles are UI-only and never part of the wire transcript.
    const contextMessages: Message[] = messagesState.messages
      .slice()
      .reverse()
      .filter(
        (m) =>
          m.role !== "system" &&
          m.role !== "error" &&
          m.role !== "reasoning" &&
          m.role !== "tool_filter",
      );

    // Exclude the last incomplete assistant placeholder (pushed by
    // startStreaming). It's always the last element if present.
    if (
      contextMessages.length > 0 &&
      contextMessages[contextMessages.length - 1].role === "assistant"
    ) {
      const tail = contextMessages[contextMessages.length - 1];
      // Streaming placeholder has empty content and no tool calls.
      if (
        (typeof tail.content === "string" ? tail.content : getTextContent(tail.content)) === "" &&
        (!tail.pendingToolCalls || tail.pendingToolCalls.length === 0)
      ) {
        contextMessages.pop();
      }
    }

    const userCount = contextMessages.filter((m) => m.role === "user").length;
    const isFirstUserMessage = userCount === 1;
    const firstUser = contextMessages.find((m) => m.role === "user");
    const lastUserMsg = messagesState.messages.find((m) => m.role === "user");

    const currentTitle = messagesState.sessionTitle;
    const defaultTitle = messagesState.getDefaultTitle();
    const shouldGenerateTitle =
      isFirstUserMessage &&
      firstUser !== undefined &&
      settings["general.session.storeSessions"] !== false &&
      (!currentTitle || currentTitle === defaultTitle);

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: shouldGenerateTitle && firstUser ? firstUser.content : null,
      signal: controller.signal,
    });
    messagesState.finishStreaming();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return;
    }
    console.error(`[llm] Stream error:`, err);
    const mapped = mapError(err);
    messagesState.receiveErrorMessage(mapped.type, mapped.detail);
  } finally {
    setInterruptController(null);
  }
}

/** Regenerate a single assistant message in place. Only uses messages
 *  chronologically before the target as context; newer turns stay untouched. */
export async function reprocessMessage(messageId: string): Promise<void> {
  const initialIdx = messagesState.messages.findIndex((m) => m.id === messageId);
  if (initialIdx < 0) return;

  const target = messagesState.messages[initialIdx];
  // Preserve the route the user originally saw for this bubble; reprocess is a
  // "regenerate the same answer" action, not a re-route decision.
  const route: "default" | "secondary" = target.modelUsed === "secondary" ? "secondary" : "default";

  if (!messagesState.beginReprocess(messageId)) return;

  const controller = new AbortController();
  setInterruptController(controller);

  try {
    // beginReprocess can mutate the messages array (e.g. splice a paired
    // reasoning bubble, or unshift a fresh tool_filter bubble). Re-find the
    // target by id afterwards so `slice` still excludes the empty assistant
    // slot we just cleared; otherwise it'd land at the tail of the
    // contextMessages and llama.cpp would reject it as an "assistant
    // response prefill is incompatible with enable_thinking".
    const targetIdx = messagesState.messages.findIndex((m) => m.id === messageId);
    if (targetIdx < 0) return;

    // Messages newest-first: everything at index > targetIdx is chronologically
    // older (and thus valid context for the target). Include tool rounds so
    // the regenerated response sees the same transcript the original did.
    const contextMessages: Message[] = messagesState.messages
      .slice(targetIdx + 1)
      .reverse()
      .filter(
        (m) =>
          m.role !== "system" &&
          m.role !== "error" &&
          m.role !== "reasoning" &&
          m.role !== "tool_filter",
      );

    const lastUserMsg = messagesState.messages.slice(targetIdx + 1).find((m) => m.role === "user");

    // When the user edits the first turn's user message, the session title
    // should regenerate alongside the response. updateUserMessage resets the
    // title to the default in that case so this check fires.
    const settings = settingsState.currentSettings;
    const userCount = contextMessages.filter((m) => m.role === "user").length;
    const firstUser = contextMessages.find((m) => m.role === "user");
    const currentTitle = messagesState.sessionTitle;
    const defaultTitle = messagesState.getDefaultTitle();
    const shouldGenerateTitle =
      userCount === 1 &&
      firstUser !== undefined &&
      settings["general.session.storeSessions"] !== false &&
      (!currentTitle || currentTitle === defaultTitle);

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: shouldGenerateTitle && firstUser ? firstUser.content : null,
      signal: controller.signal,
    });
    messagesState.finishStreaming();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return;
    }
    console.error(`[llm] Stream error:`, err);
    const mapped = mapError(err);
    messagesState.receiveErrorMessage(mapped.type, mapped.detail);
  } finally {
    setInterruptController(null);
  }
}
