/**
 * Two-phase tool relevance filter for the active turn. Phase 1 is an
 * embedding-similarity prefilter against the user prompt, run by the
 * sidecar; phase 2 is an LLM cross-check that drops obviously-unrelated
 * survivors. The "always-available bypass" then unions in any tools the
 * user marked as unconditional. Drives the RelevantTools bubble through its
 * lifecycle and returns the OpenAI `tools` array (or undefined).
 */

import type OpenAI from "openai";
import { messagesState, settingsState, toolkitsState } from "$lib/state";
import { tokenize, tokenizeMany } from "$lib/shared/tokenize";
import type { RelevantToolPhase1Entry, RelevantToolPhase2Entry } from "$lib/shared/types";
import type { ToolDescriptor } from "$lib/state/toolkits.svelte";
import { getContextSize, singleShotLLM } from "./client";

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
  // string-only array round-trips cleanly we're done. An empty array is a
  // valid "filter kept nothing" result and must not fall through to lenient
  // parsing (which would return null and trip the error path).
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(scope);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
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

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Build the OpenAI `tools` array for this turn and drive the RelevantTools
 *  bubble through its lifecycle. Returns undefined when tool use is disabled
 *  or no tools survive. */
export async function selectToolsForTurn(
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
