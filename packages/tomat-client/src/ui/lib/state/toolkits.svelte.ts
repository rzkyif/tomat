/**
 * Client-side toolkit registry: a reactive mirror of the core's installed
 * toolkits and a thin pass-through for the npm-search install flow. The core
 * now owns tool execution end-to-end (the LLM hop loop runs server-side), so
 * this module no longer dispatches tool calls or proxies the per-call WS
 * channel itself - it just:
 *
 *   - keeps `installed`, `searchResults`, and `installJobs` in sync from
 *     `cores().api().toolkits.*` REST calls and the `toolkit.*` /
 *     `tool.*` WS frames
 *   - exposes `findToolkitForTool` for any consumer that still wants to map a
 *     tool name to its owning toolkit
 *   - sends the two client-originating tool frames (`tool.askuser_response`
 *     and `tool.cancel`) through the active CoreClient
 *
 * The settings UI is the only writer; the chat-loop side just reads.
 */

import {
  BUILTIN_TOOLKIT_ID,
  type DownloadToolkitRequest,
  type Grant,
  type ServerToClientFrame,
  type Tool,
  type Toolkit,
  type ToolkitSearchResult,
} from "@tomat/shared";
import type { AskUserAnswer } from "$lib/shared/types";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";
import { messagesState } from "./messages.svelte";
import { streamingState } from "./streaming.svelte";

const log = getLogger("toolkits");

export type InstallJob = {
  /** Job id from `toolkits.download` / `installDeps` - identifies the stream. */
  id: string;
  /** Toolkit id the job is installing (may be unknown until install_done). */
  toolkitId: string;
  /** Display name used by the UI while the install runs; falls back to id. */
  label: string;
  lines: { stream: "stdout" | "stderr"; line: string }[];
  status: "running" | "done" | "failed";
};

class ToolkitsState {
  /** The flat list returned by `GET /api/v1/toolkits`. Replaces the old
   *  trusted/untrusted split - the new core treats every installed toolkit
   *  as trusted (the gate is now per-permission grants, not a global
   *  trust flag). */
  installed = $state<Toolkit[]>([]);
  searchResults = $state<ToolkitSearchResult[]>([]);
  /** Keyed by job id. The core's `toolkit.install_log` and `install_done`
   *  frames key off `jobId`, so we mirror that here. */
  installJobs = $state<Record<string, InstallJob>>({});
  /** Mirrors the active core's WS connection state. Read by the settings
   *  UI to show a placeholder when the install action would be a no-op. */
  wsConnected = $state<boolean>(false);
  /** Latest-version status per toolkit id, populated by `checkUpdates()`.
   *  Transient (session-only); drives the "Update available" badge + action and
   *  the `@update-available` filter. */
  updateStatus = $state<Record<string, { latestVersion: string | null; updateAvailable: boolean }>>(
    {},
  );

  /** Whether the built-in toolkit is currently installed. */
  get isBuiltinInstalled(): boolean {
    return this.installed.some((t) => t.id === BUILTIN_TOOLKIT_ID);
  }

  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeConn: (() => void) | null = null;
  private hydrated = false;

