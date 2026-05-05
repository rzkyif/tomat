/**
 * The active conversation's messages array and the structural mutations on
 * it (add, edit, delete, regenerate, plus tool / tool_filter / system bubble
 * helpers). Sister slices own the rest:
 *
 *   - sessionsState: session list + active id + title + load/new/delete
 *   - persistenceState: debounced save + beforeunload flush + attachment GC
 *   - streamingState: live LLM stream flags + buffered chunks + TTS feed +
 *     interruptStreaming orchestration
 *
 * Consumers should reach for the slice that owns what they need; this file
 * doesn't re-export anything by way of forwarders.
 */

import {
  getTextContent,
  makeMessageId,
  type AskUserAnswer,
  type AskUserQuestion,
  type Attachment,
  type Message,
  type MessageContent,
  type MessagePart,
  type RelevantToolsState,
  type TokenUsage,
  type ToolCallLogLine,
  type ToolCallState,
  type ToolCallStatus,
} from "$lib/shared/types";
import { persistenceState } from "./persistence.svelte";
import { sessionsState } from "./sessions.svelte";
import { settingsState } from "./settings.svelte";
import { snippetsState } from "./snippets.svelte";
import { streamingState } from "./streaming.svelte";
import {
  ensureMarkdownExtension,
  imageExtFromMime,
  utf8ToBase64,
  writeSessionAttachment,
} from "$lib/shared/attachments";
import { applySnippets } from "$lib/shared/snippets";
import {
  applySystemPromptOverride,
  buildContextBlock,
  buildSystemPrompt,
  buildSystemPromptBase,
} from "$lib/shared/systemPrompt";

type SendMessagesHandler = () => Promise<void>;
type ReprocessMessageHandler = (messageId: string) => Promise<void>;

class MessagesState {
  messages = $state<Message[]>([]);
  tokenUsage = $state<TokenUsage | null>(null);

  /** Any tool call bubble currently in a non-terminal state. Drives the
   *  unified "interrupt" affordance in UserInput so tool calls can be stopped
   *  the same way an LLM stream can. */
  hasActiveToolCall = $derived(
    this.messages.some(
      (m) =>
        !!m.toolCall &&
        (m.toolCall.status === "pending" ||
          m.toolCall.status === "running" ||
          m.toolCall.status === "awaiting_user"),
    ),
  );

  // The LLM dispatch needs to be invoked from this slice but lives in a
  // module that imports messagesState itself, so registering callbacks here
  // keeps the static import graph one-way (llm -> messages, never back).
  private sendMessagesHandler: SendMessagesHandler | null = null;
  private reprocessMessageHandler: ReprocessMessageHandler | null = null;

  setLLMHandlers(send: SendMessagesHandler, reprocess: ReprocessMessageHandler): void {
    this.sendMessagesHandler = send;
    this.reprocessMessageHandler = reprocess;
  }

  /** Drop the active session's transcript from memory. Called by
   *  sessionsState on every session-boundary transition; sister slices
   *  (streamingState, sessionsState itself) reset their own per-session
   *  fields. */
  clear(): void {
    this.messages = [];
    this.tokenUsage = null;
  }

  /** Replace the in-memory transcript with a session loaded from disk.
   *  Sessions slice owns id/title and is responsible for any defensive
   *  snapshot fixups (e.g. backfilling ids, freezing stuck spinners) before
   *  passing the array in. */
  hydrate(messages: Message[], tokenUsage: TokenUsage | null): void {
    this.messages = messages;
    this.tokenUsage = tokenUsage;
  }

  addMessage(message: Message) {
    if (!message.id) message.id = makeMessageId();
    this.messages.unshift(message);
    persistenceState.scheduleSave();
  }

