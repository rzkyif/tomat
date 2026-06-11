// Zod schemas for chat-related request bodies.

import { z } from "zod";

const messageOverrideSchema = z.object({
  // Trimmed message shape the client may pass to override the persisted
  // transcript for a one-shot completion. Role + content are required;
  // everything else is optional.
  role: z.enum(["user", "assistant", "system", "tool", "reasoning"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});

export const chatRequestSchema = z
  .object({
    // When absent, core uses the persisted session messages.
    messages: z.array(messageOverrideSchema).optional(),
    route: z.enum(["default", "secondary"]).default("default"),
    // Optional per-request overrides for LLM params.
    overrides: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().int().min(1).optional(),
      })
      .optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatStartWsSchema = z
  .object({
    kind: z.literal("chat.start"),
    streamId: z.string().min(1),
    sessionId: z.string().min(1),
    route: z.enum(["default", "secondary"]).default("default"),
    // Per-turn effective system prompt composed client-side; see the frame
    // type in api/ws.ts. Empty string is meaningful ("send no system
    // prompt"), absent means "fall back to prompts.defaultSystemPrompt".
    systemPrompt: z.string().optional(),
    // Rendered tools-availability hint, appended by core iff the turn
    // exposes tools to the model; see the frame type in api/ws.ts.
    toolsHint: z.string().optional(),
    // User message anchoring this turn (regenerate / edit-and-resend);
    // see the frame type in api/ws.ts.
    anchorMessageId: z.string().min(1).optional(),
    contextOverride: z.array(messageOverrideSchema).optional(),
  })
  .strict();

export type ChatStartFrame = z.infer<typeof chatStartWsSchema>;

export const chatInterruptWsSchema = z
  .object({
    kind: z.literal("chat.interrupt"),
    streamId: z.string().min(1),
  })
  .strict();

export type ChatInterruptFrame = z.infer<typeof chatInterruptWsSchema>;

export const toolAskUserResponseSchema = z
  .object({
    kind: z.literal("tool.askuser_response"),
    callId: z.string().min(1),
    requestId: z.string().min(1),
    answers: z.array(z.union([z.string(), z.array(z.string())])),
  })
  .strict();

export type ToolAskUserResponseFrame = z.infer<typeof toolAskUserResponseSchema>;

export const toolCancelSchema = z
  .object({
    kind: z.literal("tool.cancel"),
    callId: z.string().min(1),
  })
  .strict();

export type ToolCancelFrame = z.infer<typeof toolCancelSchema>;

// Minimal envelope for the CLIENT->server receive path on the WS hub
// (ws/hub.ts), where only `kind` routing matters: parse object + non-empty
// kind, pass unknown fields through, and log + drop only when the shape is
// unmistakably wrong.
//
// NOTE: the server->client direction IS validated per-variant by
// `serverToClientFrameSchema` in `validation/ws.ts` (the client uses it in
// core/client.ts); those variants use `.passthrough()` for forward-compat, and
// a test in `validation/ws.test.ts` asserts the Zod union covers every TS
// `ServerToClientFrame` kind so the two can't drift.
export const wsFrameEnvelopeSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

export type WsFrameEnvelope = z.infer<typeof wsFrameEnvelopeSchema>;
