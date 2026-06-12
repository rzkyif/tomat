// Chat orchestrator. Translates a chat.start WS frame into a streaming
// turn: build provider request, run the LLM stream, dispatch tool calls
// when the model asks for them, and emit chat.* / tool.* frames over the
// WS hub.
//
// The server owns message identity and order. Every chat-born message
// (tool_filter, reasoning, assistant, tool) is announced to the client as a
// `chat.message` birth snapshot before any `chat.delta` touches it, and the
// same TurnWriter later persists it at the turn's insertion cursor and emits
// the terminal snapshot (`final: true`). Live order and persisted order
// therefore converge by construction; the client never mints ids for these
// messages.
//
// Every settings key read below is defined in the shared schema
// (`@tomat/shared/src/domain/settings/groups/*.ts`). Defaults applied if
// absent (sparse settings.json convention).
//   llm.provider                       : "local" | "external" (endpointResolver)
//   llm.host, llm.port                 : local llama-server (endpointResolver)
//   llm.external.baseUrl/apiKey/model  : external provider (endpointResolver)
//   llm.contextSize, llm.external.contextSize : usage tracking
//   llm.reasoning                      : "off" | "on" | "auto"
//   dualModel.enabled                  : boolean (run complexity classifier)
//   dualModel.external.*               : secondary endpoint (endpointResolver)
//   prompts.defaultSystemPrompt        : string (default "")
//   prompts.complexityDetectionPrompt  : string (default constant)
//   tools.enabled                      : boolean (default false)
//   tools.maxHops                      : number (default 5)
//   tools.filteringEnabled             : boolean (default true)
//   tools.filteringMinTools            : number  (default 0, always filter)
//   tools.maxTools                     : number  (default 30, final cap)
//   tools.secondPassEnabled            : boolean (default true)
//   tools.alwaysAvailableEnabled       : boolean (default true)

import type OpenAI from "openai";
import type {
  AssistantMessage,
  ChatStartFrame,
  ErrorCode,
  Message,
  MessageContent,
  ReasoningMessage,
  ServerToClientFrame,
  Tool,
  ToolCall,
  ToolDescriptor,
  ToolFilterMessage,
  ToolMessage,
} from "@tomat/shared";
import {
  contentToText,
  DEFAULT_COMPLEXITY_DETECTION_PROMPT,
  errMessage,
  permissionKey,
} from "@tomat/shared";
import { sessionsRepo } from "./sessions-store.ts";
import { embed } from "./embedding.ts";
import { llmScheduler } from "./llm-scheduler.ts";
import {
  type LlmDelta,
  type LlmEndpointConfig,
  type LlmRequest,
  streamChatCompletion,
} from "./llm-provider.ts";
import { toolFilter } from "./tool-filter.ts";
import { maybeGenerateTitle } from "./title-gen.ts";
import { resolveEndpoint } from "./endpoint-resolver.ts";
import { loadCoreSettings } from "./core-settings.ts";
import { llmIdle } from "./llm-idle.ts";
import { toolkitsRegistry } from "../toolkits/registry.ts";
import { validateAndNormalizeToolArgs } from "../toolkits/validate-args.ts";
import { type CallController, workerPool } from "../toolkits/worker-pool.ts";
import { wsHub } from "../ws/hub.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { newCallId, newMessageId } from "../shared/ids.ts";
import { encodeBase64 } from "@std/encoding/base64";

const log = getLogger("chat");

const DEFAULT_MAX_TOOL_HOPS = 5;

interface ActiveStream {
  streamId: string;
  sessionId: string;
  clientId: string;
  abort: AbortController;
  activeToolCalls: Set<string>;
}

export class ChatService {
  private active = new Map<string, ActiveStream>();

  // Called by the WS handler when it sees a chat.start frame. Returns
  // synchronously; the streaming runs in the background and pushes frames
  // via wsHub.
  start(clientId: string, frame: ChatStartFrame): void {
    const session = sessionsRepo().getOrThrow(clientId, frame.sessionId);
    if (this.hasActiveOn(clientId, session.id)) {
      this.send(clientId, {
        kind: "chat.error",
        streamId: frame.streamId,
        code: "session_busy",
        message: "another stream is active on this session",
      });
      return;
    }
    const abort = new AbortController();
    const stream: ActiveStream = {
      streamId: frame.streamId,
      sessionId: session.id,
      clientId,
      abort,
      activeToolCalls: new Set(),
    };
    this.active.set(frame.streamId, stream);
    // Cancel any pending idle-unload as soon as a turn begins (the model is
    // about to be used). run() reloads it before scheduling if it was unloaded.
    llmIdle().noteActivity();
    void this.run(stream, frame)
      .catch((err) => {
        log.error(`stream ${frame.streamId} crashed: ${errMessage(err)}`);
        this.send(clientId, {
          kind: "chat.error",
          streamId: frame.streamId,
          code: "internal_error",
          message: errMessage(err),
        });
      })
      .finally(() => {
        this.active.delete(frame.streamId);
        // When the last turn ends, arm idle-unload (no-op unless enabled).
        llmIdle().onTurnEnd(this.active.size);
      });
  }

  // Control verbs are scoped to the owning client. Stream/call ids are
  // normally delivered only to their owner (via broadcastToClient), but enforce
  // ownership here so one paired client can never interrupt, cancel, or answer
  // an askUser prompt belonging to another client's in-flight chat/tool call.
  interrupt(streamId: string, clientId: string): void {
    const s = this.active.get(streamId);
    if (!s || s.clientId !== clientId) return;
    s.abort.abort();
  }

