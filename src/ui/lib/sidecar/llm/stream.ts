/**
 * Chat-completion streaming driver. `sendMessages` is the public entry for a
 * fresh user turn; `reprocessMessage` regenerates an existing assistant
 * message in place. Both feed into `runStream`, which drives a small
 * pipeline of stages:
 *
 *   buildStreamRequest → provider.createClient → consumeStream
 *   consumeStream = parseChunk → ToolCallAssembler + emitChunk
 *
 * After consumption finishes, the loop either returns (no tool calls) or
 * dispatches the assembled tool calls into the toolkit pool, appends the
 * assistant + tool messages to the API context, and re-enters for the next
 * hop.
 */

import type OpenAI from "openai";
import {
  messagesState,
  persistenceState,
  sessionsState,
  settingsState,
  streamingState,
  toolkitsState,
} from "$lib/state";
import { setInterruptController } from "$lib/shared/interrupt";
import { buildSystemPrompt, buildSystemPromptForTurn } from "$lib/shared/systemPrompt";
import {
  getTextContent,
  type Message,
  type MessageContent,
  type PendingToolCall,
  type TokenUsage,
} from "$lib/shared/types";
import { getProvider, singleShotLLM, type LLMProvider, type ReasoningCarrier } from "./client";
import { mapError } from "./errors";
import { generateSessionTitle } from "./title";
import { selectToolsForTurn } from "./toolFilter";
import { contentToApi, type ApiMessagePart } from "./wire";

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

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** When dual-model routing is enabled, ask the default model whether the last
 *  user message warrants the stronger external model. */
async function routeSelection(): Promise<"default" | "secondary"> {
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

// ---------------------------------------------------------------------------
// Stage: materialize wire context (state Messages → OpenAI ApiMessages)
// ---------------------------------------------------------------------------

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
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            content: stringifyToolResultMessage(toolMsg),
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

function stringifyToolResultMessage(toolMsg: Message | undefined): string {
  const tc = toolMsg?.toolCall;
  if (tc?.status === "complete") {
    return JSON.stringify(tc.result ?? null);
  }
  if (tc?.status === "failed") {
    return JSON.stringify({ error: tc.error ?? "tool failed" });
  }
  if (tc?.status === "cancelled") {
    return JSON.stringify({ error: tc.error ?? "tool cancelled" });
  }
  return JSON.stringify({ error: "tool response missing" });
}

// ---------------------------------------------------------------------------
// Stage: requestBuilder
// ---------------------------------------------------------------------------

function buildStreamRequest(
  provider: LLMProvider,
  apiMessages: ApiMessage[],
  tools: OpenAI.ChatCompletionTool[] | undefined,
): OpenAI.ChatCompletionCreateParamsStreaming & ReasoningCarrier {
  const request: OpenAI.ChatCompletionCreateParamsStreaming & ReasoningCarrier = {
    model: provider.getModel(),
    messages: apiMessages as OpenAI.ChatCompletionMessageParam[],
    stream: true,
    stream_options: { include_usage: true },
  };
  provider.applyStreamReasoning(request);
  if (tools && tools.length > 0) {
    request.tools = tools;
    request.tool_choice = "auto";
  }
  return request;
}

// ---------------------------------------------------------------------------
// Stage: chunkParser
// ---------------------------------------------------------------------------

interface ParsedChunk {
  contentDelta: string;
  reasoningDelta: string;
  toolCallDeltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[];
  finishReason: string | null;
  usage: TokenUsage | null;
}

function parseChunk(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): ParsedChunk {
  const choice = chunk.choices?.[0];
  // Some providers (notably llama.cpp) tunnel reasoning text through
  // non-standard delta fields; cast covers both shapes.
  const choiceDelta = choice?.delta as
    | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice["delta"] & {
        reasoning_content?: string | null;
        reasoning?: string | null;
      })
    | undefined;

  const tcDelta = choiceDelta?.tool_calls;
  return {
    contentDelta: choiceDelta?.content || "",
    reasoningDelta: choiceDelta?.reasoning_content || choiceDelta?.reasoning || "",
    toolCallDeltas: tcDelta && Array.isArray(tcDelta) ? tcDelta : [],
    finishReason: choice?.finish_reason ?? null,
    usage: chunk.usage
      ? {
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Stage: toolCallAssembler
// ---------------------------------------------------------------------------

/** Accumulates streaming tool_call deltas into a list of fully-formed
 *  PendingToolCall objects. OpenAI streams tool_calls indexed by position;
 *  each chunk may carry a partial `arguments` string that must be
 *  concatenated in order. `id` and `function.name` typically arrive in the
 *  first chunk for that index but we tolerate any arrival order. */
class ToolCallAssembler {
  private pending: PendingToolCall[] = [];

  ingest(deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]): void {
    for (const d of deltas) {
      const idx = typeof d.index === "number" ? d.index : this.pending.length;
      while (this.pending.length <= idx) {
        this.pending.push({ id: "", name: "", arguments: "" });
      }
      const slot = this.pending[idx];
      if (typeof d.id === "string" && d.id) slot.id = d.id;
      if (d.function) {
        if (typeof d.function.name === "string" && d.function.name) slot.name = d.function.name;
        if (typeof d.function.arguments === "string") {
          slot.arguments += d.function.arguments;
        }
      }
    }
  }

  /** Return the assembled list. Slots without an id+name are returned too;
   *  callers filter as needed (a malformed tool_call should usually be
   *  treated as no tool_calls at all). */
  drain(): PendingToolCall[] {
    return this.pending;
  }
}

// ---------------------------------------------------------------------------
// Stage: messageEmitter
// ---------------------------------------------------------------------------

/** Push a parsed chunk's content / reasoning / usage into messagesState.
 *  Tool-call deltas are NOT emitted here (the assembler holds them until
 *  the stream ends). */
function emitParsedChunk(parsed: ParsedChunk): void {
  if (parsed.reasoningDelta) {
    streamingState.appendReasoning(parsed.reasoningDelta);
  }
  if (parsed.contentDelta) {
    streamingState.appendContent(parsed.contentDelta);
  }
  if (parsed.usage) {
    messagesState.tokenUsage = parsed.usage;
    persistenceState.scheduleSave();
  }
}

// ---------------------------------------------------------------------------
// Composition: consume one streaming completion end-to-end
// ---------------------------------------------------------------------------

interface ConsumeResult {
  pendingCalls: PendingToolCall[];
  finishReason: string | null;
}

async function consumeStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
): Promise<ConsumeResult> {
  const assembler = new ToolCallAssembler();
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const parsed = parseChunk(chunk);
    if (parsed.toolCallDeltas.length > 0) assembler.ingest(parsed.toolCallDeltas);
    emitParsedChunk(parsed);
    if (parsed.finishReason) finishReason = parsed.finishReason;
  }
  return { pendingCalls: assembler.drain(), finishReason };
}

