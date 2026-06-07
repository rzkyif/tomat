// Zod schemas for the Message discriminated union (one variant per role
// from domain/session.ts). Used by core's session routes to validate
// inbound POST/PATCH bodies. Without this every cast `as Message` would
// silently accept arbitrary JSON and persist it.

import { z } from "zod";

// --- MessageContent ------------------------------------------------------

const messagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image_url"),
      image_url: z.object({ url: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image_file"),
      filename: z.string(),
      path: z.string(),
      mime: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("document"),
      filename: z.string(),
      markdown: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("document_file"),
      filename: z.string(),
      path: z.string(),
    })
    .strict(),
]);

const messageContentSchema = z.union([z.string(), z.array(messagePartSchema)]);

// --- ToolCall ------------------------------------------------------------

const toolCallStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_user",
  "completed",
  "failed",
  "cancelled",
]);

const toolCallSchema = z
  .object({
    callId: z.string(),
    toolkitId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
    status: toolCallStatusSchema,
    result: z.unknown().optional(),
    error: z.string().optional(),
    progress: z.number().optional(),
    logLines: z
      .array(
        z
          .object({
            level: z.enum(["debug", "info", "warn", "error"]),
            message: z.string(),
            atMs: z.number(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// --- ToolFilter inner shapes --------------------------------------------

const toolFilterPhase1Schema = z
  .object({
    toolId: z.string(),
    name: z.string(),
    description: z.string(),
    score: z.number(),
  })
  .strict();

const toolFilterEntrySchema = z
  .object({
    toolId: z.string(),
    name: z.string(),
    description: z.string(),
  })
  .strict();

// --- Per-role full input schemas ----------------------------------------
//
// id / ord / createdAtMs are optional because the server fills them in
// when the client omits them (appendMessage does `message.id || newMessageId()`
// and computes ord; createdAtMs falls back to Date.now()).

const baseShape = {
  id: z.string().optional(),
  ord: z.number().optional(),
  createdAtMs: z.number().optional(),
};

export const userMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("user"),
    content: messageContentSchema,
    systemPromptOverride: z.string().optional(),
  })
  .strict();

export const assistantMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("assistant"),
    content: z.string(),
    streaming: z.boolean().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
    pendingToolCalls: z.array(toolCallSchema).optional(),
    modelUsed: z.enum(["default", "secondary"]).optional(),
  })
  .strict();

export const systemMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("system"),
    content: z.string(),
  })
  .strict();

export const toolMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("tool"),
    callId: z.string(),
    toolkitId: z.string(),
    toolName: z.string(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    status: toolCallStatusSchema,
  })
  .strict();

export const reasoningMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("reasoning"),
    content: z.string(),
    streaming: z.boolean().optional(),
    reasoningDurationMs: z.number().optional(),
    pairedAssistantId: z.string().optional(),
    modelUsed: z.enum(["default", "secondary"]).optional(),
  })
  .strict();

export const toolFilterMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("tool_filter"),
    status: z.enum(["filtering", "complete", "error"]),
    phase1: z.array(toolFilterPhase1Schema).optional(),
    phase2: z.array(toolFilterEntrySchema).optional(),
    alwaysAvailable: z.array(toolFilterEntrySchema).optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const errorMessageInputSchema = z
  .object({
    ...baseShape,
    role: z.literal("error"),
    content: z.string(),
    code: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const messageInputSchema = z.discriminatedUnion("role", [
  userMessageInputSchema,
  assistantMessageInputSchema,
  systemMessageInputSchema,
  toolMessageInputSchema,
  reasoningMessageInputSchema,
  toolFilterMessageInputSchema,
  errorMessageInputSchema,
]);

// --- Per-role PATCH schemas ---------------------------------------------
//
// Patches must NOT carry `role` (the server always preserves the existing
// row's role) and every field is optional. Strict mode rejects fields that
// don't belong to the row's role. This is the guard that prevents a
// UserMessage from being patched with assistant-only fields like
// `toolCalls` or `streaming`.

export const messagePatchSchemaByRole = {
  user: userMessageInputSchema.omit({ role: true }).partial().strict(),
  assistant: assistantMessageInputSchema.omit({ role: true }).partial().strict(),
  system: systemMessageInputSchema.omit({ role: true }).partial().strict(),
  tool: toolMessageInputSchema.omit({ role: true }).partial().strict(),
  reasoning: reasoningMessageInputSchema.omit({ role: true }).partial().strict(),
  tool_filter: toolFilterMessageInputSchema.omit({ role: true }).partial().strict(),
  error: errorMessageInputSchema.omit({ role: true }).partial().strict(),
} as const;

export type MessageRoleForPatch = keyof typeof messagePatchSchemaByRole;
