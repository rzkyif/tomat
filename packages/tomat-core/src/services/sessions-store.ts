// Re-export shim: the sessions/messages/attachments store now lives in
// @tomat/core-engine (JSON docs on disk via host().fs, per-session async mutex).
// Core keeps importing from this path unchanged; this file forwards.

export {
  __resetForTesting,
  SessionsRepo,
  sessionsRepo,
  sweepOrphanedSessionDirs,
} from "@tomat/core-engine/services/sessions-store";
export type {
  AttachmentRecord,
  CreateSessionInput,
} from "@tomat/core-engine/services/sessions-store";
