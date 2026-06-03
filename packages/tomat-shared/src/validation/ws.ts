// Per-frame Zod schemas for the /ws/v1 server→client direction. The
// envelope check in `chat.ts` (wsFrameEnvelopeSchema) keeps known fields
// flowing through unknown variants for forward-compat; once every paired
// client is on a release that recognizes these schemas, callers can opt
// into `.strict()` per variant by re-exporting tightened versions.
//
// All variants here use `.passthrough()` so the staged-rollout policy in
// the WS hub (warn-and-drop on envelope mismatch only) still applies.

import { z } from "zod";

// --- Tool-filter entries ---------------------------------------------------

export const toolFilterPhase1EntrySchema = z
  .object({
    toolId: z.string().min(1),
    name: z.string(),
    description: z.string(),
    score: z.number(),
  })
  .passthrough();

export const toolFilterEntrySchema = z
  .object({
    toolId: z.string().min(1),
    name: z.string(),
    description: z.string(),
  })
  .passthrough();

// --- Pending tool call + askuser shapes -----------------------------------

export const pendingToolCallSchema = z
  .object({
    callId: z.string().min(1),
    toolkitId: z.string().min(1),
    toolName: z.string().min(1),
    arguments: z.string(),
  })
  .passthrough();

export const askUserQuestionSchema = z
  .object({
    question: z.string(),
    options: z
      .array(
        z
          .object({
            label: z.string(),
            value: z.string(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    multiselect: z.boolean().optional(),
    allowFreeformInput: z.boolean().optional(),
  })
  .passthrough();

// --- Frames ----------------------------------------------------------------

const pongSchema = z
  .object({
    kind: z.literal("pong"),
  })
  .passthrough();

// Server heartbeat ping; the client replies with a "pong" client frame. Without
// this variant the client would reject the heartbeat and the hub would drop the
// connection after the pong timeout (see armHeartbeat).
const pingFrameSchema = z
  .object({
    kind: z.literal("ping"),
  })
  .passthrough();

const chatToolfilterFrameSchema = z
  .object({
    kind: z.literal("chat.toolfilter"),
    streamId: z.string().min(1),
    status: z.enum(["filtering", "complete", "error"]),
    phase1: z.array(toolFilterPhase1EntrySchema).optional(),
    phase2: z.array(toolFilterEntrySchema).optional(),
    alwaysAvailable: z.array(toolFilterEntrySchema).optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

const chatChunkFrameSchema = z
  .object({
    kind: z.literal("chat.chunk"),
    streamId: z.string().min(1),
    contentDelta: z.string().optional(),
    reasoningDelta: z.string().optional(),
    finishReason: z.string().optional(),
  })
  .passthrough();

const chatToolcallRequestedFrameSchema = z
  .object({
    kind: z.literal("chat.toolcall_requested"),
    streamId: z.string().min(1),
    calls: z.array(pendingToolCallSchema),
  })
  .passthrough();

const tokenUsageSchema = z
  .object({
    prompt: z.number(),
    completion: z.number(),
    total: z.number(),
  })
  .passthrough();

const chatUsageFrameSchema = z
  .object({
    kind: z.literal("chat.usage"),
    streamId: z.string().min(1),
    tokenUsage: tokenUsageSchema,
  })
  .passthrough();

const chatDoneFrameSchema = z
  .object({
    kind: z.literal("chat.done"),
    streamId: z.string().min(1),
    reason: z.string(),
  })
  .passthrough();

const chatErrorFrameSchema = z
  .object({
    kind: z.literal("chat.error"),
    streamId: z.string().min(1),
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

const toolProgressFrameSchema = z
  .object({
    kind: z.literal("tool.progress"),
    callId: z.string().min(1),
    progress: z.number(),
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const toolAskuserRequestFrameSchema = z
  .object({
    kind: z.literal("tool.askuser_request"),
    callId: z.string().min(1),
    requestId: z.string().min(1),
    questions: z.array(askUserQuestionSchema),
  })
  .passthrough();

const toolLogFrameSchema = z
  .object({
    kind: z.literal("tool.log"),
    callId: z.string().min(1),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  })
  .passthrough();

const toolResultFrameSchema = z
  .object({
    kind: z.literal("tool.result"),
    callId: z.string().min(1),
    result: z.unknown(),
  })
  .passthrough();

const toolErrorFrameSchema = z
  .object({
    kind: z.literal("tool.error"),
    callId: z.string().min(1),
    error: z.string(),
    code: z.string().optional(),
  })
  .passthrough();

const toolCancelledFrameSchema = z
  .object({
    kind: z.literal("tool.cancelled"),
    callId: z.string().min(1),
  })
  .passthrough();

const toolkitInstallLogFrameSchema = z
  .object({
    kind: z.literal("toolkit.install_log"),
    jobId: z.string().min(1),
    id: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    line: z.string(),
  })
  .passthrough();

const toolkitInstallDoneFrameSchema = z
  .object({
    kind: z.literal("toolkit.install_done"),
    jobId: z.string().min(1),
    id: z.string().min(1),
    ok: z.boolean(),
    code: z.number(),
  })
  .passthrough();

const toolkitSnapshotFrameSchema = z
  .object({
    kind: z.literal("toolkit.snapshot"),
  })
  .passthrough();

// DownloadEntry/SidecarSnapshot are large domain shapes, so we use
// z.unknown() in the payload so the WS envelope passes without us copying every
// nested field. Downstream `downloads.svelte.ts` / `sidecar.svelte.ts`
// own the real validation against their domain types.
const downloadsSnapshotFrameSchema = z
  .object({
    kind: z.literal("downloads.snapshot"),
    items: z.array(z.unknown()),
  })
  .passthrough();

// RequiredFile is a domain shape; like downloads.snapshot we keep the payload
// loose (arrays of unknown) so the envelope passes without copying every nested
// field. `downloads.svelte.ts` assigns these straight onto its domain-typed
// state. Without this variant the discriminated union rejects every
// requirements.snapshot broadcast, so the pending-downloads popup only ever
// reflects the boot-time HTTP fetch and never live settings changes.
const requirementsSnapshotFrameSchema = z
  .object({
    kind: z.literal("requirements.snapshot"),
    required: z.array(z.unknown()),
    missing: z.array(z.unknown()),
  })
  .passthrough();

const sidecarStatusFrameSchema = z
  .object({
    kind: z.literal("sidecar.status"),
    sidecar: z.string(),
    status: z.string(),
    message: z.string().optional(),
    progress: z.number().optional(),
  })
  .passthrough();

const sessionUpdatedFrameSchema = z
  .object({
    kind: z.literal("session.updated"),
    sessionId: z.string().min(1),
    op: z.enum(["title_changed", "message_added", "message_updated", "message_deleted"]),
    payload: z
      .object({
        title: z.string().optional(),
        messageId: z.string().optional(),
        message: z.unknown().optional(),
        toolCall: z.unknown().optional(),
        attachments: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const updateStagedFrameSchema = z
  .object({
    kind: z.literal("update.staged"),
    version: z.string(),
  })
  .passthrough();

const updateErrorFrameSchema = z
  .object({
    kind: z.literal("update.error"),
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

/** Discriminated union over every server→client frame `kind`. Per-variant
 *  schemas above use `.passthrough()` so unknown fields survive the
 *  decode and a future client can render them once the consumer is
 *  updated. */
export const serverToClientFrameSchema = z.discriminatedUnion("kind", [
  pongSchema,
  pingFrameSchema,
  chatToolfilterFrameSchema,
  chatChunkFrameSchema,
  chatToolcallRequestedFrameSchema,
  chatUsageFrameSchema,
  chatDoneFrameSchema,
  chatErrorFrameSchema,
  toolProgressFrameSchema,
  toolAskuserRequestFrameSchema,
  toolLogFrameSchema,
  toolResultFrameSchema,
  toolErrorFrameSchema,
  toolCancelledFrameSchema,
  toolkitInstallLogFrameSchema,
  toolkitInstallDoneFrameSchema,
  toolkitSnapshotFrameSchema,
  downloadsSnapshotFrameSchema,
  requirementsSnapshotFrameSchema,
  sidecarStatusFrameSchema,
  sessionUpdatedFrameSchema,
  updateStagedFrameSchema,
  updateErrorFrameSchema,
]);

export type ServerToClientFrameParsed = z.infer<typeof serverToClientFrameSchema>;