// ---------------------------------------------------------------------------
// Tool-call hop helpers
// ---------------------------------------------------------------------------

function buildAssistantToolCallMessage(calls: PendingToolCall[]): ApiMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments || "{}" },
    })),
  };
}

function buildToolResponseMessage(
  callId: string,
  outcome: { ok: boolean; result?: unknown; error?: string; cancelled?: boolean },
): ApiMessage {
  const content = outcome.ok
    ? JSON.stringify(outcome.result ?? null)
    : JSON.stringify({
        error: outcome.cancelled ? "tool cancelled by user" : (outcome.error ?? "tool failed"),
      });
  return { role: "tool", tool_call_id: callId, content };
}

// ---------------------------------------------------------------------------
// Title generation (fire-and-forget; pinned to current sessionId)
// ---------------------------------------------------------------------------

function maybeKickOffTitleGeneration(content: MessageContent): void {
  const textForTitle =
    typeof content === "string"
      ? content
      : content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");

  // Pin the title to the session that was active when generation started.
  // If the user deletes or switches sessions before this resolves, the
  // generated title would otherwise land on the wrong session (or trigger a
  // "Session not found" save against an already-deleted id).
  const titleSessionId = sessionsState.id;
  generateSessionTitle(textForTitle)
    .then((title) => {
      if (title && sessionsState.id === titleSessionId) {
        sessionsState.updateTitle(title);
      }
    })
    .catch((e) => console.warn("[llm] Title generation failed:", e));
}

// ---------------------------------------------------------------------------
// Outer driver: build context, run the hop loop, dispatch tools
// ---------------------------------------------------------------------------

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