  forwardAskUserResponse(
    callId: string,
    requestId: string,
    answers: Array<string | string[]>,
    clientId: string,
  ): void {
    const entry = inFlightControllers.get(callId);
    if (!entry || entry.clientId !== clientId) return;
    entry.ctl.respondAskUser(requestId, answers);
  }

  forwardPermissionResponse(
    callId: string,
    requestId: string,
    allow: boolean,
    clientId: string,
  ): void {
    const entry = inFlightControllers.get(callId);
    if (!entry || entry.clientId !== clientId) return;
    entry.ctl.respondPermission(requestId, allow);
  }

  forwardCancel(callId: string, clientId: string): void {
    const entry = inFlightControllers.get(callId);
    if (!entry || entry.clientId !== clientId) return;
    entry.ctl.cancel();
  }

  /** Session ids with an in-flight turn (the model is generating, or awaiting /
   *  executing a tool). A stream stays in `active` for the whole turn and is
   *  removed in the start() `.finally`, so a session NOT in this set is idle
   *  (only waiting for user input). Used by the storage view to refuse deleting
   *  an active session. */
  activeSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.active.values()) out.add(s.sessionId);
    return out;
  }

  // --- internals --------------------------------------------------------

  private hasActiveOn(clientId: string, sessionId: string): boolean {
    for (const s of this.active.values()) {
      if (s.clientId === clientId && s.sessionId === sessionId) return true;
    }
    return false;
  }

  private send(clientId: string, frame: ServerToClientFrame): void {
    wsHub().broadcastToClient(clientId, frame);
  }

  private async run(stream: ActiveStream, frame: ChatStartFrame): Promise<void> {
    const settings = await loadCoreSettings();
    // Reload the local model if idle-unload stopped it (no-op otherwise).
    await llmIdle().ensureLoaded(settings);

    // Resolve the route: client may pin a route explicitly, otherwise run
    // the complexity classifier when dual-model is enabled.
    let route: "default" | "secondary" = frame.route ?? "default";
    if (!frame.route && boolSetting(settings, "dualModel.enabled", false)) {
      const last = lastUserText(sessionsRepo().listMessages(stream.sessionId));
      if (last) {
        try {
          route = await classifyComplexity(settings, last);
        } catch (err) {
          log.warn(`complexity classifier failed; defaulting to "default": ${errMessage(err)}`);
        }
      }
    }

    const endpoint = await resolveEndpoint(settings, route);
    const maxHops = numSetting(settings, "tools.maxHops", DEFAULT_MAX_TOOL_HOPS);
    // The client composes the effective prompt per turn (its context block
    // holds client-local facts like date/time and OS) and sends it on the
    // frame; empty string deliberately means "no system prompt". The core
    // setting is the fallback for frames that don't carry one.
    let systemPrompt =
      frame.systemPrompt !== undefined
        ? frame.systemPrompt
        : strSetting(settings, "prompts.defaultSystemPrompt", "");
    log.debug(
      `system prompt: ${systemPrompt.length} chars ` +
        `(${frame.systemPrompt !== undefined ? "from client" : "from core settings"})`,
    );

    // Resolve the turn anchor: the user message this turn hangs off. An
    // explicit anchorMessageId is a regenerate (edit-and-resend): the old
    // turn's messages are deleted server-side and the new ones are inserted
    // into its slot. Otherwise the turn anchors on the newest user message
    // and inserts at the tail.
    let history = sessionsRepo().listMessages(stream.sessionId);
    if (frame.anchorMessageId) {
      const removed = sessionsRepo().deleteTurn(stream.sessionId, frame.anchorMessageId);
      for (const id of removed) {
        this.send(stream.clientId, {
          kind: "session.updated",
          sessionId: stream.sessionId,
          op: "message_deleted",
          payload: { messageId: id },
        });
      }
      if (removed.length > 0) history = sessionsRepo().listMessages(stream.sessionId);
    }
    const anchorId = frame.anchorMessageId ?? lastUserId(history);
    // Condition the model on the anchor's turn, not anything newer: for a
    // mid-history regenerate the transcript stops at the anchor (inclusive).
    // For a fresh tail turn the anchor is the newest message, so this is a
    // no-op.
    if (anchorId) {
      const anchorIdx = history.findIndex((m) => m.id === anchorId);
      if (anchorIdx !== -1) history = history.slice(0, anchorIdx + 1);
    }
    if (frame.contextOverride) {
      history = frame.contextOverride.map(
        (m, i) =>
          ({
            id: `override-${i}`,
            ord: i,
            role: m.role as Message["role"],
            content: m.content,
            createdAtMs: Date.now(),
          }) as Message,
      );
    }
    const writer = new TurnWriter(stream, (c, f) => this.send(c, f), anchorId);

    // Tool path is gated on tools.enabled. If filtering is off, every
    // enabled tool is sent. If on, run phase 1 (cosine) and optionally
    // phase 2 (LLM relevance), then apply tools.maxTools as a final cap
    // and add always-available tools.
    let toolList: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    if (boolSetting(settings, "tools.enabled", false)) {
      // The filter bubble is born before the pipeline runs so the client can
      // show its "filtering" state, then finalized with the phases (or the
      // error) so a reload re-materializes the same bubble.
      const filterMsg: ToolFilterMessage = {
        id: newMessageId(),
        ord: -1,
        role: "tool_filter",
        status: "filtering",
        createdAtMs: Date.now(),
      };
      writer.born(filterMsg);
      try {
        const queryText = lastUserText(history);
        const allEnabled = listEnabledTools();
        const totalCount = allEnabled.length;
        const filteringEnabled = boolSetting(settings, "tools.filteringEnabled", true);
        const minToolsToFilter = numSetting(settings, "tools.filteringMinTools", 0);
        const maxTools = numSetting(settings, "tools.maxTools", 30);
        const alwaysAvailableEnabled = boolSetting(settings, "tools.alwaysAvailableEnabled", true);
        const secondPassEnabled = boolSetting(settings, "tools.secondPassEnabled", true);

        // Skip the filter entirely when disabled or when total tool count
        // is below the user's minimum threshold.
        const shouldFilter =
          filteringEnabled &&
          totalCount > 0 &&
          (minToolsToFilter === 0 || totalCount >= minToolsToFilter);

        let chosenTools: Array<{ toolId: string }>;
        let phase1Entries: ToolDescriptor[] = [];
        let phase2Entries: ToolDescriptor[] | undefined;
        let alwaysEntries: ToolDescriptor[] = [];

        if (!shouldFilter || !queryText) {
          chosenTools = allEnabled.slice(0, maxTools).map((t) => ({
            toolId: t.id,
          }));
        } else {
          const [vector] = await embed([queryText]);
          const result = toolFilter().phase1(vector, {
            topK: maxTools,
            includeAlwaysAvailable: alwaysAvailableEnabled,
          });
          phase1Entries = result.candidates;
          alwaysEntries = alwaysAvailableEnabled ? result.alwaysAvailable : [];
          let candidates = result.candidates;
          if (secondPassEnabled && candidates.length > 0) {
            const phase2Endpoint = await resolveEndpoint(settings, route);
            candidates = await toolFilter().phase2(queryText, candidates, phase2Endpoint);
            phase2Entries = candidates;
          }
          const final: Array<{ toolId: string }> = [];
          const seen = new Set<string>();
          for (const c of candidates) {
            if (final.length >= maxTools) break;
            if (seen.has(c.toolId)) continue;
            final.push({ toolId: c.toolId });
            seen.add(c.toolId);
          }
          for (const a of alwaysEntries) {
            if (seen.has(a.toolId)) continue;
            final.push({ toolId: a.toolId });
            seen.add(a.toolId);
          }
          chosenTools = final;
        }

        toolList = chosenTools
          .map((c) => toolkitsRegistry().getTool(c.toolId))
          .filter((t): t is NonNullable<typeof t> => t !== undefined)
          // Final exposure gate: the relevance filter's candidate set is not
          // grant-aware, so re-apply enabled + fully-granted here (status is
          // already gated upstream) so an ungranted tool never reaches the model.
          .filter((t) => t.enabled && toolExposable(t))
          .map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }));

        filterMsg.status = "complete";
        filterMsg.phase1 = phase1Entries.map((c) => ({
          toolId: c.toolId,
          name: c.name,
          description: c.description,
          score: c.similarity ?? 0,
        }));
        filterMsg.phase2 = phase2Entries?.map((c) => ({
          toolId: c.toolId,
          name: c.name,
          description: c.description,
        }));
        filterMsg.alwaysAvailable = alwaysEntries.map((a) => ({
          toolId: a.toolId,
          name: a.name,
          description: a.description,
        }));
        filterMsg.toolsSent = toolList.length;
        writer.finalize(filterMsg);
      } catch (err) {
        // Embedding model not present, etc. This is non-fatal; we just skip tools.
        log.warn(
          `stream ${stream.streamId}: tool filter failed, skipping tools: ${errMessage(err)}`,
        );
        filterMsg.status = "error";
        filterMsg.errorMessage = errMessage(err);
        writer.finalize(filterMsg);
      }
    }

    // The tools hint is rendered client-side (the [toolsAvailable:...]
    // segment of the context template) but belongs in the prompt only on
    // turns where the model actually gets tools, which only core knows.
    if (toolList.length > 0 && frame.toolsHint) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${frame.toolsHint}` : frame.toolsHint;
    }

    // Reading + base64-encoding image attachments is the costly part of building
    // the provider messages, and the whole transcript is rebuilt every hop.
    // Memoize each attachment's encoded form for the life of this turn so a
    // multi-hop tool conversation reads + encodes each attachment at most once.
    const attachmentCache = new Map<string, string | null>();
    // Hop loop: stream, dispatch tool calls, append tool messages, repeat.
    for (let hop = 0; hop < maxHops; hop++) {
      if (stream.abort.signal.aborted) {
        this.send(stream.clientId, {
          kind: "chat.done",
          streamId: stream.streamId,
          reason: "interrupted",
        });
        return;
      }
      const openaiMessages = await toOpenAiMessages(
        history,
        systemPrompt,
        stream.sessionId,
        attachmentCache,
      );
      const req: LlmRequest = {
        endpoint,
        messages: openaiMessages,
        tools: toolList.length > 0 ? toolList : undefined,
        signal: stream.abort.signal,
      };

      const { assistant, reasoning, toolCalls, interrupted, error } = await this.runOneTurn(
        stream,
        endpoint,
        req,
        writer,
        route,
      );
      // Reasoning was already finalized inside runOneTurn (at the first
      // content delta, or on its exit path), keeping the TurnWriter
      // invariant that reasoning persists before the assistant; here it only
      // joins the transcript. Partial messages from an interrupt or provider
      // error are finalized too (flagged `interrupted`), so streamed text is
      // never silently lost.
      if (reasoning) history.push(reasoning);
      if (assistant && (assistant.content.length > 0 || (assistant.toolCalls?.length ?? 0) > 0)) {
        writer.finalize(assistant);
        history.push(assistant);
      }
      if (interrupted) {
        this.send(stream.clientId, {
          kind: "chat.done",
          streamId: stream.streamId,
          reason: "interrupted",
        });
        return;
      }
      if (error) {
        this.send(stream.clientId, {
          kind: "chat.error",
          streamId: stream.streamId,
          code: error.code,
          message: error.message,
        });
        return;
      }
      if (toolCalls.length === 0) {
        // Natural stop.
        this.send(stream.clientId, {
          kind: "chat.done",
          streamId: stream.streamId,
          reason: "stop",
        });
        // Async: generate a title from the first turn. The service
        // self-guards if a title already exists, so calling on every
        // stop is just two DB reads in the no-op case.
        void maybeGenerateTitle(stream.sessionId, stream.clientId);
        return;
      }
      // Execute tool calls. Each call's bubble is born `running` before
      // dispatch and finalized with the outcome after, so the client sees
      // the call the moment it starts.
      for (const pending of toolCalls) {
        const toolMsg: ToolMessage = {
          id: newMessageId(),
          ord: -1,
          role: "tool",
          callId: pending.callId,
          toolkitId: pending.toolkitId,
          toolName: pending.toolName,
          arguments: pending.arguments,
          status: "running",
          createdAtMs: Date.now(),
        };
        writer.born(toolMsg);
        log.info(
          `stream ${stream.streamId}: tool call ${pending.toolkitId}/${pending.toolName} ` +
            `(${pending.callId}) starting`,
        );
        const startedAt = Date.now();
        await this.executeToolCall(stream, pending, toolMsg);
        log.info(
          `stream ${stream.streamId}: tool call ${pending.toolkitId}/${pending.toolName} ` +
            `(${pending.callId}) ${toolMsg.status} in ${Date.now() - startedAt}ms` +
            (toolMsg.error ? `: ${toolMsg.error}` : ""),
        );
        writer.finalize(toolMsg);
        history.push(toolMsg);
      }
    }
    // The conversation up to here is valid and fully persisted; reaching the
    // hop cap is a stop condition, not an error.
    this.send(stream.clientId, {
      kind: "chat.done",
      streamId: stream.streamId,
      reason: "hop_limit",
    });
  }

  private async runOneTurn(
    stream: ActiveStream,
    endpoint: LlmEndpointConfig,
    req: LlmRequest,
    writer: TurnWriter,
    route: "default" | "secondary",
  ): Promise<{
    assistant?: AssistantMessage;
    reasoning?: ReasoningMessage;
    toolCalls: ResolvedPendingCall[];
    interrupted?: boolean;
    error?: { code: ErrorCode; message: string };
  }> {
    const isLocal =
      endpoint.baseUrl.includes("127.0.0.1") || endpoint.baseUrl.includes("localhost");
    let assistantContent = "";
    let reasoning = "";
    // Skeletons born on the first delta of each kind, so the client gets a
    // server-minted id (and position) before any chat.delta arrives. The
    // returned messages are these same objects with their content filled in;
    // the caller finalizes them.
    let assistantMsg: AssistantMessage | null = null;
    let reasoningMsg: ReasoningMessage | null = null;
    // Wall-clock anchors for `reasoningDurationMs`: set on the first
    // reasoning chunk and the first content chunk respectively. The pair
    // gives "Thought for Xs" without a recompute from message timestamps.
    let reasoningStartedAtMs: number | null = null;
    let contentStartedAtMs: number | null = null;
    const toolAssemblers = new Map<
      number,
      {
        callId: string;
        toolkitId: string;
        toolName: string;
        argsBuffer: string;
      }
    >();
    let usage: { prompt: number; completion: number; total: number } | undefined;

    // Coalesce outgoing content/reasoning deltas over a short window instead of
    // one ws frame per token. A fast local model emits many small tokens; one
    // JSON.stringify + ws.send each dominates the cost and grows the send buffer
    // under a slow consumer. We still accumulate every token into the saved
    // message synchronously (below), so coalescing is lossless; only the wire
    // frames are batched. The trailing tail is flushed in `finally`.
    const COALESCE_MS = 30;
    let pendingContent = "";
    let pendingReasoning = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushDeltas = () => {
      flushTimer = undefined;
      if (pendingReasoning && reasoningMsg) {
        this.send(stream.clientId, {
          kind: "chat.delta",
          streamId: stream.streamId,
          messageId: reasoningMsg.id,
          delta: pendingReasoning,
        });
        pendingReasoning = "";
      }
      if (pendingContent && assistantMsg) {
        this.send(stream.clientId, {
          kind: "chat.delta",
          streamId: stream.streamId,
          messageId: assistantMsg.id,
          delta: pendingContent,
        });
        pendingContent = "";
      }
    };
    const scheduleFlush = () => {
      if (flushTimer === undefined) flushTimer = setTimeout(flushDeltas, COALESCE_MS);
    };
    // Reasoning is finalized HERE, not by the caller: at the first content
    // delta when the model produced a reply (so the thought bubble closes
    // with its duration while the reply still streams), otherwise on the
    // exit path. Pending deltas are flushed first so no chat.delta for the
    // id can trail its final snapshot.
    let reasoningFinalized = false;
    const finalizeReasoning = (interrupted: boolean) => {
      if (!reasoningMsg || reasoningFinalized) return;
      reasoningFinalized = true;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushDeltas();
      reasoningMsg.content = reasoning;
      const endMs = contentStartedAtMs ?? Date.now();
      reasoningMsg.reasoningDurationMs = Math.max(0, endMs - (reasoningStartedAtMs ?? endMs));
      reasoningMsg.pairedAssistantId = assistantMsg?.id;
      if (interrupted) reasoningMsg.interrupted = true;
      writer.finalize(reasoningMsg);
    };
    // Fills the streamed text into the skeletons. Called on every exit path
    // so a partial (interrupted / errored) message is returned for
    // finalization rather than dropped.
    const settleMessages = (interrupted: boolean) => {
      finalizeReasoning(interrupted);
      if (assistantMsg) {
        assistantMsg.content = assistantContent;
        if (interrupted) assistantMsg.interrupted = true;
      }
    };

    const llmStartedAt = Date.now();
    log.info(
      `stream ${stream.streamId}: llm call starting ` +
        `(${isLocal ? "local" : "external"} model ${endpoint.model}, route ${route}, ` +
        `${req.messages.length} messages${req.tools?.length ? `, ${req.tools.length} tools` : ""})`,
    );
    // Completion summary shared by the success and interrupt exits. Token
    // counts come from the stream's usage chunk; absent (interrupt, provider
    // without usage support) we still report the wall-clock time.
    const llmDoneLine = (note: string) => {
      const elapsedMs = Date.now() - llmStartedAt;
      let tokens = "";
      if (usage) {
        const rate = elapsedMs > 0 ? ((usage.completion / elapsedMs) * 1000).toFixed(1) : "?";
        tokens = ` (${usage.prompt} prompt + ${usage.completion} completion tokens, ${rate} token/s)`;
      }
      return `stream ${stream.streamId}: llm call ${note} in ${elapsedMs}ms${tokens}`;
    };

    try {
      for await (const delta of llmScheduler().schedule(req, {
        clientId: stream.clientId,
        isLocal,
      })) {
        this.handleDelta(stream, delta, {
          appendContent: (s) => {
            if (contentStartedAtMs === null) {
              contentStartedAtMs = Date.now();
              assistantMsg = {
                id: newMessageId(),
                ord: -1,
                role: "assistant",
                content: "",
                createdAtMs: Date.now(),
                modelUsed: route,
              };
              writer.born(assistantMsg);
              finalizeReasoning(false);
            }
            assistantContent += s;
            pendingContent += s;
            scheduleFlush();
          },
          appendReasoning: (s) => {
            // Interleaving rule: reasoning deltas arriving after the first
            // content delta are dropped; the thought bubble is closed once
            // the reply starts.
            if (contentStartedAtMs !== null) return;
            if (reasoningStartedAtMs === null) {
              reasoningStartedAtMs = Date.now();
              reasoningMsg = {
                id: newMessageId(),
                ord: -1,
                role: "reasoning",
                content: "",
                createdAtMs: Date.now(),
                modelUsed: route,
              };
              writer.born(reasoningMsg);
            }
            reasoning += s;
            pendingReasoning += s;
            scheduleFlush();
          },
          updateToolCall: (idx, chunk) => {
            let asm = toolAssemblers.get(idx);
            if (!asm) {
              asm = {
                callId: chunk.id ?? newCallId(),
                toolkitId: "",
                toolName: chunk.name ?? "",
                argsBuffer: "",
              };
              toolAssemblers.set(idx, asm);
            } else if (chunk.name) {
              asm.toolName = chunk.name;
            }
            if (chunk.id) asm.callId = chunk.id;
            if (chunk.argumentsDelta) asm.argsBuffer += chunk.argumentsDelta;
          },
          captureUsage: (u) => {
            usage = u;
          },
        });
      }
    } catch (err) {
      // User interrupt: not an error. Partial messages are returned flagged
      // `interrupted` so the caller finalizes them and live === reload.
      if (stream.abort.signal.aborted) {
        log.info(llmDoneLine("interrupted"));
        settleMessages(true);
        return {
          assistant: assistantMsg ?? undefined,
          reasoning: reasoningMsg ?? undefined,
          toolCalls: [],
          interrupted: true,
        };
      }
      settleMessages(true);
      const classified =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : classifyProviderError(err);
      log.error(
        `stream ${stream.streamId}: llm call failed (${classified.code}): ${classified.message}`,
      );
      return {
        assistant: assistantMsg ?? undefined,
        reasoning: reasoningMsg ?? undefined,
        toolCalls: [],
        error: classified,
      };
    } finally {
      // Flush any buffered tail on both the success and error paths (runs before
      // the catch's `return` completes), so trailing tokens are never dropped.
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushDeltas();
    }
    // A user interrupt usually lands here, not in the catch: the OpenAI SDK
    // swallows the AbortError and simply ends the iteration.
    if (stream.abort.signal.aborted) {
      log.info(llmDoneLine("interrupted"));
      settleMessages(true);
      return {
        assistant: assistantMsg ?? undefined,
        reasoning: reasoningMsg ?? undefined,
        toolCalls: [],
        interrupted: true,
      };
    }
    // Resolve tool names to (toolkitId, name) pairs.
    const allEnabled = enabledToolsByName();
    const resolved: ResolvedPendingCall[] = [];
    for (const asm of toolAssemblers.values()) {
      const found = allEnabled.get(asm.toolName);
      if (!found) {
        // Tool not found / disabled / grants missing. Emit error msg for the
        // model on next hop.
        resolved.push({
          callId: asm.callId,
          toolkitId: "unknown",
          toolName: asm.toolName,
          arguments: asm.argsBuffer || "{}",
          unknown: true,
        });
        continue;
      }
      resolved.push({
        callId: asm.callId,
        toolkitId: found.toolkitId,
        toolName: asm.toolName,
        arguments: asm.argsBuffer || "{}",
      });
    }

    // A tool-call-only turn (no content) still needs an assistant message:
    // the persisted toolCalls are what lets a later transcript rebuild
    // replay the model's tool_calls. It was never born (no content deltas),
    // so its first chat.message emission is the finalization.
    if (!assistantMsg && resolved.length > 0) {
      assistantMsg = {
        id: newMessageId(),
        ord: -1,
        role: "assistant",
        content: "",
        createdAtMs: Date.now(),
        modelUsed: route,
      };
    }
    if (assistantMsg && resolved.length > 0) {
      assistantMsg.toolCalls = resolved.map<ToolCall>((r) => ({
        callId: r.callId,
        toolkitId: r.toolkitId,
        toolName: r.toolName,
        arguments: r.arguments,
        status: "pending",
      }));
    }
    settleMessages(false);
    log.info(llmDoneLine("done"));
    if (usage) {
      this.send(stream.clientId, {
        kind: "chat.usage",
        streamId: stream.streamId,
        tokenUsage: usage,
      });
      sessionsRepo().setTokenUsage(stream.sessionId, usage);
    }

    return {
      assistant: assistantMsg ?? undefined,
      reasoning: reasoningMsg ?? undefined,
      toolCalls: resolved,
    };
  }

  private handleDelta(
    stream: ActiveStream,
    delta: LlmDelta,
    sink: {
      appendContent: (s: string) => void;
      appendReasoning: (s: string) => void;
      updateToolCall: (
        idx: number,
        chunk: {
          id?: string;
          name?: string;
          argumentsDelta?: string;
        },
      ) => void;
      captureUsage: (u: { prompt: number; completion: number; total: number }) => void;
    },
  ): void {
    void stream;
    if (delta.contentDelta) sink.appendContent(delta.contentDelta);
    if (delta.reasoningDelta) sink.appendReasoning(delta.reasoningDelta);
    if (delta.toolCalls) {
      for (const tc of delta.toolCalls) {
        sink.updateToolCall(tc.index, {
          id: tc.id,
          name: tc.name,
          argumentsDelta: tc.argumentsDelta,
        });
      }
    }
    if (delta.usage) sink.captureUsage(delta.usage);
  }

  // Runs one tool call and fills the outcome into `msg` (the message the
  // caller already announced as born); the caller finalizes it afterwards.
  private async executeToolCall(
    stream: ActiveStream,
    pending: ResolvedPendingCall,
    msg: ToolMessage,
  ): Promise<void> {
    if (pending.unknown) {
      msg.status = "failed";
      msg.error = `tool ${pending.toolName} not available`;
      return;
    }
    const tool = toolkitsRegistry().getTool(`${pending.toolkitId}::${pending.toolName}`);
    if (!tool) {
      msg.status = "failed";
      msg.error = "tool not found";
      return;
    }
    // Pre-flight before dispatch: (1) re-verify the toolkit's content hash so a
    // toolkit tampered since boot can't execute; (2) validate the model-emitted
    // arguments against the tool's declared schema and fill defaults, so the
    // worker receives normalized args (not raw model output).
    let normalizedArgs: string;
    try {
      await toolkitsRegistry().verifyHashFresh(pending.toolkitId);
      normalizedArgs = validateAndNormalizeToolArgs(tool, pending.arguments);
    } catch (err) {
      const errMsg = errMessage(err);
      this.send(stream.clientId, { kind: "tool.error", callId: pending.callId, error: errMsg });
      msg.status = "failed";
      msg.error = errMsg;
      return;
    }
    const ctl = workerPool().startCall(
      {
        toolkitId: pending.toolkitId,
        tool,
        required: tool.requiredPermissions,
        argumentsJson: normalizedArgs,
        chatContext: {
          userMessage: lastUserText(sessionsRepo().listMessages(stream.sessionId)) ?? "",
          sessionId: stream.sessionId,
          locale: undefined,
        },
      },
      (event) => {
        if (event.kind === "progress") {
          // Persist the tool's latest wording + progress on the message so
          // the reloaded bubble keeps them.
          if (event.label !== undefined) msg.label = event.label;
          if (event.description !== undefined) msg.description = event.description;
          msg.progress = event.progress;
          this.send(stream.clientId, {
            kind: "tool.progress",
            callId: pending.callId,
            progress: event.progress,
            label: event.label,
            description: event.description,
          });
        } else if (event.kind === "ask_user_request") {
          this.send(stream.clientId, {
            kind: "tool.askuser_request",
            callId: pending.callId,
            requestId: event.requestId,
            questions: event.questions,
          });
        } else if (event.kind === "permission_request") {
          this.send(stream.clientId, {
            kind: "tool.permission_request",
            callId: pending.callId,
            requestId: event.requestId,
            permissionKind: event.permission,
            resource: event.resource,
            apiName: event.apiName,
            declared: event.declared,
            reason: event.reason,
            toolkitId: pending.toolkitId,
            toolName: pending.toolName,
          });
        } else if (event.kind === "log") {
          this.send(stream.clientId, {
            kind: "tool.log",
            callId: pending.callId,
            level: event.level,
            message: event.message,
          });
        } else if (event.kind === "tool_cancelled") {
          this.send(stream.clientId, {
            kind: "tool.cancelled",
            callId: pending.callId,
          });
        }
      },
    );
    inFlightControllers.set(pending.callId, {
      clientId: stream.clientId,
      ctl,
    });
    try {
      const result = await ctl.done;
      this.send(stream.clientId, {
        kind: "tool.result",
        callId: pending.callId,
        result,
      });
      msg.status = "completed";
      msg.result = result;
    } catch (err) {
      const errMsg = errMessage(err);
      this.send(stream.clientId, {
        kind: "tool.error",
        callId: pending.callId,
        error: errMsg,
      });
      msg.status = "failed";
      msg.error = errMsg;
    } finally {
      inFlightControllers.delete(pending.callId);
    }
  }
}

let _instance: ChatService | null = null;
export function chatService(): ChatService {
  if (!_instance) _instance = new ChatService();
  return _instance;
}

// Test-only: drops the cached instance and clears the in-flight controllers
// map so the next `chatService()` call rebuilds against fresh deps.
export function __resetForTesting(): void {
  _instance = null;
  inFlightControllers.clear();
}

// In-flight controllers shared between the chat service (creator) and
// the ws handlers (which forward tool.askuser_response and tool.cancel).
const inFlightControllers = new Map<string, { clientId: string; ctl: CallController }>();

interface ResolvedPendingCall {
  callId: string;
  toolkitId: string;
  toolName: string;
  arguments: string;
  unknown?: boolean;
}

// Owns one turn's message announcements and persistence. `born` announces a
// message to the client (chat.message, final: false) at the live insertion
// position; `finalize` persists it at the durable insertion cursor and emits
// the terminal snapshot. The two cursors only differ while messages of the
// same hop are live concurrently (reasoning + assistant), and converge
// because finalization happens in birth order (reasoning before assistant).
class TurnWriter {
  // Last persisted id; where the next finalize inserts.
  private cursor: string | null;
  // Last announced id (born or first-emission finalize); where the next
  // birth points its afterId.
  private liveCursor: string | null;
  private bornIds = new Set<string>();

  constructor(
    private readonly stream: ActiveStream,
    private readonly send: (clientId: string, frame: ServerToClientFrame) => void,
    anchorId: string | null,
  ) {
    this.cursor = anchorId;
    this.liveCursor = anchorId;
  }

  born(message: Message): void {
    this.send(this.stream.clientId, {
      kind: "chat.message",
      streamId: this.stream.streamId,
      sessionId: this.stream.sessionId,
      message,
      afterId: this.liveCursor,
      final: false,
    });
    this.bornIds.add(message.id);
    this.liveCursor = message.id;
  }

  finalize(message: Message): void {
    // A message finalized without a prior birth (e.g. a tool-call-only
    // assistant that never streamed content) is positioned by this frame,
    // so it carries the live cursor as its afterId.
    const firstEmission = !this.bornIds.has(message.id);
    const { ord } = sessionsRepo().insertMessageAfter(this.stream.sessionId, message, this.cursor);
    message.ord = ord;
    this.cursor = message.id;
    this.send(this.stream.clientId, {
      kind: "chat.message",
      streamId: this.stream.streamId,
      sessionId: this.stream.sessionId,
      message,
      afterId: firstEmission ? this.liveCursor : null,
      final: true,
    });
    if (firstEmission) this.liveCursor = message.id;
  }
}

// --- helpers --------------------------------------------------------------

function lastUserText(history: Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") return contentToText(m.content);
  }
  return undefined;
}

function lastUserId(history: Message[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].id;
  }
  return null;
}

async function toOpenAiMessages(
  history: Message[],
  systemPrompt: string,
  sessionId: string,
  attachmentCache?: Map<string, string | null>,
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of history) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: await userContentToOpenAi(m.content, sessionId, attachmentCache),
      });
    } else if (m.role === "assistant") {
      // Assistant content is always a plain string in this codebase (no
      // multipart support needed at the model boundary). Tool calls the
      // model emitted MUST be replayed on the message: the `role: "tool"`
      // results that follow reference them by id, and an undeclared
      // tool_call_id renders as an orphaned tool response in the chat
      // template, garbling every hop after a call.
      const text = typeof m.content === "string" ? m.content : contentToText(m.content);
      const calls = (m as AssistantMessage).toolCalls;
      const param: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text,
      };
      if (calls && calls.length > 0) {
        param.tool_calls = calls.map((tc) => ({
          id: tc.callId,
          type: "function" as const,
          function: { name: tc.toolName, arguments: tc.arguments },
        }));
      }
      out.push(param);
    } else if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : contentToText(m.content);
      out.push({ role: "system", content: text });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.callId,
        content:
          m.status === "completed" ? JSON.stringify(m.result) : JSON.stringify({ error: m.error }),
      });
    } else if (m.role === "reasoning") {
      // Reasoning trace is not part of the OpenAI message protocol; omit.
    }
    // tool_filter / error messages are not sent to the LLM.
  }
  return out;
}

// Multipart user content → OpenAI ChatCompletionContentPart[]. `image_file`
// parts load the bytes from disk and inline them as a data URI so the model
// receives the actual image; `document_file` reads the file (the client
// always converts non-image attachments to markdown before upload) and
// inlines the text with an "[Attached document: filename]" header so the
// model knows the boundary. Falls back to a string when the content is just
// text, which keeps the wire payload small for the common no-attachment case.
async function userContentToOpenAi(
  content: MessageContent,
  sessionId: string,
  attachmentCache?: Map<string, string | null>,
): Promise<string | OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
  if (typeof content === "string") return content;
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
    } else if (p.type === "image_file") {
      const dataUrl = await readAttachmentAsDataUrl(
        sessionId,
        p.path,
        p.mime || "image/png",
        attachmentCache,
      );
      if (dataUrl) {
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
      }
    } else if (p.type === "document") {
      parts.push({
        type: "text",
        text: `[Attached document: ${p.filename}]\n\n${p.markdown}`,
      });
    } else if (p.type === "document_file") {
      const text = await readAttachmentAsText(sessionId, p.path, attachmentCache);
      if (text !== null) {
        parts.push({
          type: "text",
          text: `[Attached document: ${p.filename}]\n\n${text}`,
        });
      }
    }
  }
  // Collapse to a plain string when every part is text, because some providers
  // reject a `content: [{type: "text", ...}]` shape that has no image_url siblings.
  if (parts.every((p) => p.type === "text")) {
    return parts
      .filter((p): p is OpenAI.Chat.Completions.ChatCompletionContentPartText => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return parts;
}

// Pull the trailing attachment id out of the URL the client stored on the
// MessagePart (the path field is `<baseUrl>/api/v1/sessions/<sid>/attachments/<aid>`).
// Returns null if the URL doesn't match. We just skip the attachment in that
// case rather than failing the whole turn.
function attachmentIdFromPath(path: string): string | null {
  const m = path.match(/\/attachments\/([^/?#]+)$/);
  return m ? m[1] : null;
}

async function readAttachmentAsDataUrl(
  sessionId: string,
  path: string,
  mime: string,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  const id = attachmentIdFromPath(path);
  if (!id) return null;
  const cacheKey = `img:${id}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;
  let result: string | null = null;
  try {
    const rec = sessionsRepo().getAttachment(sessionId, id);
    const bytes = await Deno.readFile(rec.absPath);
    // encodeBase64 over the Uint8Array directly, instead of an O(n) per-byte
    // String.fromCharCode loop that builds a giant intermediate binary string
    // on the event loop for every multi-MB image.
    result = `data:${rec.mime ?? mime};base64,${encodeBase64(bytes)}`;
  } catch (err) {
    log.warn(`image attachment load failed (${path}): ${errMessage(err)}`);
    result = null;
  }
  cache?.set(cacheKey, result);
  return result;
}

