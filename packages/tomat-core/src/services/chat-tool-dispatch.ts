// Tool-call dispatch for a turn. Given a resolved pending call and the (already
// born) tool message, run the call to completion and fold the outcome into the
// message; the orchestrator finalizes it afterwards. Two paths: MCP tools run on
// their server (a straight request/response), extension tools run in the
// worker-pool sandbox with the full progress / askUser / permission / schedule
// flow forwarded as prompts. The in-flight controller is registered for the
// call's lifetime so the WS forward* handlers can deliver responses and cancels.

import type { DisplayMessage, ServerToClientFrame, ToolMessage } from "@tomat/shared";
import { errMessage } from "@tomat/shared";
import { sessionsRepo } from "./sessions-store.ts";
import type { ActiveStream, ResolvedPendingCall } from "./chat-types.ts";
import type { TurnWriter } from "./chat-turn-writer.ts";
import { lastUserText } from "./chat-history.ts";
import { extensionsRegistry } from "../extensions/registry.ts";
import { validateAndNormalizeToolArgs } from "../extensions/validate-args.ts";
import { workerPool } from "../extensions/worker-pool.ts";
import type { CallController } from "../extensions/worker-call.ts";
import { mcpRegistry } from "../mcp/registry.ts";
import { mcpManager } from "../mcp/manager.ts";
import { newMessageId } from "../shared/ids.ts";

export type InFlightEntry = { clientId: string; ctl: CallController; stream: ActiveStream };

export class ToolDispatcher {
  constructor(
    private readonly send: (clientId: string, frame: ServerToClientFrame) => void,
    private readonly emitPrompt: (
      stream: ActiveStream,
      callId: string,
      frame: ServerToClientFrame,
    ) => void,
    private readonly inFlight: Map<string, InFlightEntry>,
  ) {}

