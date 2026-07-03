// Re-export shim: ID generators now live in @tomat/core-engine's platform layer
// (runtime-agnostic). Core keeps importing from this path unchanged; this file
// forwards. Removed once every core importer points at the engine directly.

export {
  newAttachmentId,
  newCallId,
  newClientId,
  newJobId,
  newMcpServerId,
  newMemoryId,
  newMessageId,
  newRequestId,
  newScheduledPromptId,
  newSessionId,
  newStreamId,
} from "@tomat/core-engine";