  /**
   * Flush any pending attachments to disk under the current session directory,
   * then add the resulting user message. Session ID is assigned eagerly so
   * attachments get a stable path even before the first save.
   */
  async addUserMessage(payload: {
    text: string;
    attachments: Attachment[];
    timestamp: number;
    systemPromptOverride?: string;
    effectiveSystemPrompt?: string | null;
  }): Promise<void> {
    // Sending a new message always preempts any previous assistant TTS that
    // might still be playing or queued.
    streamingState.resetTTSPlayback();

    const trimmedText = payload.text.trim();
    if (!sessionsState.id) {
      sessionsState.id = Date.now().toString();
      sessionsState.title = sessionsState.title || sessionsState.defaultTitle;
    }
    const sessionId = sessionsState.id;
    const tsStr = payload.timestamp.toString();

    const parts: MessagePart[] = [];
    if (trimmedText) parts.push({ type: "text", text: trimmedText });

    for (const att of payload.attachments) {
      try {
        if (att.type === "image") {
          const mime = att.mime || "image/png";
          const ext = imageExtFromMime(mime);
          const filename = att.filename.includes(".")
            ? att.filename
            : `${att.filename || "image"}.${ext}`;
          const written = await writeSessionAttachment(sessionId, tsStr, filename, att.pendingData);
          parts.push({
            type: "image_file",
            filename: written.filename,
            path: written.path,
            mime,
          });
        } else {
          const filename = ensureMarkdownExtension(att.filename || "document.md");
          const written = await writeSessionAttachment(
            sessionId,
            tsStr,
            filename,
            utf8ToBase64(att.pendingData),
          );
          parts.push({
            type: "document_file",
            filename: written.filename,
            path: written.path,
          });
        }
      } catch (e) {
        console.error("[messages] Failed to write attachment:", e);
      }
    }

    const content: MessageContent =
      parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
    const userMsg: Message = { id: tsStr, role: "user", content };
    if (payload.systemPromptOverride) {
      userMsg.systemPromptOverride = payload.systemPromptOverride;
    }
    this.messages.unshift(userMsg);
    this.upsertSystemMessage(payload.effectiveSystemPrompt ?? buildSystemPrompt());
    if (settingsState.currentSettings["tools.enabled"]) {
      this.upsertToolFilterMessage(userMsg.id!, {
        status: "filtering",
        phase1: null,
        phase2: null,
        alwaysAvailable: null,
      });
    }
    persistenceState.scheduleSave();
  }

  /** Stable id convention: every tool_filter message is paired 1:1 with a
   *  user message via this suffix. Lets the lifecycle hooks (reprocess, edit,
   *  delete) find the right bubble without walking neighbouring indices. */
  private toolFilterIdFor(userMessageId: string): string {
    return `${userMessageId}-filter`;
  }

  /**
   * Create or update the tool_filter bubble paired with a user message. The
   * bubble is inserted at index 0 (newest-first order) so it visually sits
   * between the user message and the assistant response.
   */
  upsertToolFilterMessage(userMessageId: string, state: RelevantToolsState): void {
    const id = this.toolFilterIdFor(userMessageId);
    const existingIdx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (existingIdx >= 0) {
      this.messages[existingIdx] = {
        ...this.messages[existingIdx],
        relevantTools: state,
      };
    } else {
      this.messages.unshift({
        id,
        role: "tool_filter",
        content: "",
        relevantTools: state,
      });
    }
    persistenceState.scheduleSave();
  }

  /** Patch the tool_filter bubble paired with `userMessageId`. No-op if the
   *  bubble doesn't exist (e.g. tool use was disabled when the user message
   *  was added). */
  updateRelevantTools(userMessageId: string, patch: Partial<RelevantToolsState>): void {
    const id = this.toolFilterIdFor(userMessageId);
    const idx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (idx < 0) return;
    const existing = this.messages[idx].relevantTools;
    if (!existing) return;
    this.messages[idx] = {
      ...this.messages[idx],
      relevantTools: { ...existing, ...patch },
    };
    persistenceState.scheduleSave();
  }

