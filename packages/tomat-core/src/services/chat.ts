// Chat orchestrator. Translates a chat.start WS frame into a streaming
// turn: build provider request, run the LLM stream, dispatch tool calls
// when the model asks for them, persist every assistant / reasoning / tool
// message as the stream progresses, and emit chat.* / session.updated /
// tool.* frames over the WS hub.
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
  PendingToolCall,
  ReasoningMessage,
  ServerToClientFrame,
  Tool,
  ToolCall,
  ToolDescriptor,
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
    const systemPrompt = strSetting(settings, "prompts.defaultSystemPrompt", "");

    // Build the initial message transcript from the persisted session (the
    // override path is for one-shot completions outside the persisted flow).
    let history = sessionsRepo().listMessages(stream.sessionId);
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

    // Tool path is gated on tools.enabled. If filtering is off, every
    // enabled tool is sent. If on, run phase 1 (cosine) and optionally
    // phase 2 (LLM relevance), then apply tools.maxTools as a final cap
    // and add always-available tools.
    let toolList: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    if (boolSetting(settings, "tools.enabled", false)) {
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
          .filter((t) => t.enabled && toolFullyGranted(t))
          .map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }));

        // Surface filter metadata to the client (preserves old UI's
        // RelevantTools bubble with cosine scores + descriptions) AND
        // persist a tool_filter message so a session reload re-materializes
        // the same bubble.
        const phase1Persisted = phase1Entries.map((c) => ({
          toolId: c.toolId,
          name: c.name,
          description: c.description,
          score: c.similarity ?? 0,
        }));
        const phase2Persisted = phase2Entries?.map((c) => ({
          toolId: c.toolId,
          name: c.name,
          description: c.description,
        }));
        const alwaysPersisted = alwaysEntries.map((a) => ({
          toolId: a.toolId,
          name: a.name,
          description: a.description,
        }));
        this.send(stream.clientId, {
          kind: "chat.toolfilter",
          streamId: stream.streamId,
          status: "complete",
          phase1: phase1Persisted,
          phase2: phase2Persisted,
          alwaysAvailable: alwaysPersisted,
        });
        const filterMsg: Message = {
          id: newMessageId(),
          ord: -1,
          role: "tool_filter",
          status: "complete",
          phase1: phase1Persisted,
          phase2: phase2Persisted,
          alwaysAvailable: alwaysPersisted,
          createdAtMs: Date.now(),
        };
        sessionsRepo().appendMessage(stream.sessionId, filterMsg);
        this.send(stream.clientId, {
          kind: "session.updated",
          sessionId: stream.sessionId,
          op: "message_added",
          payload: { messageId: filterMsg.id, message: filterMsg },
        });
      } catch (err) {
        // Embedding model not present, etc. This is non-fatal; we just skip tools.
        this.send(stream.clientId, {
          kind: "chat.toolfilter",
          streamId: stream.streamId,
          status: "error",
          errorMessage: errMessage(err),
        });
      }
    }

    // Reading + base64-encoding image attachments is the costly part of building
    // the provider messages, and the whole transcript is rebuilt every hop.
    // Memoize each attachment's encoded form for the life of this turn so a
    // multi-hop tool conversation reads + encodes each attachment at most once.
    const attachmentCache = new Map<string, string | null>();
    // Hop loop: stream, dispatch tool calls, append tool messages, repeat.
    for (let hop = 0; hop < maxHops; hop++) {
      if (stream.abort.signal.aborted) return;
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

      const { assistant, reasoning, toolCalls, error } = await this.runOneTurn(
        stream,
        endpoint,
        req,
      );
      if (error) {
        this.send(stream.clientId, {
          kind: "chat.error",
          streamId: stream.streamId,
          code: error.code,
          message: error.message,
        });
        return;
      }
      // Reasoning ordering: the bubble belongs visually BEFORE the assistant
      // turn it belongs to. Persisting it first preserves that order under
      // any future replay-from-history path.
      if (reasoning) {
        reasoning.pairedAssistantId = assistant?.id;
        reasoning.modelUsed = route;
        sessionsRepo().appendMessage(stream.sessionId, reasoning);
        this.send(stream.clientId, {
          kind: "session.updated",
          sessionId: stream.sessionId,
          op: "message_added",
          payload: { messageId: reasoning.id, message: reasoning },
        });
        history.push(reasoning);
      }
      if (assistant) {
        assistant.modelUsed = route;
        sessionsRepo().appendMessage(stream.sessionId, assistant);
        this.send(stream.clientId, {
          kind: "session.updated",
          sessionId: stream.sessionId,
          op: "message_added",
          payload: { messageId: assistant.id, message: assistant },
        });
        history.push(assistant);
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
      // Execute tool calls. Tools are addressable by their `name` on the
      // currently-enabled tool list; resolve to the {toolkitId, tool} pair.
      this.send(stream.clientId, {
        kind: "chat.toolcall_requested",
        streamId: stream.streamId,
        calls: toolCalls.map((tc) => ({
          callId: tc.callId,
          toolkitId: tc.toolkitId,
          toolName: tc.toolName,
          arguments: tc.arguments,
        })),
      });
      for (const pending of toolCalls) {
        const toolMsg = await this.executeToolCall(stream, pending);
        sessionsRepo().appendMessage(stream.sessionId, toolMsg);
        this.send(stream.clientId, {
          kind: "session.updated",
          sessionId: stream.sessionId,
          op: "message_added",
          payload: { messageId: toolMsg.id, message: toolMsg },
        });
        history.push(toolMsg);
      }
    }
    this.send(stream.clientId, {
      kind: "chat.error",
      streamId: stream.streamId,
      code: "internal_error",
      message: `tool-call hop limit (${maxHops}) reached`,
    });
  }

  private async runOneTurn(
    stream: ActiveStream,
    endpoint: LlmEndpointConfig,
    req: LlmRequest,
  ): Promise<{
    assistant?: AssistantMessage;
    reasoning?: ReasoningMessage;
    toolCalls: ResolvedPendingCall[];
    error?: { code: ErrorCode; message: string };
  }> {
    const isLocal =
      endpoint.baseUrl.includes("127.0.0.1") || endpoint.baseUrl.includes("localhost");
    let assistantContent = "";
    let reasoning = "";
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
      if (pendingContent) {
        this.send(stream.clientId, {
          kind: "chat.chunk",
          streamId: stream.streamId,
          contentDelta: pendingContent,
        });
        pendingContent = "";
      }
      if (pendingReasoning) {
        this.send(stream.clientId, {
          kind: "chat.chunk",
          streamId: stream.streamId,
          reasoningDelta: pendingReasoning,
        });
        pendingReasoning = "";
      }
    };
    const scheduleFlush = () => {
      if (flushTimer === undefined) flushTimer = setTimeout(flushDeltas, COALESCE_MS);
    };

    try {
      for await (const delta of llmScheduler().schedule(req, {
        clientId: stream.clientId,
        isLocal,
      })) {
        this.handleDelta(stream, delta, {
          appendContent: (s) => {
            if (contentStartedAtMs === null) contentStartedAtMs = Date.now();
            assistantContent += s;
            pendingContent += s;
            scheduleFlush();
          },
          appendReasoning: (s) => {
            if (reasoningStartedAtMs === null) {
              reasoningStartedAtMs = Date.now();
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
      if (err instanceof AppError) {
        return {
          toolCalls: [],
          error: { code: err.code, message: err.message },
        };
      }
      return {
        toolCalls: [],
        error: classifyProviderError(err),
      };
    } finally {
      // Flush any buffered tail on both the success and error paths (runs before
      // the catch's `return` completes), so trailing tokens are never dropped.
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushDeltas();
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

    const assistant: AssistantMessage = {
      id: newMessageId(),
      ord: -1, // assigned at append time
      role: "assistant",
      content: assistantContent,
      createdAtMs: Date.now(),
      toolCalls:
        resolved.length > 0
          ? resolved.map<ToolCall>((r) => ({
              callId: r.callId,
              toolkitId: r.toolkitId,
              toolName: r.toolName,
              arguments: r.arguments,
              status: "pending",
            }))
          : undefined,
    };
    if (usage) {
      this.send(stream.clientId, {
        kind: "chat.usage",
        streamId: stream.streamId,
        tokenUsage: usage,
      });
      sessionsRepo().setTokenUsage(stream.sessionId, usage);
    }

    // Build the reasoning message only if the model emitted any. Duration
    // is the wall-clock between first reasoning chunk and first content
    // chunk; if the model never produced content, treat now as the end.
    let reasoningMsg: ReasoningMessage | undefined;
    if (reasoning.length > 0 && reasoningStartedAtMs !== null) {
      const endMs = contentStartedAtMs ?? Date.now();
      reasoningMsg = {
        id: newMessageId(),
        ord: -1,
        role: "reasoning",
        content: reasoning,
        createdAtMs: reasoningStartedAtMs,
        reasoningDurationMs: Math.max(0, endMs - reasoningStartedAtMs),
        pairedAssistantId: assistant.id,
      };
    }

    return { assistant, reasoning: reasoningMsg, toolCalls: resolved };
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

  private async executeToolCall(
    stream: ActiveStream,
    pending: ResolvedPendingCall,
  ): Promise<ToolMessage> {
    if (pending.unknown) {
      return {
        id: newMessageId(),
        ord: -1,
        role: "tool",
        callId: pending.callId,
        toolkitId: pending.toolkitId,
        toolName: pending.toolName,
        status: "failed",
        error: `tool ${pending.toolName} not available`,
        createdAtMs: Date.now(),
      };
    }
    const tool = toolkitsRegistry().getTool(`${pending.toolkitId}::${pending.toolName}`);
    if (!tool) {
      return {
        id: newMessageId(),
        ord: -1,
        role: "tool",
        callId: pending.callId,
        toolkitId: pending.toolkitId,
        toolName: pending.toolName,
        status: "failed",
        error: "tool not found",
        createdAtMs: Date.now(),
      };
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
      const msg = errMessage(err);
      this.send(stream.clientId, { kind: "tool.error", callId: pending.callId, error: msg });
      return {
        id: newMessageId(),
        ord: -1,
        role: "tool",
        callId: pending.callId,
        toolkitId: pending.toolkitId,
        toolName: pending.toolName,
        status: "failed",
        error: msg,
        createdAtMs: Date.now(),
      };
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
      return {
        id: newMessageId(),
        ord: -1,
        role: "tool",
        callId: pending.callId,
        toolkitId: pending.toolkitId,
        toolName: pending.toolName,
        status: "completed",
        result,
        createdAtMs: Date.now(),
      };
    } catch (err) {
      const msg = errMessage(err);
      this.send(stream.clientId, {
        kind: "tool.error",
        callId: pending.callId,
        error: msg,
      });
      return {
        id: newMessageId(),
        ord: -1,
        role: "tool",
        callId: pending.callId,
        toolkitId: pending.toolkitId,
        toolName: pending.toolName,
        status: "failed",
        error: msg,
        createdAtMs: Date.now(),
      };
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

interface ResolvedPendingCall extends PendingToolCall {
  unknown?: boolean;
}

// --- helpers --------------------------------------------------------------

function lastUserText(history: Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") return contentToText(m.content);
  }
  return undefined;
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
    } else if (m.role === "system" || m.role === "assistant") {
      // System + assistant are always plain string in this codebase (no
      // multipart support needed at the model boundary).
      const text = typeof m.content === "string" ? m.content : contentToText(m.content);
      out.push({ role: m.role, content: text });
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
// 'installed' (not 'downloaded'/'drift'), the tool is enabled, AND every
// non-optional required permission is granted. An enabled-but-ungranted tool is
// in the UI "warning" state and is intentionally withheld here.
function toolFullyGranted(t: Tool): boolean {
  const granted = new Set(
    t.grants.filter((g) => g.state === "granted").map((g) => g.permissionKey),
  );
  return t.requiredPermissions.every((d) => d.optional || granted.has(permissionKey(d)));
}

function enabledToolsByName(): Map<string, { toolkitId: string; toolId: string }> {
  const out = new Map<string, { toolkitId: string; toolId: string }>();
  for (const tk of toolkitsRegistry().list()) {
    if (tk.status !== "installed") continue;
    for (const t of toolkitsRegistry().listTools(tk.id)) {
      if (t.enabled && toolFullyGranted(t)) out.set(t.name, { toolkitId: tk.id, toolId: t.id });
    }
  }
  return out;
}

function listEnabledTools(): Tool[] {
  const out: Tool[] = [];
  for (const tk of toolkitsRegistry().list()) {
    if (tk.status !== "installed") continue;
    for (const t of toolkitsRegistry().listTools(tk.id)) {
      if (t.enabled && toolFullyGranted(t)) out.push(t);
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
