// Chat-stream control via WS frames. Streaming is server-driven; this module
// just sends start/interrupt/tool-response frames to the connected core.

import type { CoreClient } from "./client";

export class ChatApi {
  constructor(private readonly client: CoreClient) {}

  start(
    streamId: string,
    sessionId: string,
    route: "default" | "secondary" = "default",
    opts?: { systemPrompt?: string; toolsHint?: string; anchorMessageId?: string },
  ): void {
    this.client.sendWs({
      kind: "chat.start",
      streamId,
      sessionId,
      route,
      ...(opts?.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts?.toolsHint ? { toolsHint: opts.toolsHint } : {}),
      ...(opts?.anchorMessageId ? { anchorMessageId: opts.anchorMessageId } : {}),
    });
  }

  interrupt(streamId: string): void {
    this.client.sendWs({ kind: "chat.interrupt", streamId });
  }

  respondAskUser(callId: string, requestId: string, answers: Array<string | string[]>): void {
    this.client.sendWs({
      kind: "tool.askuser_response",
      callId,
      requestId,
      answers,
    });
  }

  cancelTool(callId: string): void {
    this.client.sendWs({ kind: "tool.cancel", callId });
  }
}