  /** Remove the tool_filter bubble paired with `userMessageId`. Used when the
   *  paired user message is deleted. */
  removeToolFilterMessage(userMessageId: string): void {
    const id = this.toolFilterIdFor(userMessageId);
    const idx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (idx < 0) return;
    this.messages.splice(idx, 1);
  }

  /**
   * Keep the system-role message in sync with what was actually sent to the
   * LLM on the most recent turn. Always reflected in the array (and therefore
   * persisted with the session) so toggling `prompts.showSystemPrompt` later
   * can reveal it without a round-trip; the toggle is enforced at render time.
   * Public so the LLM dispatch can refresh the bubble with the turn-final
   * prompt (including the tools hint) right before sending.
   */
  upsertSystemMessage(effective: string | null | undefined): void {
    const existingIdx = this.messages.findIndex((m) => m.role === "system");
    const hasContent = typeof effective === "string" && effective.trim().length > 0;

    if (hasContent) {
      const content = (effective as string).trim();
      if (existingIdx >= 0) {
        this.messages[existingIdx] = {
          ...this.messages[existingIdx],
          content,
        };
      } else {
        this.messages.push({
          id: makeMessageId(),
          role: "system",
          content,
        });
      }
    } else if (existingIdx >= 0) {
      this.messages.splice(existingIdx, 1);
    }
  }

  /** Push a new role:"tool" message representing an active tool invocation.
   *  Returns the message id so callers can update the same slot later. */
  appendToolCall(tc: ToolCallState): string {
    const id = makeMessageId();
    this.addMessage({
      id,
      role: "tool",
      content: "",
      toolCall: tc,
    });
    return id;
  }

