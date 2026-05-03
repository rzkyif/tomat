import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LRUCache } from "lru-cache";
import Ajv, { type ValidateFunction } from "ajv";
import { httpError } from "../httpError";
import type { ToolkitsRegistry } from "./registry";
import { deriveStatus, toolRecordToPublic } from "./registry";
import { scanToolkitsDir } from "./scanner";
import { computeContentHash, hashEmbeddingSource } from "./hash";
import { embedTexts, cosine, vectorFromBlob, isEmbeddingModelReady } from "./embed";
import { runBunInstall, type InstallEvent } from "./installer";
import { uninstallDeps } from "./uninstaller";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  WorkerPool,
  type ToolCallEvent,
} from "./worker/pool";
import type {
  ClientToHostFrame,
  HostToClientFrame,
  OpenAIToolDef,
  ScanResult,
  ToolDescriptor,
  ToolkitMetadata,
} from "./types";

export const TOOLKITS_DIR = path.join(os.homedir(), ".tomat", "toolkits");

export interface ServiceOptions {
  registry: ToolkitsRegistry;
  workerScriptUrl: string | URL;
  /** Resolver for mutable runtime settings (max workers, idle ms, scripts).
   *  Reads from the persisted app settings file. */
  readSettings: () => {
    maxWarmWorkers: number;
    workerIdleMs: number;
    callTimeoutMs: number;
    ignorePostinstallScripts: boolean;
  };
}

interface InstallJobEntry {
  id: string;
  toolkitId: string;
  started: number;
  done: boolean;
  ok: boolean;
  code: number;
  logs: InstallEvent[];
}

export class ToolkitsService {
  readonly registry: ToolkitsRegistry;
  readonly pool: WorkerPool;
  private readSettings: ServiceOptions["readSettings"];
  private installJobs = new Map<string, InstallJobEntry>();
  /** Every connected WS client. Outgoing frames are broadcast to all because
   *  we expect a single webview client anyway. */
  private wsSubs = new Set<(frame: HostToClientFrame) => void>();
  private embeddingMissingWarned = false;
  /** Cache: toolkitId -> last verified hash + mtime (for fast re-verify).
   *  Bounded by LRU; cap is refreshed against the pool's maxWarmWorkers
   *  setting each time the pool limits update (`syncCacheLimits`). */
  private hashVerifiedCache: LRUCache<string, { mtimeMs: number; hash: string }>;
  /** Compiled JSON Schema validators per tool id (toolkitId:name). Ajv's
   *  compile() is ~0.1ms but per-turn calls shouldn't pay for it repeatedly.
   *  Evicted wholesale on disable/untrust via `invalidateValidatorsFor`. */
  private validatorCache: LRUCache<string, ValidateFunction>;
  private ajv: Ajv;
  /** Exact routing: callId -> toolkitId for every in-flight tool call. Used
   *  by ask_user_response and cancel frames instead of broadcasting to
   *  every warm worker. */
  private callIdToToolkit = new Map<string, string>();

