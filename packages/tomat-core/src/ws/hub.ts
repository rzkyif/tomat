// Per-client WebSocket registry. One socket per paired client (multiplexed);
// every frame carries the discriminator it needs (streamId / callId / jobId)
// for the client to route. Chat-related client frames are dispatched to
// the chat service.
//
// Frame routing on the server side: services that want to push to a specific
// client (e.g. tool.askuser_request -> the client whose chat triggered it)
// call hub.broadcastToClient(clientId, frame). Broadcast to all
// (e.g. downloads.snapshot, sidecar.status, toolkit.snapshot) uses
// hub.broadcastAll(frame).
//
// Heartbeat: server pings every 25 s and expects a pong within 10 s.
// Token query param: /ws/v1?token=<bearer>. authService.authenticate runs
// during the upgrade handshake.

import type { ServerToClientFrame } from "@tomat/shared";
import {
  chatInterruptWsSchema,
  chatStartWsSchema,
  toolAskUserResponseSchema,
  toolCancelSchema,
} from "@tomat/shared";
import { authService } from "../services/auth.ts";
import { chatService } from "../services/chat.ts";
import { downloadManager } from "../downloads/manager.ts";
import { sidecarManager } from "../sidecars/manager.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("ws");

const HEARTBEAT_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

interface Connection {
  ws: WebSocket;
  clientId: string;
  alive: boolean;
  pingTimer?: number;
  pongTimer?: number;
}

class WsHub {
  private byClient = new Map<string, Set<Connection>>();
  private listenersWired = false;

  // Called on the Deno.serve hook when /ws/v1 receives an upgrade request.
  async handleUpgrade(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response("missing token", { status: 401 });
    }
    let clientId: string;
    try {
      const me = await authService().authenticate(token);
      clientId = me.id;
    } catch (err) {
      const msg = err instanceof AppError ? err.message : "auth failed";
      return new Response(msg, { status: 401 });
    }

    const upgrade = Deno.upgradeWebSocket(req);
    this.registerConnection(upgrade.socket, clientId);
    this.wireListenersOnce();
    return upgrade.response;
  }

  broadcastToClient(clientId: string, frame: ServerToClientFrame): void {
    const set = this.byClient.get(clientId);
    if (!set) return;
    const payload = JSON.stringify(frame);
    for (const conn of set) {
      try {
        conn.ws.send(payload);
      } catch { /* socket closing */ }
    }
  }

  broadcastAll(frame: ServerToClientFrame): void {
    const payload = JSON.stringify(frame);
    for (const set of this.byClient.values()) {
      for (const conn of set) {
        try {
          conn.ws.send(payload);
        } catch { /* */ }
      }
    }
  }

  shutdown(): void {
    for (const set of this.byClient.values()) {
      for (const conn of set) {
        try {
          conn.ws.close();
        } catch { /* */ }
      }
    }
    this.byClient.clear();
  }

  // --- internals ---------------------------------------------------------

  private registerConnection(ws: WebSocket, clientId: string): void {
    const conn: Connection = { ws, clientId, alive: true };
    let set = this.byClient.get(clientId);
    if (!set) {
      set = new Set();
      this.byClient.set(clientId, set);
    }
    set.add(conn);

    ws.addEventListener("open", () => {
      this.armHeartbeat(conn);
    });
    ws.addEventListener("message", (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch { /* */ }
      if (!frame || typeof frame !== "object") return;
      this.dispatchClientFrame(conn, frame as Record<string, unknown>);
    });
    ws.addEventListener("close", () => this.removeConnection(conn));
    ws.addEventListener("error", () => this.removeConnection(conn));
  }

  private dispatchClientFrame(
    conn: Connection,
    raw: Record<string, unknown>,
  ): void {
    const kind = raw.kind;
    if (kind === "ping") {
      try {
        conn.ws.send(JSON.stringify({ kind: "pong" }));
      } catch { /* */ }
      return;
    }
    if (kind === "chat.start") {
      const parsed = chatStartWsSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(`bad chat.start: ${parsed.error.message}`);
        return;
      }
      chatService().start(conn.clientId, parsed.data);
      return;
    }
    if (kind === "chat.interrupt") {
      const parsed = chatInterruptWsSchema.safeParse(raw);
      if (!parsed.success) return;
      chatService().interrupt(parsed.data.streamId);
      return;
    }
    if (kind === "tool.askuser_response") {
      const parsed = toolAskUserResponseSchema.safeParse(raw);
      if (!parsed.success) return;
      chatService().forwardAskUserResponse(
        parsed.data.callId,
        parsed.data.requestId,
        parsed.data.answers,
      );
      return;
    }
    if (kind === "tool.cancel") {
      const parsed = toolCancelSchema.safeParse(raw);
      if (!parsed.success) return;
      chatService().forwardCancel(parsed.data.callId);
      return;
    }
    log.warn(`unknown ws frame kind: ${String(kind)}`);
  }

  private removeConnection(conn: Connection): void {
    const set = this.byClient.get(conn.clientId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.byClient.delete(conn.clientId);
    }
    if (conn.pingTimer !== undefined) clearTimeout(conn.pingTimer);
    if (conn.pongTimer !== undefined) clearTimeout(conn.pongTimer);
  }

  private armHeartbeat(conn: Connection): void {
    const tick = () => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      try {
        conn.ws.send(JSON.stringify({ kind: "ping" }));
      } catch { /* */ }
      conn.pongTimer = setTimeout(() => {
        log.warn(`pong timeout for client ${conn.clientId}; closing`);
        try {
          conn.ws.close(4002, "pong timeout");
        } catch { /* */ }
      }, PONG_TIMEOUT_MS) as unknown as number;
      conn.pingTimer = setTimeout(tick, HEARTBEAT_MS) as unknown as number;
    };
    conn.pingTimer = setTimeout(tick, HEARTBEAT_MS) as unknown as number;
  }

  // One-shot wiring of broadcast sources to the hub.
  private wireListenersOnce(): void {
    if (this.listenersWired) return;
    this.listenersWired = true;
    downloadManager().subscribe((snap) => {
      this.broadcastAll({ kind: "downloads.snapshot", items: snap });
    });
    sidecarManager().subscribe((snap) => {
      this.broadcastAll({
        kind: "sidecar.status",
        sidecar: snap.kind,
        status: snap.status,
        message: snap.message,
        progress: snap.progress,
      });
    });
  }
}

let _instance: WsHub | null = null;
export function wsHub(): WsHub {
  if (!_instance) _instance = new WsHub();
  return _instance;
}
