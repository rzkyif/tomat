/**
 * Reactive store for the in-flight runtime permission request, if any. A
 * `tool.permission_request` frame means a running tool is paused on a Deno
 * permission prompt; UserInput switches into its permission mode (textarea
 * and send controls replaced by the request description + X / check
 * buttons) until the user decides. One request can be pending at a time:
 * a prompt blocks the worker's whole JS thread.
 */

import { cores } from "$lib/core";
import { messagesState } from "./messages.svelte";

export type PendingPermission = {
  callId: string;
  requestId: string;
  permissionKind: "net" | "read" | "write" | "run" | "env" | "ffi" | "sys";
  resource: string;
  apiName?: string;
  declared: boolean;
  reason?: string;
  toolkitId: string;
  toolName: string;
};

class PermissionState {
  pending = $state<PendingPermission | null>(null);

  set(req: PendingPermission): void {
    this.pending = req;
  }

  /** Send the user's decision and return the bubble to its running state.
   *  The accept is scoped to the current tool call only; "always allow"
   *  lives in the toolkit detail view. */
  respond(allow: boolean): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    cores().api().chat.respondPermission(p.callId, p.requestId, allow);
    messagesState.clearToolCallPermissionRequest(p.callId);
  }

  /** Drop the pending request when its call reached a terminal state some
   *  other way (timeout, cancel, worker death). */
  clearForCall(callId: string): void {
    if (this.pending?.callId === callId) this.pending = null;
  }
}

export const permissionState = new PermissionState();
