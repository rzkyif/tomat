// Single HTTP+WS client used by the rest of the client app to reach the
// currently-selected tomat-core. All requests are bearer-authed (except the
// public health check + pairing-claim).
//
// Multiplexed WS: one socket per paired core, every frame carries its own
// discriminator (streamId / callId / jobId). Subscribers register callbacks
// keyed by frame kind; the client dispatches incoming frames to them.

import type { ApiErrorBody, ClientToServerFrame, ServerToClientFrame } from "@tomat/shared";
import { serverToClientFrameSchema } from "@tomat/shared";
import { type NetResponse, type NetSocket, platform } from "../platform/index.ts";
import { getLogger } from "../shared/log.ts";
import { Subscribers } from "../shared/subscribers.ts";

const log = getLogger("ws");

export interface CoreEndpoint {
  baseUrl: string; // e.g. "https://127.0.0.1:7800"
  token: string; // bearer (from OS keychain)
  tlsPin: string; // pinned cert SPKI (base64 SHA-256), from pairing
}

export type WsListener = (frame: ServerToClientFrame) => void;

// Coarse connection state for UI banners. "connecting" is the initial state
// before the first open, plus during reconnect attempts after a close.
export type ConnectionState = "connecting" | "connected" | "disconnected";

export type ConnectionListener = (state: ConnectionState, reason?: string) => void;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

export class CoreClient {
  private ws: NetSocket | null = null;
  private wsBackoffMs = 500;
  private wsBackoffCapMs = 30_000;
  private listeners = new Subscribers<WsListener>();
  private wsConnected = false;
  private wsClosing = false;
  private pongTimeoutId: number | null = null;
  private pingTimeoutId: number | null = null;
  private connState: ConnectionState = "disconnected";
  private connListeners = new Subscribers<ConnectionListener>();
  // Last WS connect-failure reason (from the Tauri error event or an IPC
  // failure), surfaced with the "disconnected" transition so the UI banner can
  // show why. Cleared on a successful open.
  private lastWsError: string | null = null;

  constructor(public readonly endpoint: CoreEndpoint) {}

  // Subscribe to connection-state transitions. The listener is invoked
  // synchronously on register with the current state, and then on every
  // change. Returns an unsubscribe function. UI consumers use this to
  // drive the "Reconnecting to <core>…" banner after a 5s disconnect.
  onConnectionState(listener: ConnectionListener): () => void {
    const off = this.connListeners.add(listener);
    queueMicrotask(() => listener(this.connState, this.lastWsError ?? undefined));
    return off;
  }

  get connectionState(): ConnectionState {
    return this.connState;
  }

  private setConnState(state: ConnectionState, reason?: string): void {
    if (this.connState === state) return;
    this.connState = state;
    this.connListeners.emit(state, reason);
  }

  // --- REST ---------------------------------------------------------------

  async health(): Promise<{ status: string; version: string; uptimeMs: number }> {
    return await this.fetchJson("GET", "/api/v1/health", undefined, { auth: false });
  }