  constructor(opts: ServiceOptions) {
    this.registry = opts.registry;
    this.readSettings = opts.readSettings;
    const s = opts.readSettings();
    const maxWarmWorkers = clampPositive(s.maxWarmWorkers, 8);
    this.pool = new WorkerPool({
      workerScriptUrl: opts.workerScriptUrl,
      maxWarmWorkers,
      workerIdleMs: clampNonNegative(s.workerIdleMs, 300000),
      callTimeoutMs: clampNonNegative(s.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
      drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    });
    this.hashVerifiedCache = new LRUCache({ max: Math.max(8, maxWarmWorkers * 2) });
    // Tools-per-toolkit can easily hit single digits, so size the validator
    // cache by maxWarmWorkers * 16 (generous cushion). This is purely a hot
    // path optimization; a miss just recompiles the schema.
    this.validatorCache = new LRUCache({ max: Math.max(32, maxWarmWorkers * 16) });
    this.ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });
  }

  subscribeWs(emit: (frame: HostToClientFrame) => void): () => void {
    this.wsSubs.add(emit);
    return () => this.wsSubs.delete(emit);
  }

  /** Worker pool health snapshot, exposed to `/api/health`. */
  poolStats(): { warmWorkers: number; maxWarmWorkers: number; inFlightCalls: number } {
    return this.pool.stats();
  }

  handleClientFrame(frame: ClientToHostFrame, emit: (f: HostToClientFrame) => void): void {
    switch (frame.kind) {
      case "start":
        void this.startCall(frame, emit);
        break;
      case "ask_user_response":
        this.forwardAskUserResponse(frame.callId, frame.requestId, frame.answers);
        break;
      case "cancel":
        this.cancelCall(frame.callId);
        break;
    }
  }

  private broadcast(frame: HostToClientFrame): void {
    for (const s of this.wsSubs) {
      try {
        s(frame);
      } catch (err) {
        console.error("[toolkits] ws subscriber error:", err);
      }
    }
  }

  private refreshPoolLimits(): void {
    const s = this.readSettings();
    const maxWarmWorkers = clampPositive(s.maxWarmWorkers, 8);
    this.pool.updateLimits({
      maxWarmWorkers,
      workerIdleMs: clampNonNegative(s.workerIdleMs, 300000),
      callTimeoutMs: clampNonNegative(s.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
    });
    // Grow the hash + validator caches alongside the pool so a user who
    // bumps maxWarmWorkers doesn't thrash either cache. lru-cache v11 has
    // no in-place resize, so rebuild when `max` changes. This path only
    // fires when the user toggles `toolkits.maxWarmWorkers`, so the
    // rebuild cost is negligible.
    const hashMax = Math.max(8, maxWarmWorkers * 2);
    const validatorMax = Math.max(32, maxWarmWorkers * 16);
    if (hashMax !== this.hashVerifiedCache.max) {
      this.hashVerifiedCache = rebuildLRU(this.hashVerifiedCache, hashMax);
    }
    if (validatorMax !== this.validatorCache.max) {
      this.validatorCache = rebuildLRU(this.validatorCache, validatorMax);
    }
  }

  /** Compile (or return cached) a JSON Schema validator for a tool's
   *  `parameters` schema. Returns null when the schema itself is broken -
   *  callers should treat null as "skip validation" rather than as failure,
   *  since a bad schema is the toolkit author's bug, not a user-facing one. */
  private getValidator(toolId: string, schemaJson: string): ValidateFunction | null {
    const cached = this.validatorCache.get(toolId);
    if (cached) return cached;
    let schema: unknown;
    try {
      schema = JSON.parse(schemaJson);
    } catch {
      return null;
    }
    if (!schema || typeof schema !== "object") return null;
    try {
      const fn = this.ajv.compile(schema as Record<string, unknown>);
      this.validatorCache.set(toolId, fn);
      return fn;
    } catch (err) {
      console.warn(`[toolkits] invalid parameters schema for ${toolId}:`, err);
      return null;
    }
  }

  /** Drop compiled validators for every tool owned by a toolkit. Called when
   *  the toolkit is disabled / re-enabled / untrusted / removed so stale
   *  validators (built from a previous METADATA) don't leak. */
  private invalidateValidatorsFor(toolkitId: string): void {
    const prefix = `${toolkitId}:`;
    for (const key of this.validatorCache.keys()) {
      if (key.startsWith(prefix)) this.validatorCache.delete(key);
    }
  }

  scan(): ScanResult {
    ensureToolkitsDir();
    return scanToolkitsDir(this.registry, TOOLKITS_DIR);
  }

  /** Move an untrusted toolkit into the 'disabled' state and pin the current
   *  content hash. `node_modules` and `bun.lock` are excluded from the hash
   *  (see hash.ts), so the value is stable across the install lifecycle.
   *  For toolkits that can boot without `bun install`, the METADATA is read
   *  inline so the response already carries display_name + description. */
  async trust(id: string): Promise<{ ok: boolean; hasPackage: boolean; depsInstalled: boolean }> {
    ensureToolkitsDir();
    this.scan(); // make sure the row reflects current disk state
    const rec = this.registry.getToolkit(id);
    if (!rec) throw httpError(404, `toolkit "${id}" not found`);

    const hash = computeContentHash(rec.entry_path, rec.kind);
    this.registry.trust(id, hash);

    const { hasDeps, depsInstalled } = deriveStatus(rec.entry_path, rec.kind);

    // Folder-with-deps-but-not-installed toolkits can't boot yet; they get
    // their metadata populated after install-deps completes instead.
    if (!hasDeps || depsInstalled) {
      await this.extractMetadata(id);
    }

    return { ok: true, hasPackage: hasDeps, depsInstalled };
  }

  /** Boot the worker, read METADATA (name + description), persist it on the
   *  toolkit row, then tear the worker down. Used by trust() and the
   *  install-deps completion path so the UI can show a toolkit's title and
   *  description as soon as it's runnable, without having to enable it first.
   *
   *  Never throws: failures are logged to `lastError` and the row is left
   *  with null display_name/description. */
  /** For every trusted toolkit whose METADATA hasn't been cached yet (and
   *  which is runnable, deps installed if it has any), boot the worker to
   *  read it. Folder-with-deps-but-not-installed toolkits are skipped. Runs
   *  serially to keep worker memory bounded. */
  async refreshMissingMetadata(): Promise<void> {
    for (const rec of this.registry.listToolkits()) {
      if (rec.state === "untrusted") continue;
      if (rec.display_name !== null && rec.description !== null) continue;
      const { hasDeps, depsInstalled } = deriveStatus(rec.entry_path, rec.kind);
      if (hasDeps && !depsInstalled) continue;
      await this.extractMetadata(rec.id);
    }
  }

  async extractMetadata(id: string): Promise<void> {
    const rec = this.registry.getToolkit(id);
    if (!rec || rec.state === "untrusted") return;
    const { hasDeps, depsInstalled } = deriveStatus(rec.entry_path, rec.kind);
    if (hasDeps && !depsInstalled) return;
    this.refreshPoolLimits();
    try {
      const metadata = await this.pool.ensureReady(id, rec.entry_path);
      this.registry.setMetadata(id, {
        displayName: metadata.name,
        description: metadata.description,
      });
      this.registry.setLastError(id, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.setLastError(id, `metadata extraction failed: ${msg}`);
    } finally {
      await this.pool.terminate(id).catch(() => {});
    }
  }

  /** Clear trust. Disables, uninstalls deps on disk, drops metadata, wipes
   *  tools + embeddings. The row itself is kept. */
  async untrust(id: string): Promise<void> {
    await this.disable(id);
    const rec = this.registry.getToolkit(id);
    if (!rec) return;
    const { depsInstalled } = deriveStatus(rec.entry_path, rec.kind);
    if (rec.kind === "folder" && depsInstalled) {
      uninstallDeps(path.dirname(rec.entry_path), TOOLKITS_DIR);
    }
    this.registry.clearTrust(id);
    this.hashVerifiedCache.delete(id);
  }

  /** Delete the DB row entirely (user clicked Remove). Leaves files on disk. */
  async remove(id: string): Promise<void> {
    const rec = this.registry.getToolkit(id);
    if (!rec) return;
    if (rec.state !== "untrusted") {
      // Guard: Remove should only run after untrust. Surface it so the UI
      // can present a confirm flow instead of silently wiping state.
      throw httpError(400, "cannot remove a trusted toolkit; untrust first");
    }
    await this.pool.terminate(id);
    this.registry.deleteToolkit(id);
    this.hashVerifiedCache.delete(id);
    this.invalidateValidatorsFor(id);
  }

  /** Kick off `bun install` in the toolkit folder. Returns a job id; logs
   *  + completion stream over the WS channel under that id. */
  startInstall(id: string): { jobId: string } {
    const rec = this.registry.getToolkit(id);
    if (!rec) throw httpError(404, `toolkit "${id}" not found`);
    if (rec.state === "untrusted") throw httpError(400, "toolkit is not trusted");
    if (rec.kind !== "folder") throw httpError(400, "only folder toolkits have dependencies");
    const { hasDeps } = deriveStatus(rec.entry_path, rec.kind);
    if (!hasDeps) throw httpError(400, "toolkit has no dependencies");

    const jobId = `${id}:${Date.now().toString(36)}`;
    const job: InstallJobEntry = {
      id,
      toolkitId: id,
      started: Date.now(),
      done: false,
      ok: false,
      code: -1,
      logs: [],
    };
    this.installJobs.set(jobId, job);

    const folder = path.dirname(rec.entry_path);
    const ignoreScripts = this.readSettings().ignorePostinstallScripts !== false;

    // Fire and forget - streams events via WS broadcasts.
    void (async () => {
      try {
        const outcome = await runBunInstall(folder, { ignoreScripts }, (ev) => {
          job.logs.push(ev);
          if (job.logs.length > 1000) job.logs.shift();
          this.broadcast({
            kind: "install_log",
            id,
            stream: ev.stream,
            line: ev.line,
          });
        });
        job.done = true;
        job.ok = outcome.ok;
        job.code = outcome.code;
        if (outcome.ok) {
          // Now that deps are in place, boot the toolkit once to populate
          // display name + description so the UI shows them without requiring
          // the user to enable it first. The content hash is pinned at trust
          // time and unaffected by bun install (node_modules + bun.lock are
          // excluded from the hash), so there's nothing to recompute here.
          void this.extractMetadata(id);
        }
        this.broadcast({ kind: "install_done", id, ok: outcome.ok, code: outcome.code });
      } catch (err) {
        job.done = true;
        job.ok = false;
        job.code = -1;
        const line = err instanceof Error ? err.message : String(err);
        this.broadcast({ kind: "install_log", id, stream: "stderr", line });
        this.broadcast({ kind: "install_done", id, ok: false, code: -1 });
      }
    })();

    return { jobId };
  }

  async uninstallToolkitDeps(id: string): Promise<void> {
    const rec = this.registry.getToolkit(id);
    if (!rec) throw httpError(404, `toolkit "${id}" not found`);
    if (rec.kind !== "folder") return;
    // Disable first so the worker (if any) doesn't have node_modules yanked
    // out from under it mid-execution.
    await this.disable(id);
    uninstallDeps(path.dirname(rec.entry_path), TOOLKITS_DIR);
    this.hashVerifiedCache.delete(id);
  }

  /** Import the toolkit (verifying hash first), read METADATA, upsert tools
   *  and embeddings, and mark it enabled. Does NOT keep the worker alive -
   *  it's terminated after boot so dormant enabled toolkits stay cheap. */
  async enable(id: string): Promise<{
    metadata: ToolkitMetadata;
    tools: ReturnType<typeof toolRecordToPublic>[];
  }> {
    const rec = this.registry.getToolkit(id);
    if (!rec) throw httpError(404, `toolkit "${id}" not found`);
    if (rec.state === "untrusted") throw httpError(400, "toolkit is not trusted");
    const { hasDeps, depsInstalled } = deriveStatus(rec.entry_path, rec.kind);
    if (hasDeps && !depsInstalled) {
      throw httpError(400, "install dependencies first");
    }
    this.verifyHashOrFail(id);

    this.refreshPoolLimits();
    let metadata: ToolkitMetadata;
    try {
      metadata = await this.pool.ensureReady(id, rec.entry_path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.setLastError(id, msg);
      throw httpError(500, `failed to load toolkit: ${msg}`);
    }

    // Validate METADATA: tool names are the identifier the LLM sees and must
    // be unique (within the toolkit AND across all currently-enabled
    // toolkits). Also check the JSON-Schema-safe character set OpenAI
    // accepts - the server would 400 otherwise and we'd surface a confusing
    // error mid-turn instead of here.
    const tools = metadata.tools ?? [];
    const seen = new Set<string>();
    for (const t of tools) {
      if (typeof t.name !== "string" || !t.name) {
        throw httpError(400, "METADATA.tools contains a tool with no name");
      }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) {
        throw httpError(
          400,
          `tool name "${t.name}" must match ^[a-zA-Z0-9_-]{1,64}$ (OpenAI tool spec)`,
        );
      }
      if (seen.has(t.name)) {
        throw httpError(400, `duplicate tool name within toolkit: "${t.name}"`);
      }
      seen.add(t.name);
      if (typeof t.function !== "string" || !t.function) {
        throw httpError(400, `tool "${t.name}" is missing the function export name`);
      }
    }

    // Cross-toolkit collision check. Look at currently-enabled toolkits
    // (excluding this one, since we're about to replace its own tools).
    const otherTools = this.registry.listToolsForEnabled().filter((t) => t.toolkit_id !== id);
    const otherNames = new Map(otherTools.map((t) => [t.name, t.toolkit_id] as const));
    for (const t of tools) {
      const owner = otherNames.get(t.name);
      if (owner !== undefined) {
        throw httpError(
          409,
          `tool name "${t.name}" collides with enabled toolkit "${owner}". Disable that toolkit first.`,
        );
      }
    }

    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJson: JSON.stringify(t.parameters ?? {}),
      triggersJson: JSON.stringify(t.triggers ?? []),
      fnExport: t.function,
      alwaysAvailable: !!t.alwaysAvailable,
    }));
    // Drop any cached validators for the OLD tool set before we swap rows.
    // A tool that kept its name but whose parameters schema was edited
    // would otherwise hit a stale compiled validator.
    this.invalidateValidatorsFor(id);
    const toolRecs = this.registry.replaceTools(id, toolDefs);

    this.registry.setMetadata(id, {
      displayName: metadata.name,
      description: metadata.description,
    });
    this.registry.enable(id, JSON.stringify(metadata));

    // Compute embeddings for tools whose description+triggers changed or
    // have never been embedded. Any failure here does NOT un-enable the
    // toolkit - it just means phase-1 relevance falls back to "no match"
    // for that tool until the embedding model is available.
    await this.refreshEmbeddingsFor(toolRecs).catch((err) => {
      console.warn("[toolkits] embedding refresh failed:", err);
    });

    // Worker is no longer needed for this flow; the next tool call will
    // respawn it lazily if the user sends a prompt that routes here.
    await this.pool.terminate(id);

    return {
      metadata,
      tools: toolRecs.map(toolRecordToPublic),
    };
  }

  async disable(id: string): Promise<void> {
    const rec = this.registry.getToolkit(id);
    if (!rec) return;
    await this.pool.terminate(id);
    this.registry.disable(id);
    this.invalidateValidatorsFor(id);
  }

  async refreshEmbeddingsFor(
    toolRecs: ReturnType<typeof this.registry.replaceTools>,
  ): Promise<void> {
    if (!isEmbeddingModelReady()) {
      if (!this.embeddingMissingWarned) {
        console.warn("[toolkits] embedding model not ready; skipping embedding refresh");
        this.embeddingMissingWarned = true;
      }
      return;
    }

    const toEmbed: { toolId: string; text: string; sourceHash: string }[] = [];
    for (const rec of toolRecs) {
      const triggers = safeParseArray(rec.triggers_json);
      const sourceHash = hashEmbeddingSource(rec.description, triggers);
      const existing = this.registry.getEmbedding(rec.id);
      if (existing && existing.source_hash === sourceHash) continue;
      const text = [rec.description, ...triggers].join("\n");
      toEmbed.push({ toolId: rec.id, text, sourceHash });
    }

    if (toEmbed.length === 0) return;
    const vectors = await embedTexts(toEmbed.map((t) => t.text));
    for (let i = 0; i < toEmbed.length; i++) {
      const v = vectors[i];
      this.registry.upsertEmbedding(toEmbed[i].toolId, v.length, v, toEmbed[i].sourceHash);
    }
    // Reset the warn-once latch so a subsequent disable→enable that runs
    // before the model is ready can warn again.
    this.embeddingMissingWarned = false;
  }

  /** Re-run embedding for every enabled toolkit. Used to backfill the
   *  embeddings of toolkits that were enabled before the embedding model
   *  finished downloading. `refreshEmbeddingsFor` silently bails when the
   *  model isn't ready, so those toolkits sit in "enabled, zero embeddings"
   *  until the user manually triggers re-indexing. */
  async reindexEnabled(): Promise<{ embedded: number; skipped: boolean }> {
    if (!isEmbeddingModelReady()) {
      return { embedded: 0, skipped: true };
    }
    const allTools = this.registry.listToolsForEnabled();
    if (allTools.length === 0) return { embedded: 0, skipped: false };
    const before = allTools.filter((t) => !this.registry.getEmbedding(t.id)).length;
    await this.refreshEmbeddingsFor(allTools);
    return { embedded: before, skipped: false };
  }

  /** Given a query vector, return the top K most-similar enabled tools. */
  phase1Filter(queryVec: Float32Array, topK: number): ToolDescriptor[] {
    const rows = this.registry.listEmbeddingsForEnabled();
    const scored: ToolDescriptor[] = rows.map((r) => {
      const v = vectorFromBlob(r.vector);
      return {
        id: r.tool_id,
        toolkitId: r.toolkit_id,
        name: r.name,
        description: r.description,
        score: cosine(queryVec, v),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  /** Convert a list of tool ids (previously returned by phase1Filter) into
   *  the exact OpenAI tool schema the LLM expects. Order of `ids` is
   *  preserved. */
  toolSchemasFor(ids: string[]): OpenAIToolDef[] {
    const recs = this.registry.listToolsByIds(ids);
    const byId = new Map(recs.map((r) => [r.id, r] as const));
    const out: OpenAIToolDef[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      out.push({
        type: "function",
        function: {
          name: r.name,
          description: r.description,
          parameters: safeParseObject(r.parameters_json),
        },
      });
    }
    return out;
  }

  /** Verify the on-disk hash matches the one stored at trust/install time.
   *  On mismatch, auto-untrust and throw so callers surface the error. */
  verifyHashOrFail(id: string): void {
    const rec = this.registry.getToolkit(id);
    if (!rec) throw httpError(404, `toolkit "${id}" not found`);
    if (rec.content_hash === null) return; // no hash pinned; nothing to verify
    const folder = rec.kind === "folder" ? path.dirname(rec.entry_path) : rec.entry_path;
    const freshMtime = freshestMtime(folder);
    const cached = this.hashVerifiedCache.get(id);
    if (cached && cached.mtimeMs === freshMtime && cached.hash === rec.content_hash) {
      return;
    }
    const actual = computeContentHash(rec.entry_path, rec.kind as "file" | "folder");
    if (actual === rec.content_hash) {
      this.hashVerifiedCache.set(id, { mtimeMs: freshMtime, hash: actual });
      return;
    }
    // Mismatch: downgrade to untrusted.
    this.registry.clearTrust(id);
    this.registry.setLastError(id, "Content changed after trust - re-trust required");
    this.hashVerifiedCache.delete(id);
    void this.pool.terminate(id);
    throw httpError(409, "Content changed after trust - re-trust required");
  }

  /** Verify every currently-enabled toolkit at sidecar startup. Stale or
   *  tampered toolkits get auto-untrusted before they can run. */
  verifyAllOnBoot(): void {
    for (const rec of this.registry.listToolkits()) {
      if (rec.state !== "enabled") continue;
      try {
        this.verifyHashOrFail(rec.id);
      } catch (err) {
        console.warn(`[toolkits] boot verify failed for ${rec.id}:`, err);
      }
    }
  }

  // --- tool-call routing

  private async startCall(
    frame: Extract<ClientToHostFrame, { kind: "start" }>,
    _emit: (f: HostToClientFrame) => void,
  ): Promise<void> {
    if (this.callIdToToolkit.has(frame.callId)) {
      // Duplicate start for an already-running call. Happens if the client
      // retries mid-flight; ignore rather than spawning a parallel invocation
      // that would race for the same bubble.
      return;
    }

    const rec = this.registry.getToolkit(frame.toolkitId);
    if (!rec || rec.state !== "enabled") {
      this.broadcast({
        kind: "tool_error",
        callId: frame.callId,
        error: "toolkit is not enabled",
      });
      return;
    }
    const tool = this.registry.getTool(frame.toolkitId, frame.toolName);
    if (!tool) {
      this.broadcast({
        kind: "tool_error",
        callId: frame.callId,
        error: `unknown tool "${frame.toolName}"`,
      });
      return;
    }

    // Validate the LLM-emitted arguments against the tool's declared JSON
    // Schema before we spawn / wake a worker. Small local models routinely
    // produce malformed arguments; failing fast here means the bubble gets a
    // clean, machine-readable error the LLM can often self-correct from on
    // the next hop. We deliberately parse into JS objects *before*
    // validation so defaults can be filled in and the parsed form can be
    // re-serialized for the worker below.
    const validator = this.getValidator(tool.id, tool.parameters_json);
    let parsedArgs: unknown = {};
    if (frame.arguments && frame.arguments.length > 0) {
      try {
        parsedArgs = JSON.parse(frame.arguments);
      } catch {
        this.broadcast({
          kind: "tool_error",
          callId: frame.callId,
          error: `arguments must be valid JSON (got ${frame.arguments.slice(0, 80)})`,
        });
        return;
      }
    }
    if (validator) {
      const ok = validator(parsedArgs);
      if (!ok) {
        // ajv.errorsText is compact and readable. Strip the leading "data"
        // prefix ajv adds (the caller doesn't need to know it's called
        // "data" internally).
        const raw = this.ajv.errorsText(validator.errors, { separator: "; " });
        const msg = raw.replace(/\bdata\b/g, "arguments");
        this.broadcast({
          kind: "tool_error",
          callId: frame.callId,
          error: `tool arguments failed validation: ${msg}`,
        });
        return;
      }
    }

    try {
      this.verifyHashOrFail(frame.toolkitId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcast({ kind: "tool_error", callId: frame.callId, error: msg });
      return;
    }

    this.refreshPoolLimits();
    try {
      await this.pool.ensureReady(frame.toolkitId, rec.entry_path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.setLastError(frame.toolkitId, msg);
      this.broadcast({ kind: "tool_error", callId: frame.callId, error: msg });
      return;
    }

    // Forward the post-validation object - ajv's `useDefaults` option may
    // have filled in schema-declared defaults on parsedArgs, so the worker
    // should see the normalized form rather than the raw LLM string.
    const argumentsForWorker = JSON.stringify(parsedArgs ?? {});

    this.callIdToToolkit.set(frame.callId, frame.toolkitId);
    try {
      await this.pool.runCall(rec.entry_path, {
        callId: frame.callId,
        toolkitId: frame.toolkitId,
        toolName: frame.toolName,
        fnExport: tool.fn_export,
        arguments: argumentsForWorker,
        chatContext: frame.chatContext ?? { userMessage: "", sessionId: null },
        onEvent: (ev) => this.onWorkerEvent(ev),
      });
    } finally {
      this.callIdToToolkit.delete(frame.callId);
    }
  }

  private onWorkerEvent(ev: ToolCallEvent): void {
    switch (ev.kind) {
      case "progress":
        this.broadcast({
          kind: "progress",
          callId: ev.callId,
          progress: ev.progress ?? 0,
          label: ev.label,
          description: ev.description,
        });
        break;
      case "ask_user_request":
        this.broadcast({
          kind: "ask_user_request",
          callId: ev.callId,
          requestId: ev.requestId ?? "",
          questions: ev.questions ?? [],
        });
        break;
      case "log":
        this.broadcast({
          kind: "log",
          callId: ev.callId,
          level: ev.level ?? "info",
          message: ev.message ?? "",
        });
        break;
      case "tool_result":
        this.broadcast({ kind: "tool_result", callId: ev.callId, result: ev.result });
        break;
      case "tool_error":
        this.broadcast({
          kind: "tool_error",
          callId: ev.callId,
          error: ev.error ?? "tool failed",
        });
        break;
    }
  }

  private forwardAskUserResponse(
    callId: string,
    requestId: string,
    answers: (string | string[])[],
  ): void {
    const toolkitId = this.callIdToToolkit.get(callId);
    if (!toolkitId) {
      // Call has already terminated or was never started here. Silently
      // drop - re-sending an answer to a dead call is a no-op, not an
      // error.
      return;
    }
    this.pool.sendAskUserResponse(toolkitId, callId, requestId, answers);
  }

  private cancelCall(callId: string): void {
    const toolkitId = this.callIdToToolkit.get(callId);
    if (!toolkitId) return;
    this.pool.cancelCall(toolkitId, callId);
  }
}

function ensureToolkitsDir(): void {
  fs.mkdirSync(TOOLKITS_DIR, { recursive: true });
}

/** Rebuild an LRUCache with a new `max`, preserving entries in LRU order.
 *  lru-cache v11 exposes no in-place resize; the rebuild happens on rare
 *  settings changes so the copy cost is irrelevant. */
function rebuildLRU<K extends {}, V extends {}>(src: LRUCache<K, V>, max: number): LRUCache<K, V> {
  const next = new LRUCache<K, V>({ max });
  // rkeys() iterates oldest -> newest; re-inserting in that order
  // preserves the LRU ranking in the new cache. Using rkeys()+get()
  // instead of rentries() dodges a TS inference quirk in LRUCache's
  // tuple generics.
  for (const k of src.rkeys()) {
    const v = src.peek(k);
    if (v !== undefined) next.set(k, v);
  }
  return next;
}

function clampPositive(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function clampNonNegative(n: unknown, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Freshest mtime of any file under the folder (excluding node_modules). Used
 *  as a fast invalidation signal for the hash-cache fast path. */
function freshestMtime(folder: string): number {
  let newest = 0;
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const abs = path.join(dir, ent.name);
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.isDirectory()) walk(abs);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const st = fs.statSync(folder);
    if (st.isFile()) {
      return st.mtimeMs;
    }
    newest = st.mtimeMs;
    walk(folder);
  } catch {
    /* ignore */
  }
  return newest;
}
