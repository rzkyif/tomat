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
import { getLogger } from "../util/log.ts";
import { Subscribers } from "../util/subscribers.ts";

const log = getLogger("ws");

export interface CoreEndpoint {
  baseUrl: string; // e.g. "https://127.0.0.1:7800"
  token: string; // bearer (from OS keychain)
  tlsPin: string; // pinned cert SPKI (base64 SHA-256), from pairing
}

export type WsListener = (frame: ServerToClientFrame) => void;

// Coarse connection state for UI banners. "connecting" is the initial state
// before the first open, plus during reconnect attempts after a close.
// "unauthorized" is terminal: the core rejected our bearer token during the
// WS handshake (e.g. its DB was reset and no longer has this client), so the
// same token will never connect. We stop the reconnect loop and surface this
// so the UI can prompt a re-pair, instead of hammering the core forever.
export type ConnectionState = "connecting" | "connected" | "disconnected" | "unauthorized";

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
  private wsBackoffMs: number;
  private readonly wsBackoffInitialMs: number;
  private readonly wsBackoffCapMs: number;
  // How long to wait for `onOpen` after a connect starts before giving up on it
  // (see armConnectWatchdog). Tighter for a loopback core, looser for remote.
  private readonly wsConnectTimeoutMs: number;
  private readonly isLocalCore: boolean;
  private listeners = new Subscribers<WsListener>();
  private wsConnected = false;
  private wsClosing = false;
  // A connect is in flight (openSocket running) or a reconnect timer is armed.
  // Together with `ws` these gate connectWs() so subscribe() during the backoff
  // window can't open a second socket racing the scheduled reconnect.
  private wsConnecting = false;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Deadline timer for the in-flight connect; cleared once the socket opens.
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every connect attempt (and on watchdog/close) so a late-resolving
  // connectWebSocket() from a superseded attempt is discarded, not adopted.
  private wsConnectGen = 0;
  private pongTimeoutId: number | null = null;
  private pingTimeoutId: number | null = null;
  private connState: ConnectionState = "disconnected";
  private connListeners = new Subscribers<ConnectionListener>();
  // Last WS connect-failure reason (from the Tauri error event or an IPC
  // failure), surfaced with the "disconnected" transition so the UI banner can
  // show why. Cleared on a successful open.
  private lastWsError: string | null = null;
  // When the current disconnect gap began (first close after a connected/initial
  // state), or null while connected. Drives the "connected after <ms>ms down"
  // log and gates the one-per-gap "disconnected" line. Reset on a successful open.
  private disconnectedAtMs: number | null = null;
  // Connect attempts in the current gap, for the "connecting (attempt N)" log.
  // Reset on a successful open.
  private connectAttempt = 0;

  constructor(public readonly endpoint: CoreEndpoint) {
    // A loopback core (dev hot-reload, on-demand local spawn) restarts in well
    // under a second, so reconnect briskly with a low cap; a remote core can be
    // down a while, so back off further to avoid hammering the link.
    this.isLocalCore = /\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)/.test(endpoint.baseUrl);
    this.wsBackoffInitialMs = this.isLocalCore ? 250 : 500;
    this.wsBackoffCapMs = this.isLocalCore ? 2_000 : 30_000;
    this.wsConnectTimeoutMs = this.isLocalCore ? 4_000 : 12_000;
    this.wsBackoffMs = this.wsBackoffInitialMs;
  }

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
    this.wsConnecting = false;
    this.wsConnectGen++; // discard any in-flight connect
    this.clearConnectWatchdog();
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
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
    // The core definitively rejected our credentials; retrying with the same
    // dead token would just spam it. Recovery is a re-pair, which builds a
    // fresh CoreClient, so this one stays parked.
    if (this.connState === "unauthorized") return;
    // Already connected, a connect is in flight, or a reconnect is scheduled:
    // don't open a competing socket.
    if (this.ws || this.wsConnecting || this.wsReconnectTimer !== null) return;
    this.wsConnecting = true;
    const gen = ++this.wsConnectGen;
    const wsUrl =
      this.endpoint.baseUrl.replace(/^http/, "ws") +
      `/ws/v1?token=${encodeURIComponent(this.endpoint.token)}`;
    log.debug(`connecting to ${this.endpoint.baseUrl} (attempt ${++this.connectAttempt})`);
    this.setConnState("connecting");
    this.armConnectWatchdog();
    void this.openSocket(wsUrl, gen);
  }

  // Open a pinned WebSocket through the platform net layer (Rust on desktop,
  // browser WebSocket on web). The socket primitive differs, but the
  // backoff / ping-pong / dispatch logic is identical to the old browser path.
  private async openSocket(wsUrl: string, gen: number): Promise<void> {
    let sock: NetSocket;
    try {
      sock = await platform().net.connectWebSocket(wsUrl, {
        pin: this.endpoint.tlsPin,
      });
    } catch (err) {
      // A newer attempt (watchdog/close) superseded this one while it was in
      // flight: drop it silently so we don't double-schedule a reconnect.
      if (gen !== this.wsConnectGen) return;
      // IPC-level failure (rare). The common connect failure (DNS / TLS pin
      // mismatch / refused) arrives later via the WS error event (onError
      // below). Record the reason and treat like a close so the backoff
      // reconnect loop kicks in.
      this.lastWsError = String(err);
      this.handleWsClosed();
      return;
    }
    // Superseded by a newer attempt, or close() raced in while we were
    // connecting: discard this socket.
    if (gen !== this.wsConnectGen || this.wsClosing) {
      try {
        sock.close();
      } catch {
        /* */
      }
      return;
    }
    this.ws = sock;
    // Connected: the `ws` guard in connectWs() now applies.
    this.wsConnecting = false;
    // Every callback is generation-guarded: once the watchdog (or a close)
    // abandons this attempt by bumping wsConnectGen, a late event from this now-
    // stale socket must NOT drive state, or it could tear down the healthy
    // socket a newer attempt has since opened.
    sock.onOpen(() => {
      if (gen !== this.wsConnectGen) {
        try {
          sock.close();
        } catch {
          /* */
        }
        return;
      }
      this.clearConnectWatchdog();
      this.wsConnected = true;
      this.wsBackoffMs = this.wsBackoffInitialMs;
      this.lastWsError = null;
      const downMs = this.disconnectedAtMs !== null ? Date.now() - this.disconnectedAtMs : null;
      log.info(downMs !== null ? `connected after ${downMs}ms down` : "connected");
      this.disconnectedAtMs = null;
      this.connectAttempt = 0;
      this.setConnState("connected");
    });
    sock.onMessage((data) => {
      if (gen !== this.wsConnectGen) return;
      this.handleWsMessage(data);
    });
    sock.onClose(() => {
      if (gen !== this.wsConnectGen) return;
      this.handleWsClosed();
    });
    sock.onError((reason) => {
      if (gen !== this.wsConnectGen) return;
      if (reason) this.lastWsError = reason;
      try {
        sock.close();
      } catch {
        /* */
      }
      // Drive recovery from the error itself rather than waiting for a following
      // onClose: an error always means this socket is done, so schedule the
      // reconnect now. A later onClose for the same socket re-enters
      // handleWsClosed but no-ops on the reconnect-timer / state guards (and the
      // generation is unchanged), so this can't double-schedule.
      this.handleWsClosed();
    });
  }

  // Some transports resolve connectWebSocket() before the socket is truly open
  // (or never deliver a close for a half-open socket), which would wedge us in
  // "connecting" forever with no reconnect and a stuck "Reconnecting…" banner.
  // Arm a deadline when a connect starts; if `onOpen` hasn't cleared it in time,
  // tear the attempt down and fall into the backoff loop. Bumping the generation
  // discards a late resolve from the abandoned attempt.
  private armConnectWatchdog(): void {
    this.clearConnectWatchdog();
    this.wsConnectTimer = setTimeout(() => {
      this.wsConnectTimer = null;
      if (this.wsConnected || this.wsClosing) return;
      log.warn(`ws connect timed out after ${this.wsConnectTimeoutMs}ms; retrying`);
      this.wsConnectGen++;
      const sock = this.ws;
      this.ws = null;
      this.wsConnecting = false;
      if (sock) {
        try {
          sock.close();
        } catch {
          /* */
        }
      }
      this.handleWsClosed();
    }, this.wsConnectTimeoutMs);
  }

  private clearConnectWatchdog(): void {
    if (this.wsConnectTimer !== null) {
      clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
    }
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
    this.clearConnectWatchdog();
    this.wsConnected = false;
    this.wsConnecting = false;
    this.ws = null;
    // A handshake the core rejected for bad credentials (401/403) is terminal:
    // the token won't start working again, so stop here instead of scheduling
    // another doomed attempt. The UI surfaces "unauthorized" as a re-pair prompt.
    if (isAuthRejection(this.lastWsError)) {
      this.disconnectedAtMs = null;
      log.warn(
        `core rejected credentials (${this.lastWsError}); halting reconnect, re-pair required`,
      );
      this.setConnState("unauthorized", this.lastWsError ?? undefined);
      return;
    }
    // Log "disconnected" once per gap (the first close); the per-attempt
    // reconnect churn shows at debug below, so repeating it on every retry's
    // close would just be noise.
    const firstCloseOfGap = this.disconnectedAtMs === null;
    if (firstCloseOfGap) {
      this.disconnectedAtMs = Date.now();
      log.info(this.lastWsError ? `disconnected: ${this.lastWsError}` : "disconnected");
    }
    this.setConnState("disconnected", this.lastWsError ?? undefined);
    if (this.wsClosing || this.listeners.size === 0) return;
    if (this.wsReconnectTimer !== null) return; // a reconnect is already scheduled
    const delay = this.wsBackoffMs;
    this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, this.wsBackoffCapMs);
    log.debug(`reconnect in ${delay}ms`);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWs();
    }, delay);
  }
}

// True for a 2xx NetResponse.
function isOk(res: NetResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

// Whether a WS connect-failure reason is the core rejecting our credentials.
// The desktop net layer reports the handshake status as "HTTP 401"/"HTTP 403"
// (see commands/net.rs); a dead bearer token never recovers, so this gates the
// terminal "unauthorized" state. The browser WS transport hides the handshake
// status, so on web this never matches and the normal retry path is unchanged.
function isAuthRejection(reason: string | null | undefined): boolean {
  return !!reason && /\bHTTP (?:401|403)\b/.test(reason);
}

// Decode a NetResponse body (UTF-8 bytes) to text for JSON parsing.
function decodeBody(res: NetResponse): string {
  return new TextDecoder().decode(res.body);
}