  /** Immutably merge `patch` into the ToolCallState of the message whose
   *  toolCall.callId matches. No-op when the call is missing (e.g. the user
   *  deleted the bubble). */
  updateToolCall(callId: string, patch: Partial<ToolCallState>): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: { ...existing, ...patch },
    };
    persistenceState.scheduleSave();
  }

  /** Mark a tool call terminated with either a result or an error. Sets the
   *  status too so callers don't have to duplicate that. */
  resolveToolCall(
    callId: string,
    payload: { result?: unknown; error?: string; cancelled?: boolean },
  ): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    let status: ToolCallStatus;
    if (payload.cancelled) {
      status = "cancelled";
    } else if (payload.error !== undefined) {
      status = "failed";
    } else {
      status = "complete";
    }
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: {
        ...existing,
        status,
        result: payload.result,
        error: payload.error,
      },
    };
    persistenceState.scheduleSave();
  }

  /** Record an askUser request on the bubble so the form renders. */
  setToolCallAskUser(callId: string, requestId: string, questions: AskUserQuestion[]): void {
    this.updateToolCall(callId, {
      status: "awaiting_user",
      askUser: { requestId, questions, answers: null },
    });
  }

  /** Stash the user's answers on the bubble after submit. The WS layer
   *  forwards them back to the worker; this keeps the UI in the right state
   *  while we wait for the next progress / result event. */
  recordToolCallAskUserAnswers(callId: string, answers: AskUserAnswer[]): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing?.askUser) return;
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: {
        ...existing,
        status: "running",
        askUser: { ...existing.askUser, answers },
      },
    };
    persistenceState.scheduleSave();
  }

  /** Append a log line visible in the bubble's details disclosure. */
  appendToolCallLog(callId: string, line: ToolCallLogLine): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    const logs = existing.logs.length >= 200 ? existing.logs.slice(-199) : existing.logs.slice();
    logs.push(line);
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: { ...existing, logs },
    };
  }

  /** Update any user message by id and regenerate the response. If no id is
   *  provided, falls back to the most recent user message. */
  async updateUserMessage(messageId: string | undefined, content: MessageContent) {
    await streamingState.interruptStreaming();
    // interruptStreaming only stops TTS if something was actively streaming.
    // When editing a message with a settled assistant response, the response
    // is about to be discarded (either spliced out on delete, or replaced by
    // the resend), so any replay-mode TTS tied to it must stop too.
    streamingState.resetTTSPlayback();

    const userIdx = messageId
      ? this.messages.findIndex((m) => m.role === "user" && m.id === messageId)
      : this.messages.findIndex((m) => m.role === "user");
    if (userIdx < 0) return;

    const prevContent = this.messages[userIdx].content;

    const isEmpty =
      typeof content === "string"
        ? !content.trim()
        : content.every((p) => p.type === "text" && !p.text.trim());

    // Reject clearing the sole user message of a session: leaving the session
    // with zero user messages orphans the session file and drops any system
    // message + attachments that belonged to this turn.
    if (isEmpty) {
      const userCount = this.messages.filter((m) => m.role === "user").length;
      if (userCount <= 1) {
        console.warn("[messages] refusing to empty the only user message of this session");
        return;
      }
    }

    if (isEmpty) {
      this.messages.splice(0, userIdx + 1);
      persistenceState.cleanupRemovedAttachments(prevContent, content);
      await persistenceState.flushSave();
      return;
    }

    // Re-apply snippet expansion over the edited text so retyped `@triggers`
    // take effect on resend. Attachments are preserved verbatim.
    const rawText = getTextContent(content);
    const { userText, systemOverride } = applySnippets(rawText, snippetsState.snippets);
    const systemPromptOverride = systemOverride
      ? (applySystemPromptOverride(buildSystemPromptBase(), systemOverride, buildContextBlock()) ??
        undefined)
      : undefined;
    const effectiveSystemPrompt = systemPromptOverride ?? buildSystemPrompt();

    const expandedContent: MessageContent = (() => {
      if (typeof content === "string") return userText;
      const nonText = (content as MessagePart[]).filter((p) => p.type !== "text");
      const parts: MessagePart[] = [];
      if (userText) parts.push({ type: "text", text: userText });
      parts.push(...nonText);
      if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
      return parts;
    })();

    const updatedMsg: Message = { role: "user", content: expandedContent };
    if (this.messages[userIdx].id) updatedMsg.id = this.messages[userIdx].id;
    if (systemPromptOverride) updatedMsg.systemPromptOverride = systemPromptOverride;
    this.messages[userIdx] = updatedMsg;

    persistenceState.cleanupRemovedAttachments(prevContent, content);

    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      sessionsState.title = sessionsState.defaultTitle;
    }

    this.upsertSystemMessage(effectiveSystemPrompt);

    await persistenceState.flushSave();

    // Regenerate the paired response in place so turns newer than this user
    // message survive the edit. In newest-first order the paired response sits
    // one or more slots above the user message: a tool_filter bubble (when
    // tools are enabled) and/or a reasoning bubble may sit between. Skip past
    // those to land on the content slot that drives reprocessing. Fall back to
    // a fresh send when no paired response exists (edit on a brand-new user
    // message). Skipping tool_filter matters because otherwise we'd fall into
    // sendMessages() with the stale assistant still in context, which llama.cpp
    // rejects as an "assistant prefill" incompatible with enable_thinking.
    let scan = userIdx - 1;
    while (
      scan >= 0 &&
      (this.messages[scan].role === "reasoning" || this.messages[scan].role === "tool_filter")
    )
      scan -= 1;
    const paired = scan >= 0 ? this.messages[scan] : null;
    if (paired && (paired.role === "assistant" || paired.role === "error") && paired.id) {
      await this.reprocessMessageHandler?.(paired.id);
    } else {
      await this.sendMessagesHandler?.();
    }
  }

  /** Back-compat wrapper: update the most recent user message. */
  async updateLastUserMessage(content: MessageContent) {
    await this.updateUserMessage(undefined, content);
  }

  /** Delete a user message along with its paired assistant/error response. If
   *  this empties the session of user messages, remove the session entirely. */
  async deleteUserMessage(messageId: string) {
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();

    const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === messageId);
    if (userIdx < 0) return;

    // Drop the paired tool_filter bubble first so its index doesn't drift
    // under the assistant-pair splice below.
    this.removeToolFilterMessage(messageId);
    const refreshedUserIdx = this.messages.findIndex(
      (m) => m.role === "user" && m.id === messageId,
    );

    // newest-first: the paired response (generated AFTER this user msg) sits
    // one or two slots above. Walk backwards across reasoning bubbles and the
    // assistant/error content bubble so the splice catches the whole turn.
    let pairedIdx = refreshedUserIdx;
    while (pairedIdx > 0) {
      const above = this.messages[pairedIdx - 1];
      if (above.role === "assistant" || above.role === "error" || above.role === "reasoning") {
        pairedIdx -= 1;
      } else {
        break;
      }
    }

    const prevContent = this.messages[refreshedUserIdx].content;

    const deleteCount = refreshedUserIdx - pairedIdx + 1;
    this.messages.splice(pairedIdx, deleteCount);

    persistenceState.cleanupRemovedAttachments(prevContent, "");

    const remainingUsers = this.messages.filter((m) => m.role === "user").length;
    if (remainingUsers === 0) {
      await sessionsState.delete();
      return;
    }

    await persistenceState.flushSave();
  }

  /** Regenerate a specific assistant message in place. Only messages
   *  chronologically before the target are used as context; newer turns stay
   *  untouched. */
  async reprocessAgentMessage(messageId: string) {
    if (streamingState.isActive) return;
    streamingState.resetTTSPlayback();

    const agentIdx = this.messages.findIndex(
      (m) => (m.role === "assistant" || m.role === "error") && m.id === messageId,
    );
    if (agentIdx < 0) return;

    await this.reprocessMessageHandler?.(messageId);
  }

  /** Delete an assistant/error message. Safe to call on a currently-streaming
   *  message - aborts generation silently first. If this empties the session
   *  of user messages, remove the session entirely (symmetric with
   *  deleteUserMessage). */
  /** Delete a reasoning bubble. When the bubble is paired to an assistant
   *  content message (the normal case), delegate to `deleteAgentMessage` so
   *  the whole turn (reasoning + content) goes together; leaving reasoning
   *  without its produced answer makes no sense. Standalone reasoning
   *  (orphaned, shouldn't happen in practice) is removed in place. */
  async deleteReasoningMessage(messageId: string) {
    const idx = this.messages.findIndex((m) => m.role === "reasoning" && m.id === messageId);
    if (idx < 0) return;
    const paired = this.messages[idx].pairedAssistantId;
    if (paired) {
      await this.deleteAgentMessage(paired);
      return;
    }
    this.messages.splice(idx, 1);
    await persistenceState.flushSave();
  }

  async deleteAgentMessage(messageId: string) {
    const idx = this.messages.findIndex(
      (m) => (m.role === "assistant" || m.role === "error") && m.id === messageId,
    );
    if (idx < 0) return;

    const isStreamingThis = streamingState.isActive && idx === 0;
    if (isStreamingThis) {
      streamingState.abortSilently();
    }
    streamingState.resetTTSPlayback();

    this.messages.splice(idx, 1);
    // Drop any reasoning bubble paired to this assistant turn; they live
    // and die together, since the reasoning trace has no meaning without
    // its produced answer (or vice-versa).
    const reasoningIdx = this.messages.findIndex(
      (m) => m.role === "reasoning" && m.pairedAssistantId === messageId,
    );
    if (reasoningIdx >= 0) {
      this.messages.splice(reasoningIdx, 1);
    }

    const remainingUsers = this.messages.filter((m) => m.role === "user").length;
    if (remainingUsers === 0) {
      await sessionsState.delete();
      return;
    }

    await persistenceState.flushSave();
  }
}

export const messagesState = new MessagesState();
