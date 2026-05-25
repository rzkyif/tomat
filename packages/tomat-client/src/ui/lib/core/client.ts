// Single HTTP+WS client used by the rest of the client app to reach the
// currently-selected tomat-core. All requests are bearer-authed (except the
// public health check + pairing-claim).
//
// Multiplexed WS: one socket per paired core, every frame carries its own
// discriminator (streamId / callId / jobId). Subscribers register callbacks
// keyed by frame kind; the client dispatches incoming frames to them.

import type { ApiErrorBody, ClientToServerFrame, ServerToClientFrame } from "@tomat/shared";
import { serverToClientFrameSchema } from "@tomat/shared";

export interface CoreEndpoint {
  baseUrl: string; // e.g. "http://127.0.0.1:7800"
  token: string; // bearer (from OS keychain)
}

export type WsListener = (frame: ServerToClientFrame) => void;

// Coarse connection state for UI banners. "connecting" is the initial state
// before the first open, plus during reconnect attempts after a close.
export type ConnectionState = "connecting" | "connected" | "disconnected";

export type ConnectionListener = (state: ConnectionState) => void;

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
  private ws: WebSocket | null = null;
  private wsBackoffMs = 500;
  private wsBackoffCapMs = 30_000;
  private listeners = new Set<WsListener>();
  private wsConnected = false;
  private wsClosing = false;
  private pongTimeoutId: number | null = null;
  private pingTimeoutId: number | null = null;
  private connState: ConnectionState = "disconnected";
  private connListeners = new Set<ConnectionListener>();

  constructor(public readonly endpoint: CoreEndpoint) {}

  // Subscribe to connection-state transitions. The listener is invoked
  // synchronously on register with the current state, and then on every
  // change. Returns an unsubscribe function. UI consumers use this to
  // drive the "Reconnecting to <core>…" banner after a 5s disconnect.
  onConnectionState(listener: ConnectionListener): () => void {
    this.connListeners.add(listener);
    queueMicrotask(() => listener(this.connState));
    return () => this.connListeners.delete(listener);
  }

  get connectionState(): ConnectionState {
    return this.connState;
  }

  private setConnState(state: ConnectionState): void {
    if (this.connState === state) return;
    this.connState = state;
    for (const l of this.connListeners) {
      try {
        l(state);
      } catch {
        /* */
      }
    }
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

  // multipart for attachments + STT audio uploads
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const res = await fetch(this.endpoint.baseUrl + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.endpoint.token}` },
      body: form,
    });
    return await this.parseResponse<T>(res);
  }

  // For binary endpoints (TTS WAV blob, attachment downloads).
  async fetchBlob(path: string): Promise<Blob> {
    const res = await fetch(this.endpoint.baseUrl + path, {
      headers: { Authorization: `Bearer ${this.endpoint.token}` },
    });
    if (!res.ok) await this.throwApiError(res);
    return await res.blob();
  }

  // --- WebSocket ---------------------------------------------------------

  subscribe(listener: WsListener): () => void {
    this.listeners.add(listener);
    if (!this.ws) this.connectWs();
    return () => this.listeners.delete(listener);
  }

  sendWs(frame: ClientToServerFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
    const res = await fetch(this.endpoint.baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return await this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    if (!res.ok) await this.throwApiError(res);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      // No JSON consumer in the workspace requests anything else through
      // this code path — binary endpoints (TTS WAV, attachments) use
      // `fetchBlob`, SSE goes direct. A non-JSON content-type here is a
      // server-side bug; fail loud rather than cast a string to `T`.
      throw new ApiError(res.status, {
        code: "internal_error",
        message: `expected JSON response, got content-type "${ct}"`,
      });
    }
    return (await res.json()) as T;
  }

  private async throwApiError(res: Response): Promise<never> {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* */
    }
    if (body?.error) throw new ApiError(res.status, body.error);
    throw new ApiError(res.status, {
      code: "internal_error",
      message: `HTTP ${res.status} ${res.statusText}`,
    });
  }

  private connectWs(): void {
    if (this.wsClosing) return;
    const wsUrl =
      this.endpoint.baseUrl.replace(/^http/, "ws") +
      `/ws/v1?token=${encodeURIComponent(this.endpoint.token)}`;
    this.setConnState("connecting");
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.wsConnected = true;
      this.wsBackoffMs = 500;
      this.setConnState("connected");
    });
    ws.addEventListener("message", (ev) => {
      // Two-stage parse: JSON decode, then validate the full discriminated
      // union via Zod. Per-variant schemas use `.passthrough()` so unknown
      // fields survive — that lets a newer server send extras without
      // breaking an older client. Frames that fail the kind discriminant
      // are dropped with a warn.
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch (err) {
        console.warn("[ws] rejected frame: invalid JSON", err);
        return;
      }
      const parsed = serverToClientFrameSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          "[ws] rejected frame: schema mismatch",
          parsed.error.message,
        );
        return;
      }
      // Cast bridges the Zod-parsed shape (which uses `string` for the
      // open-ended `code` field on chat.error) to the narrower TS union
      // (which uses `ErrorCode`). The schemas validate at runtime; the
      // TS narrowing is for downstream-handler ergonomics.
      const frame = parsed.data as unknown as ServerToClientFrame;
      if (frame.kind === "pong") {
        if (this.pongTimeoutId !== null) clearTimeout(this.pongTimeoutId);
        this.pongTimeoutId = null;
        return;
      }
      for (const l of this.listeners) {
        try {
          l(frame);
        } catch {
          /* */
        }
      }
    });
    ws.addEventListener("close", () => {
      this.wsConnected = false;
      this.ws = null;
      this.setConnState("disconnected");
      if (this.wsClosing || this.listeners.size === 0) return;
      const delay = this.wsBackoffMs;
      this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, this.wsBackoffCapMs);
      setTimeout(() => this.connectWs(), delay);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* */
      }
    });
  }
}