  async get<T>(path: string): Promise<T> {
    return await this.fetchJson<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.fetchJson<T>("POST", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return await this.fetchJson<T>("PATCH", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return await this.fetchJson<T>("PUT", path, body);
  }

  async del<T>(path: string): Promise<T | void> {
    return await this.fetchJson<T>("DELETE", path);
  }

  /** Alias for `del`. Matches `fetch`'s method naming so call sites
   *  reading like `client.delete("/foo")` are natural. */
  async delete<T>(path: string): Promise<T | void> {
    return await this.del<T>(path);
  }

  // multipart for attachments + STT audio uploads. FormData is encoded to raw
  // multipart bytes here (with its boundary content-type) so the pinned Rust
  // net layer can send it as an opaque body.
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const contentType = encoded.headers.get("content-type") ?? "multipart/form-data";
    const res = await platform().net.fetch({
      url: this.endpoint.baseUrl + path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.endpoint.token}`,
        "Content-Type": contentType,
      },
      body,
      pin: this.endpoint.tlsPin,
    });
    return await this.parseResponse<T>(res);
  }

  // POST a JSON body and get a binary blob back (TTS synth WAV).
  async postBlob(path: string, body: unknown): Promise<Blob> {
    const res = await platform().net.fetch({
      url: this.endpoint.baseUrl + path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.endpoint.token}`,
      },
      body: JSON.stringify(body),
      pin: this.endpoint.tlsPin,
    });
    if (!isOk(res)) this.throwApiError(res);
    return new Blob([res.body as BlobPart]);
  }

  // For binary endpoints (TTS WAV blob, attachment downloads).
  async fetchBlob(path: string): Promise<Blob> {
    const res = await platform().net.fetch({
      url: this.endpoint.baseUrl + path,
      headers: { Authorization: `Bearer ${this.endpoint.token}` },
      pin: this.endpoint.tlsPin,
    });
    if (!isOk(res)) this.throwApiError(res);
    return new Blob([res.body as BlobPart]);
  }

  // --- WebSocket ---------------------------------------------------------

  subscribe(listener: WsListener): () => void {
    const off = this.listeners.add(listener);
    if (!this.ws) this.connectWs();
    return off;
  }

  sendWs(frame: ClientToServerFrame): void {
    if (this.ws && this.wsConnected) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(): void {
    this.wsClosing = true;
    if (this.pingTimeoutId !== null) clearTimeout(this.pingTimeoutId);
    if (this.pongTimeoutId !== null) clearTimeout(this.pongTimeoutId);
    this.ws?.close();
    this.ws = null;
  }

  isWsConnected(): boolean {
    return this.wsConnected;
  }

  // --- internals ---------------------------------------------------------

  private async fetchJson<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.endpoint.token}`;
    const res = await platform().net.fetch({
      url: this.endpoint.baseUrl + path,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      pin: this.endpoint.tlsPin,
    });
    return this.parseResponse<T>(res);
  }

  private parseResponse<T>(res: NetResponse): T {
    if (res.status === 204) return undefined as T;
    if (!isOk(res)) this.throwApiError(res);
    const ct = res.headers["content-type"] ?? "";
    if (!ct.includes("application/json")) {
      // No JSON consumer in the workspace requests anything else through
      // this code path. Binary endpoints (TTS WAV, attachments) use
      // `fetchBlob`, SSE goes direct. A non-JSON content-type here is a
      // server-side bug; fail loud rather than cast a string to `T`.
      throw new ApiError(res.status, {
        code: "internal_error",
        message: `expected JSON response, got content-type "${ct}"`,
      });
    }
    return JSON.parse(decodeBody(res)) as T;
  }

  private throwApiError(res: NetResponse): never {
    let body: ApiErrorBody | undefined;
    try {
      body = JSON.parse(decodeBody(res)) as ApiErrorBody;
    } catch {
      /* */
    }
    if (body?.error) throw new ApiError(res.status, body.error);
    throw new ApiError(res.status, {
      code: "internal_error",
      message: `HTTP ${res.status}`,
    });
  }

  private connectWs(): void {
    if (this.wsClosing) return;
    const wsUrl =
      this.endpoint.baseUrl.replace(/^http/, "ws") +
      `/ws/v1?token=${encodeURIComponent(this.endpoint.token)}`;
    this.setConnState("connecting");
    void this.openSocket(wsUrl);
  }

  // Open a pinned WebSocket through the platform net layer (Rust on desktop,
  // browser WebSocket on web). The socket primitive differs, but the
  // backoff / ping-pong / dispatch logic is identical to the old browser path.
  private async openSocket(wsUrl: string): Promise<void> {
    let sock: NetSocket;
    try {
      sock = await platform().net.connectWebSocket(wsUrl, {
        pin: this.endpoint.tlsPin,
      });
    } catch (err) {
      // IPC-level failure (rare). The common connect failure (DNS / TLS pin
      // mismatch / refused) arrives later via the WS error event (onError
      // below). Record the reason and treat like a close so the backoff
      // reconnect loop kicks in.
      this.lastWsError = String(err);
      this.handleWsClosed();
      return;
    }
    // A close() may have raced in while we were connecting.
    if (this.wsClosing) {
      sock.close();
      return;
    }
    this.ws = sock;
    sock.onOpen(() => {
      this.wsConnected = true;
      this.wsBackoffMs = 500;
      this.lastWsError = null;
      this.setConnState("connected");
    });
    sock.onMessage((data) => this.handleWsMessage(data));
    sock.onClose(() => this.handleWsClosed());
    sock.onError((reason) => {
      if (reason) this.lastWsError = reason;
      try {
        sock.close();
      } catch {
        /* */
      }
    });
  }

  private handleWsMessage(data: string): void {
    // Two-stage parse: JSON decode, then validate the full discriminated
    // union via Zod. Per-variant schemas use `.passthrough()` so unknown
    // fields survive, which lets a newer server send extras without
    // breaking an older client. Frames that fail the kind discriminant
    // are dropped with a warn.
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch (err) {
      log.warn("rejected frame: invalid JSON", err);
      return;
    }
    const parsed = serverToClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      // Name the offending kind: an unknown/unhandled frame kind (the exact
      // class of bug that silently dropped requirements.snapshot) is the most
      // useful thing to see here.
      const kind = (raw as { kind?: unknown } | null)?.kind;
      log.warn(`rejected frame (kind=${String(kind)}): schema mismatch`, parsed.error.message);
      return;
    }
    // Cast bridges the Zod-parsed shape (which uses `string` for the
    // open-ended `code` field on chat.error) to the narrower TS union
    // (which uses `ErrorCode`). The schemas validate at runtime; the
    // TS narrowing is for downstream-handler ergonomics.
    const frame = parsed.data as unknown as ServerToClientFrame;
    if (frame.kind === "ping") {
      // Reply to the server heartbeat so the hub doesn't drop us after its pong
      // timeout (see core ws/hub.ts armHeartbeat).
      try {
        this.ws?.send(JSON.stringify({ kind: "pong" }));
      } catch {
        /* socket closing */
      }
      return;
    }
    if (frame.kind === "pong") {
      if (this.pongTimeoutId !== null) clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
      return;
    }
    this.listeners.emit(frame);
  }

  private handleWsClosed(): void {
    this.wsConnected = false;
    this.ws = null;
    this.setConnState("disconnected", this.lastWsError ?? undefined);
    if (this.wsClosing || this.listeners.size === 0) return;
    const delay = this.wsBackoffMs;
    this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, this.wsBackoffCapMs);
    setTimeout(() => this.connectWs(), delay);
  }
}

// True for a 2xx NetResponse.
function isOk(res: NetResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

// Decode a NetResponse body (UTF-8 bytes) to text for JSON parsing.
function decodeBody(res: NetResponse): string {
  return new TextDecoder().decode(res.body);
}