async function readAttachmentAsText(
  sessionId: string,
  path: string,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  const id = attachmentIdFromPath(path);
  if (!id) return null;
  const cacheKey = `doc:${id}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;
  let result: string | null = null;
  try {
    const rec = sessionsRepo().getAttachment(sessionId, id);
    result = await Deno.readTextFile(rec.absPath);
  } catch (err) {
    log.warn(`document attachment load failed (${path}): ${errMessage(err)}`);
    result = null;
  }
  cache?.set(cacheKey, result);
  return result;
}

// LLM-exposure gate: a tool reaches the model only when its toolkit is
// 'installed' (not 'downloaded'/'drift'), the tool is enabled, AND no
// non-optional required permission is denied. A permission without a grant
// row behaves as 'ask': the tool runs and Deno prompts at the moment of
// access, so only an explicit denial withholds the tool here.
function toolExposable(t: Tool): boolean {
  const denied = new Set(t.grants.filter((g) => g.state === "denied").map((g) => g.permissionKey));
  return t.requiredPermissions.every((d) => d.optional || !denied.has(permissionKey(d)));
}

function enabledToolsByName(): Map<string, { toolkitId: string; toolId: string }> {
  const out = new Map<string, { toolkitId: string; toolId: string }>();
  for (const tk of toolkitsRegistry().list()) {
    if (tk.status !== "installed") continue;
    for (const t of toolkitsRegistry().listTools(tk.id)) {
      if (t.enabled && toolExposable(t)) out.set(t.name, { toolkitId: tk.id, toolId: t.id });
    }
  }
  return out;
}

function listEnabledTools(): Tool[] {
  const out: Tool[] = [];
  for (const tk of toolkitsRegistry().list()) {
    if (tk.status !== "installed") continue;
    for (const t of toolkitsRegistry().listTools(tk.id)) {
      if (t.enabled && toolExposable(t)) out.push(t);
    }
  }
  return out;
}

function classifyProviderError(err: unknown): { code: ErrorCode; message: string } {
  const msg = errMessage(err);
  // The OpenAI SDK throws APIError with `status` + `code`; also surfaces
  // human-readable messages we can pattern-match. Try the structured
  // fields first, then fall back to message regex.
  const status =
    (err as { status?: number; statusCode?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  const code =
    (err as { code?: string; error?: { code?: string } } | null)?.code ??
    (err as { error?: { code?: string } } | null)?.error?.code;

  if (status === 401 || code === "invalid_api_key") {
    return { code: "provider_unauthorized", message: msg };
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return { code: "provider_rate_limited", message: msg };
  }
  if (status === 503 || status === 504) {
    return { code: "server_unavailable", message: msg };
  }
  if (
    code === "context_length_exceeded" ||
    /context length|maximum context length|context window/i.test(msg)
  ) {
    return { code: "context_window_exceeded", message: msg };
  }
  return { code: "provider_error", message: msg };
}

async function classifyComplexity(
  settings: Record<string, unknown>,
  userMessage: string,
): Promise<"default" | "secondary"> {
  // Single-shot LLM classifier. Asks the DEFAULT model to label the user's
  // request as "simple" or "complex"; routes complex requests to the
  // configured secondary endpoint. Ambiguous or empty replies fall back to
  // the default model.
  const systemPrompt = strSetting(
    settings,
    "prompts.complexityDetectionPrompt",
    DEFAULT_COMPLEXITY_DETECTION_PROMPT,
  );
  const endpoint = await resolveEndpoint(settings, "default");
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  let response = "";
  for await (const delta of streamChatCompletion({
    endpoint,
    messages,
    overrides: { temperature: 0, maxTokens: 16 },
  })) {
    if (delta.contentDelta) response += delta.contentDelta;
  }
  const text = response.toLowerCase();
  if (text.includes("complex") && !text.includes("simple")) return "secondary";
  return "default";
}

function strSetting(s: Record<string, unknown>, key: string, def: string): string {
  const v = s[key];
  return typeof v === "string" ? v : def;
}
function numSetting(s: Record<string, unknown>, key: string, def: number): number {
  const v = s[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}
function boolSetting(s: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = s[key];
  return typeof v === "boolean" ? v : def;
}
