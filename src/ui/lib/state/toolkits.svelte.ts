/**
 * State and transport for the user's installed toolkits, the user-defined
 * tools the LLM can call. Tracks the trusted and untrusted toolkit lists,
 * keeps a WebSocket open to the sidecar for running tools and streaming
 * progress back into the chat, and exposes install-job state for the
 * settings UI.
 */

import { BUN_SIDECAR_HTTP_BASE_URL, BUN_SIDECAR_WS_BASE_URL } from "$lib/shared/network";
import type { AskUserAnswer, AskUserQuestion, ToolCallState } from "$lib/shared/types";
import { messagesState } from "./messages.svelte";

const BASE_URL = BUN_SIDECAR_HTTP_BASE_URL;
const WS_URL = `${BUN_SIDECAR_WS_BASE_URL}/ws/toolcall`;

export type ToolkitRow = {
  id: string;
  kind: "file" | "folder";
  entryPath: string;
  displayName: string | null;
  description: string | null;
  trusted: boolean;
  depsInstalled: boolean;
  hasPackage: boolean;
  enabled: boolean;
  lastError: string | null;
  tools: ToolRow[];
  /** Tools in this toolkit that have an embedding row in the sidecar.
   *  `< tools.length` means indexing isn't complete (e.g. embedding model
   *  was unavailable when the toolkit was enabled). Phase-1 vector search
   *  only finds tools whose embeddings exist. */
  embeddedToolCount: number;
};

export type ToolRow = {
  id: string;
  toolkitId: string;
  name: string;
  description: string;
  triggers: string[];
  parameters: Record<string, unknown>;
  fnExport: string;
  /** When true, this tool bypasses the relevance filter (provided the user
   *  has the "Always-Available Tools Bypass" toggle enabled). */
  alwaysAvailable: boolean;
};

export type UntrustedRow = {
  id: string;
  kind: "file" | "folder";
  entryPath: string;
  hasPackage: boolean;
};

export type ToolDescriptor = {
  id: string;
  toolkitId: string;
  name: string;
  description: string;
  score: number;
};

export type OpenAIToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type InstallJob = {
  id: string;
  lines: { stream: "stdout" | "stderr"; line: string }[];
  status: "running" | "done" | "failed";
};

type ToolEvent =
  | {
      kind: "progress";
      callId: string;
      progress: number;
      label?: string;
      description?: string;
    }
  | {
      kind: "ask_user_request";
      callId: string;
      requestId: string;
      questions: AskUserQuestion[];
    }
  | {
      kind: "log";
      callId: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
    }
  | { kind: "tool_result"; callId: string; result: unknown }
  | { kind: "tool_error"; callId: string; error: string }
  | { kind: "tool_cancelled"; callId: string };

class ToolkitsState {
  trusted = $state<ToolkitRow[]>([]);
  untrusted = $state<UntrustedRow[]>([]);
  /** Keyed by toolkit id. */
  installJobs = $state<Record<string, InstallJob>>({});
  /** When true, the UI shows a disabled state and a "waiting for sidecar"
   *  placeholder for WS-backed actions. */
  wsConnected = $state<boolean>(false);

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;
  private callEmitters = new Map<string, (ev: ToolEvent) => void>();
  /** Last known toolkitId per active callId (for routing askUser responses
   *  from the UI back into the right toolkit worker). */
  private callToolkit = new Map<string, string>();

  constructor() {
    // Auto-connect on first consumer, not here - `new WebSocket(...)` in a
    // module-level constructor would fire during SSR.

    // Register with messagesState so `interruptStreaming()` can stop every
    // active tool call without messagesState needing to import this module.
    messagesState.setToolCancelHandler(() => this.cancelAllActiveCalls());
  }

