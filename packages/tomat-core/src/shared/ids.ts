// ID generation wrappers. Wraps jsr:@std/ulid + crypto.randomUUID so call
// sites express intent (session id vs. opaque uuid) and we have one place
// to swap implementations later.

import { ulid } from "@std/ulid";

export function newSessionId(): string {
  return ulid();
}

export function newMessageId(): string {
  return ulid();
}

export function newAttachmentId(): string {
  return ulid();
}

export function newClientId(): string {
  return ulid();
}

export function newJobId(): string {
  return ulid();
}

export function newStreamId(): string {
  return ulid();
}

export function newCallId(): string {
  return ulid();
}

export function newRequestId(): string {
  // ask-user request id; short-lived per-call; uuid is fine.
  return crypto.randomUUID();
}

export function newDocumentId(): string {
  return ulid();
}

export function newScheduledPromptId(): string {
  return ulid();
}