  // Runs one tool call and fills the outcome into `msg` (the message the
  // caller already announced as born); the caller finalizes it afterwards.
  /** Run an MCP tool: parse the model's arguments, call the server, and fold
   *  the returned content into the tool message. MCP tools have no local
   *  permissions, progress, or askUser flow, so this is a straight request. */
  private async executeMcpToolCall(
    pending: ResolvedPendingCall,
    msg: ToolMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = pending.arguments ? JSON.parse(pending.arguments) : {};
    } catch {
      // Leave args empty; the server validates against its own schema.
    }
    try {
      const result = (await mcpManager().callTool(
        pending.extensionId,
        pending.toolName,
        args,
        signal,
      )) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      if (result.isError) {
        msg.status = "failed";
        msg.error = text || "MCP tool returned an error";
      } else {
        msg.status = "completed";
        msg.result = text || result;
      }
    } catch (err) {
      msg.status = "failed";
      msg.error = errMessage(err);
    }
  }

  async execute(
    stream: ActiveStream,
    pending: ResolvedPendingCall,
    msg: ToolMessage,
    writer: TurnWriter,
  ): Promise<void> {
    if (pending.unknown) {
      msg.status = "failed";
      msg.error = `tool ${pending.toolName} not available`;
      return;
    }
    // MCP tools run on their server, not in the local sandbox: dispatch via the
    // MCP client and skip the worker-pool / permission machinery.
    if (mcpRegistry().get(pending.extensionId)) {
      await this.executeMcpToolCall(pending, msg, stream.abort.signal);
      return;
    }
    const tool = extensionsRegistry().getTool(`${pending.extensionId}::${pending.toolName}`);
    if (!tool) {
      msg.status = "failed";
      msg.error = "tool not found";
      return;
    }
    // Pre-flight before dispatch: (1) re-verify the extension's content hash so a
    // extension tampered since boot can't execute (this runs on EVERY call, so a
    // reused warm worker is re-checked too); (2) validate the model-emitted
    // arguments against the tool's declared schema and fill defaults, so the
    // worker receives normalized args (not raw model output).
    //
    // Residual TOCTOU: a tool granted write into its OWN installed code dir
    // could alter that code in the window between this check and the worker's
    // import. The content-hash gate therefore assumes a extension is not granted
    // write to its own installedPath; never grant $extension write to an untrusted
    // extension.
    let normalizedArgs: string;
    try {
      await extensionsRegistry().verifyHashFresh(pending.extensionId);
      normalizedArgs = validateAndNormalizeToolArgs(tool, pending.arguments);
    } catch (err) {
      const errMsg = errMessage(err);
      this.send(stream.clientId, {
        kind: "tool.error",
        callId: pending.callId,
        error: errMsg,
      });
      msg.status = "failed";
      msg.error = errMsg;
      return;
    }
    const ctl = workerPool().startCall(
      {
        extensionId: pending.extensionId,
        tool,
        argumentsJson: normalizedArgs,
        chatContext: {
          userMessage: lastUserText(sessionsRepo().listMessages(stream.sessionId)) ?? "",
          sessionId: stream.sessionId,
          locale: undefined,
        },
      },
      (event) => {
        if (event.kind === "progress") {
          // Persist the tool's latest wording + progress on the message so
          // the reloaded bubble keeps them.
          if (event.label !== undefined) msg.label = event.label;
          if (event.description !== undefined) {
            msg.description = event.description;
          }
          msg.progress = event.progress;
          this.send(stream.clientId, {
            kind: "tool.progress",
            callId: pending.callId,
            progress: event.progress,
            label: event.label,
            description: event.description,
          });
        } else if (event.kind === "ask_user_request") {
          this.emitPrompt(stream, pending.callId, {
            kind: "tool.askuser_request",
            callId: pending.callId,
            requestId: event.requestId,
            questions: event.questions,
          });
        } else if (event.kind === "schedule_request") {
          this.emitPrompt(stream, pending.callId, {
            kind: "schedule.confirm_request",
            callId: pending.callId,
            requestId: event.requestId,
            draft: event.draft,
          });
        } else if (event.kind === "permission_request") {
          this.emitPrompt(stream, pending.callId, {
            kind: "tool.permission_request",
            callId: pending.callId,
            requestId: event.requestId,
            permissionKind: event.permission,
            resource: event.resource,
            apiName: event.apiName,
            declared: event.declared,
            reason: event.reason,
            extensionId: pending.extensionId,
            toolName: pending.toolName,
          });
        } else if (event.kind === "log") {
          this.send(stream.clientId, {
            kind: "tool.log",
            callId: pending.callId,
            level: event.level,
            message: event.message,
          });
        } else if (event.kind === "display") {
          // One-way push: a display bubble is born and persisted in one
          // step. It lands before the (still-running) tool message in the
          // durable order, which matches the live order the client saw.
          const displayMsg: DisplayMessage = {
            id: newMessageId(),
            ord: -1,
            role: "display",
            callId: pending.callId,
            content: event.content,
            createdAtMs: Date.now(),
          };
          writer.born(displayMsg);
          writer.finalize(displayMsg);
        } else if (event.kind === "tool_cancelled") {
          this.send(stream.clientId, {
            kind: "tool.cancelled",
            callId: pending.callId,
          });
        }
      },
    );
    this.inFlight.set(pending.callId, {
      clientId: stream.clientId,
      ctl,
      stream,
    });
    try {
      const result = await ctl.done;
      this.send(stream.clientId, {
        kind: "tool.result",
        callId: pending.callId,
        result,
      });
      msg.status = "completed";
      msg.result = result;
    } catch (err) {
      const errMsg = errMessage(err);
      this.send(stream.clientId, {
        kind: "tool.error",
        callId: pending.callId,
        error: errMsg,
      });
      msg.status = "failed";
      msg.error = errMsg;
    } finally {
      stream.outstandingPrompts.delete(pending.callId);
      this.inFlight.delete(pending.callId);
    }
  }
}