  /** Subscribe to the active core's WS feed and seed the installed list.
   *  Called from `+page.svelte` onMount (the spec talks about `attach()`).
   *  The CoreClient already handles reconnects internally; this method is
   *  idempotent so re-mounts don't double-subscribe. */
  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((f) => this.onFrame(f));
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      this.wsConnected = state === "connected";
      // First successful connection: hydrate the installed list. The CoreClient
      // emits "connected" on every reconnect too, so we re-fetch each time to
      // pick up anything that changed while we were offline.
      if (state === "connected") {
        void this.refresh().catch((err) => log.warn("hydrate on ws connect failed:", err));
      }
    });
    this.hydrated = true;
  }

  /** Backwards-compatible alias for the previous WS-bootstrap entry point.
   *  `+page.svelte` still calls `ensureConnected()`; rather than touch that
   *  file, we forward to `attach()`. */
  ensureConnected(): void {
    this.attach();
  }

  detach(): void {
    if (this.unsubscribeWs) {
      this.unsubscribeWs();
      this.unsubscribeWs = null;
    }
    if (this.unsubscribeConn) {
      this.unsubscribeConn();
      this.unsubscribeConn = null;
    }
    this.hydrated = false;
  }

  // --- WS frame routing --------------------------------------------------

  private onFrame(frame: ServerToClientFrame): void {
    switch (frame.kind) {
      case "toolkit.snapshot":
        void this.refresh().catch((err) => log.warn("refresh on snapshot failed:", err));
        return;
      case "toolkit.install_log": {
        const job = this.installJobs[frame.jobId];
        if (!job) return;
        job.lines.push({ stream: frame.stream, line: frame.line });
        // Cap per-job buffer so a runaway npm install (huge dependency tree,
        // npm warnings) can't pin arbitrary RSS on the webview.
        if (job.lines.length > 1000) {
          job.lines.splice(0, job.lines.length - 1000);
        }
        // Reassign the record so Svelte's $state proxy picks up the change
        // (mutating nested objects in-place isn't always tracked).
        this.installJobs = { ...this.installJobs, [frame.jobId]: { ...job } };
        return;
      }
      case "toolkit.install_done": {
        const job = this.installJobs[frame.jobId];
        if (job) {
          this.installJobs = {
            ...this.installJobs,
            [frame.jobId]: {
              ...job,
              status: frame.ok ? "done" : "failed",
              toolkitId: frame.id || job.toolkitId,
            },
          };
        }
        // A successful (re)install clears any stale update flag for that id so
        // the "Update available" badge/action disappears.
        if (frame.ok && frame.id && this.updateStatus[frame.id]) {
          const { [frame.id]: _gone, ...rest } = this.updateStatus;
          this.updateStatus = rest;
        }
        // Refresh so the new toolkit (or the failure state) is reflected.
        void this.refresh().catch((err) => log.warn("refresh after install failed:", err));
        return;
      }
      // tool.* frames are routed to messagesState by streaming.svelte.ts so
      // the active tool-call bubble updates. We don't need to mirror them
      // here - the spec calls out emitting via a per-callId emitter, but the
      // new arch has already moved that listener up into streaming/messages.
      default:
        return;
    }
  }

  // --- CRUD --------------------------------------------------------------

  /** Pull the latest toolkit list from the core. */
  async refresh(): Promise<void> {
    const list = await cores().api().toolkits.list();
    this.installed = list;
  }

  /** npm-registry search; results land in `searchResults`. Empty query
   *  clears the result list without a round-trip. */
  async search(q: string): Promise<void> {
    const trimmed = q.trim();
    if (!trimmed) {
      this.searchResults = [];
      return;
    }
    const res = await cores().api().toolkits.search(trimmed);
    this.searchResults = res.results;
  }

  /** Phase 1: download (acquire) a toolkit's files. Returns the job id so the
   *  caller can correlate it with a log panel. Optimistically registers an
   *  `InstallJob` row so the running indicator shows up immediately. The toolkit
   *  lands in status 'downloaded'; the user then calls installDeps. */
  async download(req: DownloadToolkitRequest): Promise<string> {
    const label =
      req.source === "npm"
        ? req.name
        : req.source === "builtin"
          ? BUILTIN_TOOLKIT_ID
          : (req.slug ?? req.path);
    const res = await cores().api().toolkits.download(req);
    this.registerJob(res.jobId, res.toolkitId, label);
    return res.jobId;
  }

  /** Phase 2: install a downloaded toolkit's deps + pin its hash. Registers a
   *  second streamed job; the install_log/install_done handling is phase-agnostic. */
  async installDeps(toolkitId: string): Promise<string> {
    const label = this.installed.find((t) => t.id === toolkitId)?.displayName || toolkitId;
    const res = await cores().api().toolkits.installDeps(toolkitId);
    this.registerJob(res.jobId, res.toolkitId, label);
    return res.jobId;
  }

  private registerJob(jobId: string, toolkitId: string, label: string): void {
    this.installJobs = {
      ...this.installJobs,
      [jobId]: { id: jobId, toolkitId, label, lines: [], status: "running" },
    };
  }

  async uninstall(id: string): Promise<void> {
    await cores().api().toolkits.delete(id);
    await this.refresh();
  }

  /** Download the built-in toolkit from the CDN (codebase in dev). */
  async downloadBuiltin(): Promise<string> {
    return await this.download({ source: "builtin" });
  }

  /** Update a toolkit to its latest version (npm registry or built-in CDN
   *  manifest). The core streams progress + a `toolkit.install_done` frame. */
  async updateToolkit(id: string): Promise<void> {
    await cores().api().toolkits.update(id);
  }

  /** Check installed toolkits for newer versions and store the result so the UI
   *  can flag + filter the updatable ones. */
  async checkUpdates(): Promise<void> {
    const { results } = await cores().api().toolkits.checkUpdates();
    const next: Record<string, { latestVersion: string | null; updateAvailable: boolean }> = {};
    for (const r of results) {
      next[r.id] = { latestVersion: r.latestVersion, updateAvailable: r.updateAvailable };
    }
    this.updateStatus = next;
  }

  /** Reconcile the core's toolkits directory with its registry (registers
   *  dropped-in folders, prunes removed ones). The core broadcasts
   *  `toolkit.snapshot`, so the installed list refreshes via onFrame. */
  async rescan(): Promise<{ added: number; updated: number; removed: number }> {
    return await cores().api().toolkits.rescan();
  }

  /** Recompute tool-relevance embeddings for every enabled tool. */
  async reindex(): Promise<{ embedded: number }> {
    return await cores().api().toolkits.reindex();
  }

  async enableTool(toolkitId: string, toolName: string): Promise<void> {
    await cores().api().toolkits.enableTool(toolkitId, toolName);
    await this.refreshTools(toolkitId);
  }

  async disableTool(toolkitId: string, toolName: string): Promise<void> {
    await cores().api().toolkits.disableTool(toolkitId, toolName);
    await this.refreshTools(toolkitId);
  }

  async enableAllTools(toolkitId: string): Promise<void> {
    await cores().api().toolkits.enableAllTools(toolkitId);
    await this.refreshTools(toolkitId);
  }

  async disableAllTools(toolkitId: string): Promise<void> {
    await cores().api().toolkits.disableAllTools(toolkitId);
    await this.refreshTools(toolkitId);
  }

  /** Re-pin the current on-disk content + clear the drift warning. Refresh so
   *  the toolkit returns to 'installed' with its (now disabled) tools shown. */
  async confirmReenable(toolkitId: string): Promise<void> {
    await cores().api().toolkits.confirmReenable(toolkitId);
    await this.refresh();
    await this.refreshTools(toolkitId);
  }

  /** Set grants for a single tool and refresh the toolkit's tool list so
   *  `missingRequired` reflects the new state immediately. Throws if the
   *  REST call fails (the UI shows the error inline). */
  async setGrants(
    toolkitId: string,
    toolName: string,
    grants: Array<{ key: string; state: Grant["state"] }>,
  ): Promise<void> {
    await cores().api().toolkits.setGrants(toolkitId, toolName, grants);
    await this.refreshTools(toolkitId);
  }

  /** Refresh the tools embedded inside a single toolkit row. The /toolkits
   *  list endpoint doesn't embed tools (per the spec: tools are nested via
   *  /toolkits/:id/tools), so after a mutation we splice the fresh tool
   *  list into the matching installed row. */
  private async refreshTools(toolkitId: string): Promise<void> {
    try {
      const { tools } = await cores().api().toolkits.listTools(toolkitId);
      const idx = this.installed.findIndex((t) => t.id === toolkitId);
      if (idx >= 0) {
        this.installed[idx] = { ...this.installed[idx], tools };
        this.installed = [...this.installed];
      }
    } catch (err) {
      log.warn(`tools refresh for ${toolkitId} failed:`, err);
    }
  }

  /** Load the full tool list for a toolkit so the per-tool UI can render.
   *  Public so the settings panel can lazy-load tools when the user expands
   *  a toolkit row. */
  async loadTools(toolkitId: string): Promise<Tool[]> {
    const { tools } = await cores().api().toolkits.listTools(toolkitId);
    const idx = this.installed.findIndex((t) => t.id === toolkitId);
    if (idx >= 0) {
      this.installed[idx] = { ...this.installed[idx], tools };
      this.installed = [...this.installed];
    }
    return tools;
  }

  // --- WS-frame senders --------------------------------------------------

  /** Send the user's askUser answers back to the worker. Mirrors the choice
   *  onto the local tool-call bubble so the UI flips out of "awaiting_user"
   *  immediately instead of waiting for the next progress frame. */
  respondAskUser(callId: string, requestId: string, answers: AskUserAnswer[]): void {
    cores().api().chat.respondAskUser(callId, requestId, answers);
    messagesState.recordToolCallAskUserAnswers(callId, answers);
  }

  /** Cancel a single tool call. */
  cancelToolCall(callId: string): void {
    cores().api().chat.cancelTool(callId);
  }

  /** Send cancel frames for every tool call bubble still in a non-terminal
   *  status. Wired into `streamingState.interruptStreaming()` so the global
   *  stop affordance in UserInput tears down running AND awaiting-user tool
   *  calls in one shot. */
  cancelAllActiveCalls(): void {
    for (const m of messagesState.messages) {
      const tc = m.toolCall;
      if (!tc) continue;
      if (tc.status === "pending" || tc.status === "running" || tc.status === "awaiting_user") {
        this.cancelToolCall(tc.callId);
      }
    }
  }

  // --- read-only helpers -------------------------------------------------

  /** Resolve the owning toolkit for a given tool name. Returns null if the
   *  tool isn't enabled in any installed toolkit. Used by the LLM hop loop
   *  (when one runs client-side) to associate a tool name with its toolkit
   *  id - the chat orchestration is now server-side, but we keep this for
   *  any UI code that still needs to look up a tool by name (e.g. drawing
   *  a label next to a pending tool call). */
  findToolkitForTool(toolName: string): { toolkitId: string; toolId: string } | null {
    for (const tk of this.installed) {
      if (tk.status !== "installed") continue;
      const tool = tk.tools?.find((t) => t.name === toolName && t.enabled);
      if (tool) return { toolkitId: tk.id, toolId: tool.id };
    }
    return null;
  }

  /** Back-compat shim for callers still using the legacy method name. */
  answerAskUser(callId: string, requestId: string, answers: AskUserAnswer[]): void {
    this.respondAskUser(callId, requestId, answers);
  }
}

export const toolkitsState = new ToolkitsState();

// Cancel every active tool call when the user interrupts streaming. Registered
// here so streaming.svelte doesn't have to import this module (toolkits already
// imports streamingState; one-way is the cycle-free shape).
streamingState.onInterrupt(() => toolkitsState.cancelAllActiveCalls());