async function runStream(opts: RunStreamOpts): Promise<void> {
  const usingSecondary = opts.route === "secondary";
  const provider = getProvider(usingSecondary ? "secondary" : "primary");
  const client = provider.createClient();

  const apiMessages: ApiMessage[] = await materializeContext(opts.contextMessages);

  const baseSystemPrompt = opts.lastUserMsg?.systemPromptOverride ?? buildSystemPrompt();

  // The last user message drives tool selection. Scan from the end since
  // the tail may be a tool-role message if this turn is a follow-up after
  // the LLM already emitted a tool_call earlier in the session.
  const userText = (() => {
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
  messagesState.upsertSystemMessage(systemPrompt);

  const maxHops = clampInt(settingsState.currentSettings["tools.maxHops"], 5, 1, 99);

  if (opts.firstUserContentForTitle !== null) {
    maybeKickOffTitleGeneration(opts.firstUserContentForTitle);
  }

  // Always stream the first turn. Subsequent tool-continuation hops also
  // stream so the UI keeps its live feel.
  for (let hop = 0; ; hop++) {
    // Bail before any state mutation (notably `startStreaming` below) if the
    // outer controller was aborted while we were awaiting a tool call. The
    // tool-call await isn't tied to the AbortSignal, so a `tool_cancelled`
    // reply can resolve `dispatchToolCall` after `interruptStreaming` /
    // `deleteSession` already cleared the session; without this check we'd
    // race past the cleared state and append a phantom empty assistant
    // message + reschedule a save under a null sessionId.
    if (opts.signal.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new DOMException("Aborted", "AbortError");
    }

    if (hop > 0) {
      // We've already closed out the previous assistant bubble. Start a
      // fresh streaming slot for the next assistant turn (which may or may
      // not emit more tool_calls).
      streamingState.start(opts.route);
    }

    const request = buildStreamRequest(provider, apiMessages, tools);
    const stream = await client.chat.completions.create(request, { signal: opts.signal });
    const { pendingCalls, finishReason } = await consumeStream(stream);

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
    streamingState.setPendingToolCalls(validCalls);
    streamingState.pauseForToolCalls();

    // Append the assistant message (with tool_calls) to the API context so
    // the next hop gets the full, canonical shape.
    apiMessages.push(buildAssistantToolCallMessage(validCalls));

    // Dispatch each tool call to the Bun worker pool and await its result
    // (possibly with askUser round-trips in between). Serialize for now -
    // parallel tool calls against a shared toolkit are likely but the
    // askUser UX would get confusing if two forms showed up at once.
    const chatContext = {
      userMessage: userText,
      sessionId: sessionsState.id,
    };
    for (const call of validCalls) {
      const outcome = await toolkitsState.dispatchToolCall({
        toolCallId: call.id,
        toolName: call.name,
        argsRaw: call.arguments || "{}",
        chatContext,
      });
      apiMessages.push(buildToolResponseMessage(call.id, outcome));
    }

    if (hop + 1 >= maxHops) {
      streamingState.recordError("server_error", `Tool hop limit (${maxHops}) reached - stopping.`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

function shouldGenerateTitleFor(contextMessages: Message[]): boolean {
  const settings = settingsState.currentSettings;
  if (settings["general.session.storeSessions"] === false) return false;
  const firstUser = contextMessages.find((m) => m.role === "user");
  if (firstUser === undefined) return false;
  const userCount = contextMessages.filter((m) => m.role === "user").length;
  if (userCount !== 1) return false;
  const currentTitle = sessionsState.title;
  const defaultTitle = sessionsState.defaultTitle;
  return !currentTitle || currentTitle === defaultTitle;
}

function buildContextMessages(): Message[] {
  // Build chronological context from all non-system messages. Keeps user,
  // assistant (including ones that emitted tool_calls), and completed
  // `role: "tool"` rounds so the LLM has the full transcript on follow-up
  // turns. System, error, reasoning, and tool_filter roles are filtered
  // out here. System is re-prepended from settings, error/reasoning/
  // tool_filter bubbles are UI-only and never part of the wire transcript.
  const out: Message[] = messagesState.messages
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
  if (out.length > 0 && out[out.length - 1].role === "assistant") {
    const tail = out[out.length - 1];
    // Streaming placeholder has empty content and no tool calls.
    if (
      (typeof tail.content === "string" ? tail.content : getTextContent(tail.content)) === "" &&
      (!tail.pendingToolCalls || tail.pendingToolCalls.length === 0)
    ) {
      out.pop();
    }
  }
  return out;
}

export async function sendMessages(): Promise<void> {
  const controller = new AbortController();
  setInterruptController(controller);

  const route = await routeSelection();
  streamingState.start(route);

  try {
    const contextMessages = buildContextMessages();
    const firstUser = contextMessages.find((m) => m.role === "user");
    const lastUserMsg = messagesState.messages.find((m) => m.role === "user");
    const generateTitle = shouldGenerateTitleFor(contextMessages);

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: generateTitle && firstUser ? firstUser.content : null,
      signal: controller.signal,
    });
    streamingState.finish();
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      return;
    }
    console.error(`[llm] Stream error:`, err);
    const mapped = mapError(err);
    streamingState.recordError(mapped.type, mapped.detail);
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

  if (!streamingState.beginReprocess(messageId)) return;

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
    const firstUser = contextMessages.find((m) => m.role === "user");
    // When the user edits the first turn's user message, the session title
    // should regenerate alongside the response. updateUserMessage resets the
    // title to the default in that case so this check fires.
    const generateTitle = shouldGenerateTitleFor(contextMessages);

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: generateTitle && firstUser ? firstUser.content : null,
      signal: controller.signal,
    });
    streamingState.finish();
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      return;
    }
    console.error(`[llm] Stream error:`, err);
    const mapped = mapError(err);
    streamingState.recordError(mapped.type, mapped.detail);
  } finally {
    setInterruptController(null);
  }
}
