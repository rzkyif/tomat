// Core-initiated ("automated") sessions: the one backend behind scheduled
// prompts and greetings. Creates a fresh session for the owner client,
// persists the instruction as an `automated: true` user message, announces
// it over WS (`session.created`), and starts a normal chat turn on it.
//
// The turn deliberately runs the standard pipeline: no systemPrompt on the
// frame means chat.ts falls back to the `prompts.defaultSystemPrompt` core
// setting, and the shared DEFAULT_TOOLS_HINT is appended iff the turn
// actually exposes tools. Everything persists even when the owner client is
// offline; `broadcastToClient` simply drops frames nobody is listening for,
// and the client catches up from the session list on its next connect.

import type { Session, UserMessage } from "@tomat/shared";
import { DEFAULT_TOOLS_HINT } from "@tomat/shared";
import { newMessageId, newStreamId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";
import { wsHub } from "../ws/hub.ts";
import { chatService } from "./chat.ts";
import { sessionsRepo } from "./sessions-store.ts";

const log = getLogger("automated-session");

export interface AutomatedSessionInput {
  ownerClientId: string;
  title: string;
  /** The automated user prompt that opens the session. */
  instruction: string;
  reason: "schedule" | "greeting";
  scheduledPromptId?: string;
  /** How the owner client should surface the new session; see the
   *  `session.created` frame in @tomat/shared api/ws.ts. */
  focus: "show" | "show_when_done";
}

export function runAutomatedSession(input: AutomatedSessionInput): Session {
  const session = sessionsRepo().create({
    ownerClientId: input.ownerClientId,
    title: input.title,
  });
  const message: UserMessage = {
    id: newMessageId(),
    ord: 0, // appendMessage assigns the real ord
    role: "user",
    content: input.instruction,
    automated: true,
    createdAtMs: Date.now(),
  };
  sessionsRepo().appendMessage(session.id, message);
  wsHub().broadcastToClient(input.ownerClientId, {
    kind: "session.created",
    session,
    reason: input.reason,
    ...(input.scheduledPromptId ? { scheduledPromptId: input.scheduledPromptId } : {}),
    focus: input.focus,
  });
  log.info(`automated session ${session.id} (${input.reason}): "${input.title}"`);
  chatService().start(input.ownerClientId, {
    kind: "chat.start",
    streamId: newStreamId(),
    sessionId: session.id,
    route: "default",
    toolsHint: DEFAULT_TOOLS_HINT,
  });
  return session;
}
