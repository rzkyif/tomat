// Per-frame Zod schemas for the /ws/v1 server→client direction. The
// envelope check in `chat.ts` (wsFrameEnvelopeSchema) keeps known fields
// flowing through unknown variants for forward-compat; once every paired
// client is on a release that recognizes these schemas, callers can opt
// into `.strict()` per variant by re-exporting tightened versions.
//
// All variants here use `.passthrough()` so the staged-rollout policy in
// the WS hub (warn-and-drop on envelope mismatch only) still applies.

import { z } from "zod";
import { scheduledPromptDraftSchema } from "./scheduled-prompt.ts";

// --- Askuser shapes --------------------------------------------------------

// One loose shape covering every question kind (the TS union lives in
// api/ws.ts). A discriminated union cannot apply here because legacy
// frames omit `kind`; per-kind field presence is the renderer's concern.
export const askUserQuestionSchema = z
  .object({
    question: z.string(),
    kind: z.enum(["choice", "diff", "files", "image", "table"]).optional(),
    // choice
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
    // diff
    before: z.string().optional(),
    after: z.string().optional(),
    title: z.string().optional(),
    // files
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            label: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    // image
    dataB64: z.string().optional(),
    mime: z.string().optional(),
    actions: z.array(z.object({ label: z.string(), value: z.string() }).passthrough()).optional(),
    // table
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).optional(),
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

// Message is a large domain shape; like downloads.snapshot the payload stays
// loose (z.unknown()) so the envelope passes without copying every nested
// field. The messages store assigns it onto its domain-typed state.
const chatMessageFrameSchema = z
  .object({
    kind: z.literal("chat.message"),
    streamId: z.string().min(1),
    sessionId: z.string().min(1),
    message: z.unknown(),
    afterId: z.string().nullable(),
    final: z.boolean(),
  })
  .passthrough();

const chatDeltaFrameSchema = z
  .object({
    kind: z.literal("chat.delta"),
    streamId: z.string().min(1),
    messageId: z.string().min(1),
    delta: z.string(),
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
    reason: z.enum(["stop", "interrupted", "hop_limit"]),
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

const toolPermissionRequestFrameSchema = z
  .object({
    kind: z.literal("tool.permission_request"),
    callId: z.string().min(1),
    requestId: z.string().min(1),
    permissionKind: z.enum([
      "net",
      "read",
      "write",
      "run",
      "env",
      "ffi",
      "sys",
      "documents",
      "llm",
      "tts",
      "stt",
    ]),
    resource: z.string(),
    apiName: z.string().optional(),
    declared: z.boolean(),
    reason: z.string().optional(),
    toolkitId: z.string().min(1),
    toolName: z.string().min(1),
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

const settingsUpdatedFrameSchema = z
  .object({
    kind: z.literal("settings.updated"),
    values: z.record(z.string(), z.unknown()),
    deleted: z.array(z.string()),
    secretNames: z.array(z.string()).optional(),
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
        attachments: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Session is a domain shape; like downloads.snapshot the payload stays
// loose so the envelope passes without copying every nested field.
const sessionCreatedFrameSchema = z
  .object({
    kind: z.literal("session.created"),
    session: z.unknown(),
    reason: z.enum(["schedule", "greeting"]),
    scheduledPromptId: z.string().optional(),
    focus: z.enum(["show", "show_when_done"]),
  })
  .passthrough();

const scheduleConfirmRequestFrameSchema = z
  .object({
    kind: z.literal("schedule.confirm_request"),
    callId: z.string().min(1),
    requestId: z.string().min(1),
    draft: scheduledPromptDraftSchema,
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
  chatMessageFrameSchema,
  chatDeltaFrameSchema,
  chatUsageFrameSchema,
  chatDoneFrameSchema,
  chatErrorFrameSchema,
  toolProgressFrameSchema,
  toolAskuserRequestFrameSchema,
  toolPermissionRequestFrameSchema,
  toolLogFrameSchema,
  toolResultFrameSchema,
  toolErrorFrameSchema,
  toolCancelledFrameSchema,
  toolkitInstallLogFrameSchema,
  toolkitInstallDoneFrameSchema,
  toolkitSnapshotFrameSchema,
  downloadsSnapshotFrameSchema,
  requirementsSnapshotFrameSchema,
  settingsUpdatedFrameSchema,
  sidecarStatusFrameSchema,
  sessionUpdatedFrameSchema,
  sessionCreatedFrameSchema,
  scheduleConfirmRequestFrameSchema,
  updateStagedFrameSchema,
  updateErrorFrameSchema,
]);

export type ServerToClientFrameParsed = z.infer<typeof serverToClientFrameSchema>;