  async ensureConnected(): Promise<void> {
    if (typeof window === "undefined") return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (typeof window === "undefined") return;
    try {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.wsConnected = true;
        this.reconnectDelay = 500;
        // Hydrate the toolkit list as soon as the sidecar is reachable.
        // Without this, `trusted` stays empty until the user opens the Tools
        // settings tab, so the filter pipeline thinks the user has no
        // enabled toolkits even when they do (and the embeddings already
        // exist in SQLite from a previous session). Fires on every reconnect
        // too, so a sidecar restart re-syncs state automatically.
        void this.refresh().catch((err) =>
          console.warn("[toolkits] initial refresh on ws open failed:", err),
        );
      });
      ws.addEventListener("message", (ev) => {
        try {
          const raw = typeof ev.data === "string" ? ev.data : "";
          if (!raw) return;
          const frame = JSON.parse(raw);
          this.handleFrame(frame);
        } catch (err) {
          console.error("[toolkits] bad ws frame:", err);
        }
      });
      ws.addEventListener("close", () => {
        this.wsConnected = false;
        // Any tool calls waiting on this socket will never complete - the
        // sidecar's worker may have died with the connection. Fail them
        // explicitly so the UI can render a clear error instead of the
        // bubble spinning forever.
        const stranded = Array.from(this.callEmitters.entries());
        this.callEmitters.clear();
        for (const [callId, emit] of stranded) {
          try {
            emit({
              kind: "tool_error",
              callId,
              error: "lost connection to sidecar",
            });
          } catch (err) {
            console.error("[toolkits] stranded call cleanup failed:", err);
          }
        }
        // Mark any in-flight install jobs as failed too. The sidecar will
        // not resume them after a restart; the user needs to click Install
        // again.
        const nextJobs: Record<string, InstallJob> = {};
        for (const [jobId, job] of Object.entries(this.installJobs)) {
          nextJobs[jobId] = job.status === "running" ? { ...job, status: "failed" } : job;
        }
        this.installJobs = nextJobs;
        this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        // Let the close handler drive reconnect so we don't double-schedule.
      });
    } catch (err) {
      console.error("[toolkits] ws open failed:", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private handleFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const f = frame as { kind?: string; callId?: string; id?: string };
    if (f.kind === "install_log" && typeof f.id === "string") {
      const job = this.installJobs[f.id];
      if (job) {
        job.lines.push({
          stream: (frame as { stream: "stdout" | "stderr" }).stream,
          line: (frame as { line: string }).line,
        });
        // Cap per-job buffer so a runaway `bun install` (npm warnings on a
        // huge tree, for instance) can't pin arbitrary RSS on the webview.
        if (job.lines.length > 1000) {
          job.lines.splice(0, job.lines.length - 1000);
        }
        // Svelte reactivity on nested object mutation: reassign the whole
        // record so the $state proxy picks up the change.
        this.installJobs = { ...this.installJobs, [f.id]: job };
      }
      return;
    }
    if (f.kind === "install_done" && typeof f.id === "string") {
      const job = this.installJobs[f.id];
      if (job) {
        job.status = (frame as { ok: boolean }).ok ? "done" : "failed";
        this.installJobs = { ...this.installJobs, [f.id]: job };
      }
      // Refresh the toolkit list so the UI reflects deps_installed = 1.
      void this.refresh();
      return;
    }

    if (typeof f.callId !== "string") return;
    const emit = this.callEmitters.get(f.callId);
    if (emit) {
      emit(frame as ToolEvent);
    }
  }

  // --- API HTTP wrappers

  async refresh(): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/toolkits/scan`, { cache: "no-store" });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`scan failed (${res.status}): ${detail}`.trim());
    }
    const data = (await res.json()) as { trusted?: ToolkitRow[]; untrusted?: UntrustedRow[] };
    this.trusted = data.trusted ?? [];
    this.untrusted = data.untrusted ?? [];

    // If any enabled toolkit is missing embeddings (e.g. it was enabled
    // before the embedding model finished downloading, so the initial
    // refreshEmbeddingsFor silently bailed), kick off a backfill. The
    // sidecar no-ops if the model still isn't ready, so this is safe to
    // call eagerly and we'll re-attempt on the next refresh.
    const needsReindex = this.trusted.some(
      (t) => t.enabled && t.embeddedToolCount < t.tools.length,
    );
    if (needsReindex) {
      void this.reindex().catch((err) => console.warn("[toolkits] reindex failed:", err));
    }
  }

  /** Tell the sidecar to (re-)embed every enabled toolkit's tools. Refreshes
   *  the local row state when done so the UI picks up the new
   *  `embeddedToolCount`. Returns the number of tools that were newly
   *  embedded. */
  async reindex(): Promise<{ embedded: number; skipped: boolean }> {
    const res = await fetch(`${BASE_URL}/api/toolkits/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`reindex failed (${res.status}): ${detail}`.trim());
    }
    const data = (await res.json()) as { embedded: number; skipped: boolean };
    // Re-fetch scan so embeddedToolCount reflects the new state. Use a
    // direct fetch (not refresh) to avoid recursion.
    const scanRes = await fetch(`${BASE_URL}/api/toolkits/scan`, { cache: "no-store" });
    if (scanRes.ok) {
      const scan = (await scanRes.json()) as { trusted?: ToolkitRow[]; untrusted?: UntrustedRow[] };
      this.trusted = scan.trusted ?? [];
      this.untrusted = scan.untrusted ?? [];
    }
    return data;
  }

  /** After a state-mutating POST, re-fetch the scan and assert the expected
   *  row predicate held. Throws a loud error if the backend's reply didn't
   *  actually land. Covers "POST succeeded but state didn't change" gaps so
   *  the user always sees an alert instead of a no-op button. */
  private async assertAfter(
    id: string,
    label: string,
    predicate: (row: ToolkitRow | UntrustedRow | null) => boolean,
  ): Promise<void> {
    await this.refresh();
    const row =
      this.trusted.find((t) => t.id === id) ?? this.untrusted.find((u) => u.id === id) ?? null;
    if (!predicate(row)) {
      throw new Error(
        `${label} looked successful but the toolkit state didn't change (id "${id}"). Check sidecar logs.`,
      );
    }
  }

  async trust(id: string): Promise<void> {
    await this.post("/api/toolkits/trust", { id });
    await this.assertAfter(id, "trust", (row) => !!row && "trusted" in row && row.trusted === true);
  }

  async untrust(id: string): Promise<void> {
    await this.post("/api/toolkits/untrust", { id });
    await this.assertAfter(
      id,
      "untrust",
      (row) => !row || !("trusted" in row) || row.trusted === false,
    );
  }

  async remove(id: string): Promise<void> {
    await this.post("/api/toolkits/remove", { id });
    await this.refresh();
  }

  async install(id: string): Promise<void> {
    await this.ensureConnected();
    this.installJobs = {
      ...this.installJobs,
      [id]: { id, lines: [], status: "running" },
    };
    await this.post("/api/toolkits/install", { id });
  }

  async uninstallDeps(id: string): Promise<void> {
    await this.post("/api/toolkits/uninstall-deps", { id });
    await this.assertAfter(
      id,
      "uninstall dependencies",
      (row) => !!row && "depsInstalled" in row && row.depsInstalled === false,
    );
  }

  async enable(id: string): Promise<void> {
    await this.post("/api/toolkits/enable", { id });
    await this.assertAfter(
      id,
      "enable",
      (row) => !!row && "enabled" in row && row.enabled === true,
    );
  }

  async disable(id: string): Promise<void> {
    await this.post("/api/toolkits/disable", { id });
    await this.assertAfter(
      id,
      "disable",
      (row) => !!row && "enabled" in row && row.enabled === false,
    );
  }

  /** Ask the sidecar to boot every runnable trusted toolkit whose METADATA
   *  hasn't been cached yet and stash display_name / description. Then
   *  refresh so the UI picks up the new metadata. Called on settings open so
   *  users see names and descriptions for toolkits trusted in previous
   *  sessions (metadata is recomputed every cold start). */
  async refreshMissingMetadata(): Promise<void> {
    await this.post("/api/toolkits/refresh-metadata", {});
    await this.refresh();
  }

  hasEnabledTools(): boolean {
    // Require embedded tools, not just parsed-tool count. Phase-1 vector
    // search only finds tools whose embeddings exist in tool_embeddings,
    // so a toolkit that's enabled but indexed=0 contributes nothing.
    return this.trusted.some((t) => t.enabled && t.embeddedToolCount > 0);
  }

  /** Flat list of every tool from every enabled, trusted toolkit. Used when
   *  the relevance filter is bypassed (filtering disabled, or the total tool
   *  count is below the user's threshold). Excludes tools whose toolkit is
   *  disabled or untrusted. */
  allEnabledTools(): ToolRow[] {
    const out: ToolRow[] = [];
    for (const tk of this.trusted) {
      if (!tk.enabled) continue;
      for (const t of tk.tools) out.push(t);
    }
    return out;
  }

  /** Embed a user prompt (phase-1 relevance vector). Returns null when the
   *  sidecar's embedding model isn't ready yet. */
  async embed(text: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(`${BASE_URL}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: [text] }),
      });
      if (res.status === 503) return null;
      if (!res.ok) throw new Error(`embed failed (${res.status})`);
      const data = (await res.json()) as { vectors: number[][] };
      if (!Array.isArray(data.vectors) || data.vectors.length === 0) return null;
      return new Float32Array(data.vectors[0]);
    } catch (err) {
      console.warn("[toolkits] embed failed:", err);
      return null;
    }
  }

  async filter(vector: Float32Array, topK: number): Promise<ToolDescriptor[]> {
    try {
      const res = await fetch(`${BASE_URL}/api/toolkits/filter`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vector: Array.from(vector), topK }),
      });
      if (!res.ok) throw new Error(`filter failed (${res.status})`);
      const data = (await res.json()) as { candidates?: ToolDescriptor[] };
      return data.candidates ?? [];
    } catch (err) {
      console.warn("[toolkits] filter failed:", err);
      return [];
    }
  }

  async toolSchemas(ids: string[]): Promise<OpenAIToolDef[]> {
    if (ids.length === 0) return [];
    try {
      const res = await fetch(`${BASE_URL}/api/toolkits/tool-schemas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`tool-schemas failed (${res.status})`);
      const data = (await res.json()) as { tools?: OpenAIToolDef[] };
      return data.tools ?? [];
    } catch (err) {
      console.warn("[toolkits] tool-schemas failed:", err);
      return [];
    }
  }

  /** Resolve the owning toolkit id for a given tool name. Uses the trusted
   *  list (scan results). Returns null if unknown. */
  findToolkitForTool(toolName: string): { toolkitId: string; fnExport: string } | null {
    for (const tk of this.trusted) {
      if (!tk.enabled) continue;
      for (const t of tk.tools) {
        if (t.name === toolName) return { toolkitId: tk.id, fnExport: t.fnExport };
      }
    }
    return null;
  }

  /** Start a tool call. Returns a promise that resolves with the terminal
   *  result/error and a callback to forward askUser answers back. */
  async runToolCall(opts: {
    callId: string;
    toolkitId: string;
    toolName: string;
    argsRaw: string;
    chatContext: { userMessage: string; sessionId: string | null };
    onProgress?: (p: { progress: number; label?: string; description?: string }) => void;
    onAskUser?: (req: { requestId: string; questions: AskUserQuestion[] }) => void;
    onLog?: (line: { level: string; message: string }) => void;
  }): Promise<{ ok: boolean; result?: unknown; error?: string; cancelled?: boolean }> {
    await this.ensureConnected();
    this.callToolkit.set(opts.callId, opts.toolkitId);
    return new Promise((resolve) => {
      const cleanup = (res: {
        ok: boolean;
        result?: unknown;
        error?: string;
        cancelled?: boolean;
      }) => {
        this.callEmitters.delete(opts.callId);
        this.callToolkit.delete(opts.callId);
        resolve(res);
      };
      this.callEmitters.set(opts.callId, (ev) => {
        switch (ev.kind) {
          case "progress":
            opts.onProgress?.({
              progress: ev.progress,
              label: ev.label,
              description: ev.description,
            });
            break;
          case "ask_user_request":
            opts.onAskUser?.({ requestId: ev.requestId, questions: ev.questions });
            break;
          case "log":
            opts.onLog?.({ level: ev.level, message: ev.message });
            break;
          case "tool_result":
            cleanup({ ok: true, result: ev.result });
            break;
          case "tool_error":
            cleanup({ ok: false, error: ev.error });
            break;
          case "tool_cancelled":
            cleanup({ ok: false, cancelled: true });
            break;
        }
      });
      this.sendFrame({
        kind: "start",
        callId: opts.callId,
        toolkitId: opts.toolkitId,
        toolName: opts.toolName,
        arguments: opts.argsRaw,
        chatContext: opts.chatContext,
      });
    });
  }

  answerAskUser(callId: string, requestId: string, answers: AskUserAnswer[]): void {
    this.sendFrame({ kind: "ask_user_response", callId, requestId, answers });
    messagesState.recordToolCallAskUserAnswers(callId, answers);
  }

  cancelCall(callId: string): void {
    this.sendFrame({ kind: "cancel", callId });
  }

  /** Send cancel frames for every tool call bubble still in a non-terminal
   *  status. Wired into `messagesState.interruptStreaming()` so the global
   *  stop affordance in UserInput tears down running AND awaiting-user tool
   *  calls in one shot. */
  cancelAllActiveCalls(): void {
    for (const m of messagesState.messages) {
      const tc = m.toolCall;
      if (!tc) continue;
      if (tc.status === "pending" || tc.status === "running" || tc.status === "awaiting_user") {
        this.cancelCall(tc.callId);
      }
    }
  }

  /** Helper to kick off a tool call AND wire it into messagesState's bubble
   *  in one shot. Used by the llm.ts tool-call loop. */
  async dispatchToolCall(params: {
    toolCallId: string;
    toolName: string;
    argsRaw: string;
    chatContext: { userMessage: string; sessionId: string | null };
  }): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
    cancelled?: boolean;
    toolCallId: string;
  }> {
    const resolved = this.findToolkitForTool(params.toolName);
    if (!resolved) {
      return {
        ok: false,
        error: `tool "${params.toolName}" is not enabled`,
        toolCallId: params.toolCallId,
      };
    }
    const callId = `${params.toolCallId}-${Math.random().toString(36).slice(2, 8)}`;
    let parsedArgs: Record<string, unknown> = {};
    try {
      const v = JSON.parse(params.argsRaw);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsedArgs = v as Record<string, unknown>;
      }
    } catch {
      /* leave empty */
    }
    const tcState: ToolCallState = {
      callId,
      toolCallId: params.toolCallId,
      toolkitId: resolved.toolkitId,
      toolName: params.toolName,
      arguments: parsedArgs,
      status: "running",
      logs: [],
    };
    messagesState.appendToolCall(tcState);

    const outcome = await this.runToolCall({
      callId,
      toolkitId: resolved.toolkitId,
      toolName: params.toolName,
      argsRaw: params.argsRaw,
      chatContext: params.chatContext,
      onProgress: (p) =>
        messagesState.updateToolCall(callId, {
          status: "running",
          progress: p.progress,
          label: p.label,
          description: p.description,
        }),
      onAskUser: (r) => messagesState.setToolCallAskUser(callId, r.requestId, r.questions),
      onLog: (l) =>
        messagesState.appendToolCallLog(callId, {
          level: l.level as "debug" | "info" | "warn" | "error",
          message: l.message,
          ts: Date.now(),
        }),
    });

    if (outcome.ok) {
      messagesState.resolveToolCall(callId, { result: outcome.result });
    } else if (outcome.cancelled) {
      messagesState.resolveToolCall(callId, { cancelled: true });
    } else {
      messagesState.resolveToolCall(callId, { error: outcome.error });
    }
    return { ...outcome, toolCallId: params.toolCallId };
  }

  private sendFrame(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Defer - tryConnect and re-send once open. Keep it simple: log and
      // drop; the round-trip will surface as a tool error from the server.
      console.warn("[toolkits] ws not open; frame dropped");
      void this.ensureConnected();
      return;
    }
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      console.error("[toolkits] ws send failed:", err);
    }
  }

  private async post(pathname: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        /* ignore */
      }
      throw new Error(`${pathname} failed (${res.status}): ${detail}`);
    }
    return res.json();
  }
}

export const toolkitsState = new ToolkitsState();
