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

type SendMessagesHandler = (anchorUserId?: string) => Promise<void>;

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
  // module that imports messagesState itself, so registering the callback
  // here keeps the static import graph one-way (llm -> messages, never back).
  // The handler accepts an optional `anchorUserId` so edit / reprocess can
  // regenerate the turn for an arbitrary user message in the middle of
  // history; called with no argument it sends the most recent user message
  // as a fresh turn at the tail.
  private sendMessagesHandler: SendMessagesHandler | null = null;

  setLLMHandlers(send: SendMessagesHandler): void {
    this.sendMessagesHandler = send;
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

  /** Insert a message at the newest position WITHIN the current turn.
   *
   *  No anchor (fresh tail-of-history submission): unshift to index 0,
   *  matching the historic behavior.
   *
   *  Anchor set (mid-history regenerate): place the new bubble immediately
   *  after the next-newer user message (lower index = newer), which keeps
   *  it inside the anchor's turn and below every bubble belonging to a
   *  newer turn. If no next-newer user exists, this still degenerates to
   *  index 0 (unshift). The bubble lands at the top of the anchor's turn,
   *  pushing any prior in-turn bubbles to higher (older) indices. */
  insertAtTurnAnchor(message: Message): void {
    if (!message.id) message.id = makeMessageId();
    const anchorId = streamingState.turnAnchorId;
    if (anchorId === null) {
      this.messages.unshift(message);
      persistenceState.scheduleSave();
      return;
    }
    const anchorIdx = this.messages.findIndex((m) => m.id === anchorId);
    if (anchorIdx < 0) {
      this.messages.unshift(message);
      persistenceState.scheduleSave();
      return;
    }
    let nextNewerUserIdx = -1;
    for (let i = anchorIdx - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        nextNewerUserIdx = i;
        break;
      }
    }
    this.messages.splice(nextNewerUserIdx + 1, 0, message);
    persistenceState.scheduleSave();
  }

  /** Splice every non-user bubble between `anchorUserId` and the next-newer
   *  user message. Returns the number of bubbles removed. Used by
   *  `regenerateTurn` (edit / reprocess) and `deleteUserMessage` to clear a
   *  whole multi-bubble turn atomically; both edges are preserved (the
   *  anchor user and the next user message stay put). */
  private spliceTurnAfter(anchorUserId: string): number {
    const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === anchorUserId);
    if (userIdx < 0) return 0;
    // newest-first: walk from userIdx-1 down toward 0, stop at the first
    // other user message (or the array head). Everything in between is part
    // of this turn.
    let stopIdx = -1;
    for (let i = userIdx - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        stopIdx = i;
        break;
      }
    }
    const startIdx = stopIdx + 1;
    const count = userIdx - startIdx;
    if (count > 0) {
      this.messages.splice(startIdx, count);
    }
    return count;
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
   * Create or update the tool_filter bubble paired with a user message.
   * Inserted just newer than the paired user message (one slot below in the
   * newest-first array) so it visually sits between the user message and the
   * assistant response, even when the paired user message is mid-history
   * (during an edit / reprocess regenerate).
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
      const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === userMessageId);
      const bubble: Message = {
        id,
        role: "tool_filter",
        content: "",
        relevantTools: state,
      };
      if (userIdx < 0) {
        this.messages.unshift(bubble);
      } else {
        this.messages.splice(userIdx, 0, bubble);
      }
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
    this.insertAtTurnAnchor({
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

  /** Clear every non-user bubble between `anchorUserId` and the next-newer
   *  user message, then re-stream the turn from that user message. Used as
   *  the single regeneration entry point for both edit (user message
   *  modified, then regenerate) and reprocess (no text change, just regen
   *  the turn that the targeted agent bubble belongs to). Bubbles older
   *  than the anchor and bubbles at or newer than the next user message
   *  stay untouched. */
  private async regenerateTurn(anchorUserId: string): Promise<void> {
    this.spliceTurnAfter(anchorUserId);
    // Re-seed the tool_filter bubble in "filtering" state so the spinner
    // shows during regen instead of leaving a gap until the model emits
    // its first chunk.
    if (settingsState.currentSettings["tools.enabled"]) {
      this.upsertToolFilterMessage(anchorUserId, {
        status: "filtering",
        phase1: null,
        phase2: null,
        alwaysAvailable: null,
      });
    }
    await persistenceState.flushSave();
    await this.sendMessagesHandler?.(anchorUserId);
  }

  /** Update any user message by id and regenerate the turn. If no id is
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
    const userMsgId = this.messages[userIdx].id;

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
      if (userMsgId) {
        await this.deleteUserMessage(userMsgId);
      }
      persistenceState.cleanupRemovedAttachments(prevContent, content);
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
    if (userMsgId) updatedMsg.id = userMsgId;
    if (systemPromptOverride) updatedMsg.systemPromptOverride = systemPromptOverride;
    this.messages[userIdx] = updatedMsg;

    persistenceState.cleanupRemovedAttachments(prevContent, content);

    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      sessionsState.title = sessionsState.defaultTitle;
    }

    this.upsertSystemMessage(effectiveSystemPrompt);

    if (!userMsgId) {
      // Defensive: every user message gets an id at addUserMessage time, but
      // older session files may have been hydrated without one. Without an
      // anchor we can't safely splice the turn, so fall back to a tail send.
      await persistenceState.flushSave();
      await this.sendMessagesHandler?.();
      return;
    }

    await this.regenerateTurn(userMsgId);
  }

  /** Back-compat wrapper: update the most recent user message. */
  async updateLastUserMessage(content: MessageContent) {
    await this.updateUserMessage(undefined, content);
  }

  /** Delete a user message along with every bubble in its turn (everything
   *  between this user message and the next-newer user message). If this
   *  empties the session of user messages, remove the session entirely. */
  async deleteUserMessage(messageId: string) {
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();

    const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === messageId);
    if (userIdx < 0) return;

    const prevContent = this.messages[userIdx].content;

    // Splice the turn first (everything newer than the user message, up to
    // the next user message). Then refind the user message's index (it may
    // have shifted) and splice it too.
    this.spliceTurnAfter(messageId);
    const refreshedUserIdx = this.messages.findIndex(
      (m) => m.role === "user" && m.id === messageId,
    );
    if (refreshedUserIdx >= 0) {
      this.messages.splice(refreshedUserIdx, 1);
    }

    persistenceState.cleanupRemovedAttachments(prevContent, "");

    const remainingUsers = this.messages.filter((m) => m.role === "user").length;
    if (remainingUsers === 0) {
      await sessionsState.delete();
      return;
    }

    await persistenceState.flushSave();
  }

  /** Regenerate the entire turn that produced the given assistant/error
   *  bubble. Walks older from the bubble until it hits the user message
   *  that caused the turn, then delegates to `regenerateTurn`. Equivalent
   *  to "edit that user message with no text change." */
  async reprocessAgentMessage(messageId: string) {
    if (streamingState.isActive) return;
    streamingState.resetTTSPlayback();

    const agentIdx = this.messages.findIndex(
      (m) => (m.role === "assistant" || m.role === "error") && m.id === messageId,
    );
    if (agentIdx < 0) return;

    // newest-first: walk older (higher index) until we find the user message
    // that anchors this turn.
    let userMsgId: string | null = null;
    for (let i = agentIdx + 1; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") {
        userMsgId = this.messages[i].id ?? null;
        break;
      }
    }
    if (!userMsgId) return;

    await this.regenerateTurn(userMsgId);
  }

  /** Regenerate the turn anchored on a user message, with no text change.
   *  Symmetric counterpart to `reprocessAgentMessage` for the user message
   *  context menu: equivalent to editing the message and resending it
   *  unchanged. */
  async reprocessUserMessage(messageId: string) {
    if (streamingState.isActive) return;
    streamingState.resetTTSPlayback();

    const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === messageId);
    if (userIdx < 0) return;

    await this.regenerateTurn(messageId);
  }

  /** Delete an assistant/error message together with the entire turn it
   *  belongs to (every bubble between the user message that caused the turn
   *  and the next-newer user message). The user message itself stays so the
   *  conversation thread is preserved. Safe to call on a currently-streaming
   *  bubble - aborts generation silently first. If we can't locate the
   *  causing user message (orphaned bubble, shouldn't happen), falls back
   *  to in-place delete of the bubble + any paired reasoning. */
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

    // Find the user message that caused this turn (walk older = higher idx).
    let userMsgId: string | null = null;
    for (let i = idx + 1; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") {
        userMsgId = this.messages[i].id ?? null;
        break;
      }
    }

    if (userMsgId) {
      this.spliceTurnAfter(userMsgId);
    } else {
      // Orphaned bubble: nothing to anchor a turn-splice on, so just remove
      // the bubble and any paired reasoning in place.
      this.messages.splice(idx, 1);
      const reasoningIdx = this.messages.findIndex(
        (m) => m.role === "reasoning" && m.pairedAssistantId === messageId,
      );
      if (reasoningIdx >= 0) {
        this.messages.splice(reasoningIdx, 1);
      }
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
