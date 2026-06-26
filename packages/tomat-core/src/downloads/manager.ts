// Centralized download manager (port of packages/tomat-client/src/tauri/src/download.rs,
// adapted for SQLite persistence + DI-style instantiation).
//
// Concurrency: at most one active download at a time (HF rate-limit friendly).
// Persistence: every state change writes to the `downloads` table.
// Resume: on construction, any persisted Downloading row is reset to Pending
// and re-spawned by `resumePending()`.
// Self-heal: persisted Completed rows whose file no longer exists are dropped.
//
// Caller surface:
//   - enqueue(spec):  start (or join) a download; resolves to the abs path
//   - cancel(id):     abort an active download or remove a queued one
//   - retry(id):      re-queue a previously-failed download
//   - remove(id):     drop a Completed/Error/Cancelled row from the queue
//   - snapshot():     all rows
//   - markAllSeen():  flip seen=true on every row
//   - subscribe(fn):  fire-on-change observer (used by the WS hub)

import { dirname, join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { db } from "../db/connection.ts";
import type { DownloadEntry, DownloadStatus } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { isWithin } from "../shared/fs-safety.ts";
import { newJobId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";
import { Sha256Stream } from "../shared/hash.ts";
import { paths } from "../paths.ts";
import { modelCatalogSha256 } from "../models/catalog.ts";
import { parseSource } from "./sources.ts";
import { HF_BASE_URL } from "../config.ts";

const log = getLogger("downloads");

// The HuggingFace host whose resolve redirect carries the LFS content sha256.
// Derived from HF_BASE_URL so a test/mirror host (TOMAT_HF_BASE_URL) is honored
// rather than the literal "huggingface.co".
const HF_HOST = new URL(HF_BASE_URL).host;

const INTER_DOWNLOAD_DELAY_MS = 1_000;

// Abort a download that receives no bytes for this long. A silently-stalled
// connection (server wedged, network black-holed) otherwise leaves `for await`
// blocked forever with the UI gated on a download that will never finish or
// error. The window is generous so a slow-but-progressing transfer never trips
// it; it only fires on true silence.
const STALL_TIMEOUT_MS = 60_000;

export interface EnqueueSpec {
  source: string;
  destination: "models" | "binaries" | "extensions";
  groupId: string;
  sizeHint?: number;
  // Optional SHA-256 (lowercase hex) verified after a successful download.
  // Required for binaries; optional/elided for models (HF supplies its own).
  sha256?: string;
  // Direct-URL mode. When `url` is set, parseSource is bypassed and the
  // caller-supplied url + relPath are used instead. Useful for fetching
  // binaries from the tomat CDN where the source format isn't an HF spec.
  url?: string;
  relPath?: string;
  filename?: string;
}

type Listener = (snapshot: DownloadEntry[]) => void;

interface InFlight {
  abort: AbortController;
  // Awaiters subscribed to this download. Each receives the final result.
  resolvers: Array<{
    resolve: (path: string) => void;
    reject: (err: Error) => void;
  }>;
}

export class DownloadManager {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly listeners = new Set<Listener>();
  private active = false; // semaphore(1): is a download currently running?
  private readonly waitQueue: Array<() => void> = [];
  // Track scheduled inter-download release timers so shutdown() can cancel
  // any pending ticks and not leave the process holding a stray timer.
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.normalizePersistedRows();
  }

  shutdown(): void {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
  }

  // Resume any rows that were Pending when the process last exited. Called
  // from main after the manager is constructed and the rest of core is wired.
  resumePending(): void {
    const rows = this.snapshot().filter((r) => r.status === "Pending");
    for (const row of rows) {
      this.spawn(
        row.id,
        {
          source: row.source,
          destination: row.destination as EnqueueSpec["destination"],
          groupId: row.groupId,
          sizeHint: row.sizeBytes,
        },
        row.absPath,
      ).catch((err) => {
        log.warn(`resume ${row.id}: ${errMessage(err)}`);
      });
    }
  }

  enqueue(spec: EnqueueSpec): Promise<string> {
    const absPath = this.resolveAbsPath(spec);
    const id = downloadId(spec.destination, absPath);

    // Fast path: file already on disk.
    return new Promise<string>((resolve, reject) => {
      this.alreadyOnDisk(absPath)
        .then(async (on) => {
          if (on) {
            await this.upsertCompleted(id, spec, absPath);
            this.broadcast();
            resolve(absPath);
            return;
          }

          const existing = this.inFlight.get(id);
          if (existing) {
            existing.resolvers.push({ resolve, reject });
            return;
          }

          const ctrl = new AbortController();
          const inFlight: InFlight = {
            abort: ctrl,
            resolvers: [{ resolve, reject }],
          };
          this.inFlight.set(id, inFlight);
          this.upsertPending(id, spec, absPath);
          this.broadcast();
          this.spawn(id, spec, absPath).catch((err) => {
            log.warn(`spawn ${id}: ${errMessage(err)}`);
          });
        })
        // Any synchronous failure in the fast path (DB upsert, broadcast) must
        // reject the returned promise instead of leaving the caller hung.
        .catch(reject);
    });
  }

  cancel(id: string): void {
    const inFlight = this.inFlight.get(id);
    if (inFlight) {
      inFlight.abort.abort();
    } else {
      // Wasn't running; flip the row directly if it's Pending.
      const row = this.getRow(id);
      if (row && row.status === "Pending") {
        this.setStatus(id, "Cancelled", { error: "cancelled" });
        this.broadcast();
      }
    }
  }

  retry(id: string): void {
    const row = this.getRow(id);
    if (!row) return;
    if (row.status === "Downloading" || row.status === "Pending") return;
    if (this.inFlight.has(id)) return;
    this.setStatus(id, "Pending", { error: undefined, downloadedBytes: 0 });
    this.broadcast();
    const ctrl = new AbortController();
    this.inFlight.set(id, { abort: ctrl, resolvers: [] });
    this.spawn(
      id,
      {
        source: row.source,
        destination: row.destination as EnqueueSpec["destination"],
        groupId: row.groupId,
        sizeHint: row.sizeBytes,
      },
      row.absPath,
    ).catch((err) => {
      log.warn(`retry ${id}: ${errMessage(err)}`);
    });
  }

  remove(id: string): void {
    const row = this.getRow(id);
    if (!row) return;
    if (this.inFlight.has(id)) return;
    db().prepare("DELETE FROM downloads WHERE id = ?").run(id);
    // Drop any resume partial so discarding a download doesn't orphan a .tmp
    // (Error rows keep theirs for resume; removing the row is the cleanup point).
    void Deno.remove(row.absPath + ".tmp").catch(() => {});
    this.broadcast();
  }

  /** Drop Completed rows whose file is no longer on disk (deleted in-app or
   *  externally), so a stale "done" entry self-clears. Only removes on a
   *  definite NotFound; other stat errors (permissions, etc.) leave the row. */
  async reconcileCompleted(): Promise<void> {
    const rows = db()
      .prepare(`SELECT id, abs_path FROM downloads WHERE status = 'Completed'`)
      .all() as Array<{ id: string; abs_path: string }>;
    let changed = false;
    for (const row of rows) {
      try {
        await Deno.stat(row.abs_path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          db().prepare("DELETE FROM downloads WHERE id = ?").run(row.id);
          changed = true;
        }
      }
    }
    if (changed) this.broadcast();
  }

  snapshot(): DownloadEntry[] {
    const rows = db()
      .prepare(`
      SELECT id, source, destination, rel_path, abs_path, filename, group_id,
             size_bytes, downloaded_bytes, status, error, added_at_ms
      FROM downloads
      ORDER BY added_at_ms DESC
    `)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  markAllSeen(): void {
    // No `seen` column in the schema. The client tracks read state locally.
    // Method preserved on the API for symmetry with the old Tauri command.
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- internals -----------------------------------------------------------

  private resolveAbsPath(spec: EnqueueSpec): string {
    const relPath = spec.relPath ?? parseSource(spec.source).relPath;
    const root = this.destinationRoot(spec.destination);
    const abs = join(root, relPath);
    // `spec.relPath` can be supplied directly (bypassing parseSource's component
    // checks), so guard the final joined path: a `..`-bearing relPath must not
    // write outside the destination root.
    if (!isWithin(root, abs)) {
      throw new AppError("validation_error", `download path escapes ${spec.destination} root`);
    }
    return abs;
  }

  private destinationRoot(dest: EnqueueSpec["destination"]): string {
    const p = paths();
    switch (dest) {
      case "models":
        return p.modelsDir;
      case "binaries":
        return p.binDir;
      case "extensions":
        return p.extensionsDir;
    }
  }

  private async alreadyOnDisk(absPath: string): Promise<boolean> {
    try {
      const st = await Deno.stat(absPath);
      // A zero-byte file is an incomplete/aborted prior download, not a usable
      // artifact: treat it as absent so it re-downloads rather than completing.
      return st.isFile && st.size > 0;
    } catch {
      return false;
    }
  }

  private async spawn(id: string, spec: EnqueueSpec, absPath: string): Promise<void> {
    await this.acquire();
    const inFlight = this.inFlight.get(id);
    if (!inFlight) {
      this.release();
      return;
    }
    if (inFlight.abort.signal.aborted) {
      this.setStatus(id, "Cancelled");
      this.fanoutFailure(id, "cancelled");
      this.broadcast();
      this.release();
      return;
    }
    this.setStatus(id, "Downloading", { downloadedBytes: 0 });
    this.broadcast();

    let result: { ok: true; path: string } | { ok: false; error: string };
    try {
      await this.streamDownload(id, spec, absPath, inFlight.abort.signal);
      result = { ok: true, path: absPath };
    } catch (err) {
      const msg = errMessage(err);
      result = { ok: false, error: msg };
    }

    if (result.ok) {
      this.setStatus(id, "Completed", { downloadedBytes: undefined });
    } else if (inFlight.abort.signal.aborted) {
      // User-cancelled: drop the partial (the user abandoned this download;
      // remove() also cleans it, but cancel is the explicit "stop" intent).
      this.setStatus(id, "Cancelled", { error: result.error });
      try {
        await Deno.remove(absPath + ".tmp");
      } catch {
        /* fine */
      }
    } else {
      // Transient failure (network drop, stall, ...): KEEP the partial .tmp so a
      // retry resumes via a Range request instead of re-downloading from zero
      // (see streamDownload). Terminal-bad outcomes (checksum mismatch, HTTP
      // 416) already deleted it inside streamDownload, and remove() drops it if
      // the user discards the download.
      this.setStatus(id, "Error", { error: result.error });
    }
    this.broadcast();

    if (result.ok) this.fanoutSuccess(id, result.path);
    else this.fanoutFailure(id, result.error);

    this.inFlight.delete(id);

    // Brief delay between successive downloads so HF doesn't burst-throttle.
    const handle = setTimeout(() => {
      this.pendingTimers.delete(handle);
      this.release();
    }, INTER_DOWNLOAD_DELAY_MS);
    this.pendingTimers.add(handle);
  }

  private async streamDownload(
    id: string,
    spec: EnqueueSpec,
    absPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const url = spec.url ?? parseSource(spec.source).url;
    if (!url) {
      throw new AppError("validation_error", "non-downloadable source");
    }
    await Deno.mkdir(dirname(absPath), { recursive: true });
    const tmpPath = absPath + ".tmp";

    // Verify downloaded bytes against a known sha256, preferring the most
    // trustworthy anchor: an explicit spec hash, then (for a catalog model file)
    // the sha256 pinned in the SIGNED model catalog, then HF's published sha256
    // (the `x-linked-etag` on the resolve redirect). The signed-catalog hash
    // holds even if a proxy strips the etag or the file moves to a non-HF
    // mirror. Small non-LFS files not in the catalog carry a git blob sha1
    // instead, which is not a content hash, so they stay unverified.
    const expectedSha =
      spec.sha256 ??
      (spec.destination === "models" ? await modelCatalogSha256(spec.source) : undefined) ??
      (await resolveHfSha256(url, signal));
    let sha = expectedSha ? new Sha256Stream() : null;
    if (!expectedSha) {
      // No trustworthy content hash is available (no pinned sha256, and HF did
      // not return an x-linked-etag for this file). The bytes are then accepted
      // on TLS trust alone, so make that explicit instead of silently trusting a
      // possibly mis-served file. Weights with an LFS sha256 still verify above.
      log.warn(`downloading ${url} without integrity verification (no sha256 available)`);
    }

    // Resume a partial transfer left by an interrupted attempt, but ONLY when we
    // have a content hash: the final sha256 below verifies the WHOLE file, so a
    // wrongly-resumed file is still caught and retried. Without a hash we can't
    // tell a good partial from a bad one, so we always start clean.
    let resumeFrom = 0;
    if (expectedSha) {
      try {
        const st = await Deno.stat(tmpPath);
        if (st.isFile && st.size > 0) resumeFrom = st.size;
      } catch {
        /* no partial on disk: start fresh */
      }
    }
    // Seed the hasher with the bytes already on disk so the streamed tail hashes
    // continuously with them. A read failure falls back to a clean restart.
    if (resumeFrom > 0 && sha) {
      try {
        const rf = await Deno.open(tmpPath, { read: true });
        for await (const chunk of rf.readable) sha.update(chunk);
      } catch {
        resumeFrom = 0;
        sha = new Sha256Stream();
      }
    }

    let downloaded = resumeFrom;
    let total: number | undefined = spec.sizeHint;
    let lastEmit = 0;

    // Stall watchdog: abort if no bytes arrive for STALL_TIMEOUT_MS. Combined
    // with the external signal (user cancel / shutdown) so either can stop the
    // transfer. Reset on every chunk, so it only fires on true silence.
    const stall = new AbortController();
    let stalled = false;
    const combined = AbortSignal.any([signal, stall.signal]);
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        stall.abort();
      }, STALL_TIMEOUT_MS);
    };

    let file: Deno.FsFile | null = null;
    try {
      armStall();
      const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined;
      const res = await fetch(url, { signal: combined, headers });

      // The partial is larger than the resource itself (corrupt/stale .tmp): drop
      // it so the next retry starts clean rather than 416-looping.
      if (res.status === 416) {
        await Deno.remove(tmpPath).catch(() => {});
        throw new AppError(
          "provider_error",
          `partial file for ${url} is unusable (HTTP 416); restarting on next retry`,
        );
      }
      if (!res.ok) {
        throw new AppError(
          "manifest_fetch_failed",
          `HTTP ${res.status} ${res.statusText} for ${url}`,
        );
      }
      // 206 means the server honored our Range and is sending only the tail, so
      // append; anything else (200) is the whole file, so rewrite from scratch
      // (reset the hasher + truncate the partial).
      const resuming = resumeFrom > 0 && res.status === 206;
      if (!resuming) {
        resumeFrom = 0;
        downloaded = 0;
        if (expectedSha) sha = new Sha256Stream();
      }
      file = await Deno.open(
        tmpPath,
        resuming
          ? { create: true, write: true, append: true }
          : { create: true, write: true, truncate: true },
      );

      // content-length is the BODY length (the remaining tail when resuming), so
      // the full size is the offset we started at plus it.
      const cl = res.headers.get("content-length");
      let exactTotal: number | undefined;
      if (cl) {
        const n = Number(cl);
        if (Number.isFinite(n)) {
          exactTotal = downloaded + n;
          total = exactTotal;
        }
      }
      if (total !== undefined && total !== spec.sizeHint) {
        this.updateSize(id, total);
      }
      const body = res.body;
      if (!body) {
        throw new AppError("provider_error", "empty response body");
      }
      for await (const chunk of body) {
        if (signal.aborted) {
          throw new Error("cancelled");
        }
        // Guard against a wrong/hostile URL that streams far more than it
        // declared (filling the disk). The ceiling is generous (2x + 64MB) so a
        // transfer-encoding quirk never trips a legitimate download, but an
        // unbounded stream is still cut off.
        if (exactTotal !== undefined && downloaded > exactTotal * 2 + 64 * 1024 * 1024) {
          throw new AppError(
            "provider_error",
            `download for ${url} far exceeded its declared size (${exactTotal}); aborting`,
          );
        }
        await file.write(chunk);
        if (sha) sha.update(chunk);
        downloaded += chunk.byteLength;
        armStall(); // progress: reset the stall watchdog
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          this.updateProgress(id, downloaded);
          this.broadcast();
        }
      }
    } catch (err) {
      // A watchdog abort surfaces as a generic AbortError; rewrite it into a
      // clear, retryable reason so the UI explains the stall instead of a bare
      // "operation aborted".
      if (stalled) {
        throw new AppError(
          "server_unavailable",
          `download for ${url} stalled (no data for ${STALL_TIMEOUT_MS / 1000}s); aborting`,
        );
      }
      throw err;
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
      try {
        file?.close();
      } catch {
        /* fine */
      }
    }

    if (sha && expectedSha) {
      const actual = await sha.hexDigest();
      if (actual !== expectedSha.toLowerCase()) {
        try {
          await Deno.remove(tmpPath);
        } catch {
          /* fine */
        }
        throw new AppError(
          "checksum_mismatch",
          `sha256 mismatch: want ${expectedSha}, got ${actual}`,
        );
      }
    }

    await Deno.rename(tmpPath, absPath);
    this.updateProgress(id, downloaded);
  }

  // --- semaphore -----------------------------------------------------------

  private acquire(): Promise<void> {
    if (!this.active) {
      this.active = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.active = true;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = false;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  // --- DB upserts ----------------------------------------------------------

  private upsertPending(id: string, spec: EnqueueSpec, absPath: string): void {
    const existing = this.getRow(id);
    const now = Date.now();
    if (existing) {
      db()
        .prepare(`
        UPDATE downloads
           SET status = 'Pending',
               error = NULL,
               downloaded_bytes = 0,
               size_bytes = COALESCE(?, size_bytes)
         WHERE id = ?
      `)
        .run(spec.sizeHint ?? null, id);
      return;
    }
    const meta = resolveMeta(spec);
    db()
      .prepare(`
      INSERT INTO downloads
        (id, source, destination, rel_path, abs_path, filename, group_id,
         size_bytes, downloaded_bytes, status, error, added_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'Pending', NULL, ?)
    `)
      .run(
        id,
        spec.source,
        spec.destination,
        meta.relPath,
        absPath,
        meta.filename,
        spec.groupId,
        spec.sizeHint ?? null,
        now,
      );
  }

  private async upsertCompleted(id: string, spec: EnqueueSpec, absPath: string): Promise<void> {
    const existing = this.getRow(id);
    if (existing) {
      db()
        .prepare(`
        UPDATE downloads
           SET status = 'Completed',
               error = NULL,
               abs_path = ?,
               downloaded_bytes = COALESCE(size_bytes, downloaded_bytes)
         WHERE id = ?
      `)
        .run(absPath, id);
      return;
    }
    let sizeOnDisk: number | undefined;
    try {
      sizeOnDisk = (await Deno.stat(absPath)).size;
    } catch {
      /* ignore */
    }
    const meta = resolveMeta(spec);
    db()
      .prepare(`
      INSERT INTO downloads
        (id, source, destination, rel_path, abs_path, filename, group_id,
         size_bytes, downloaded_bytes, status, error, added_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Completed', NULL, ?)
    `)
      .run(
        id,
        spec.source,
        spec.destination,
        meta.relPath,
        absPath,
        meta.filename,
        spec.groupId,
        sizeOnDisk ?? null,
        sizeOnDisk ?? 0,
        Date.now(),
      );
  }

  private setStatus(
    id: string,
    status: DownloadStatus,
    opts: { error?: string; downloadedBytes?: number } = {},
  ): void {
    if (opts.downloadedBytes !== undefined) {
      db()
        .prepare(`
        UPDATE downloads
           SET status = ?, error = ?, downloaded_bytes = ?
         WHERE id = ?
      `)
        .run(status, opts.error ?? null, opts.downloadedBytes, id);
    } else {
      db()
        .prepare(`
        UPDATE downloads
           SET status = ?, error = ?
         WHERE id = ?
      `)
        .run(status, opts.error ?? null, id);
    }
  }

  private updateProgress(id: string, downloadedBytes: number): void {
    db().prepare(`UPDATE downloads SET downloaded_bytes = ? WHERE id = ?`).run(downloadedBytes, id);
  }

  private updateSize(id: string, sizeBytes: number): void {
    db().prepare(`UPDATE downloads SET size_bytes = ? WHERE id = ?`).run(sizeBytes, id);
  }

  private getRow(id: string): DownloadEntry | undefined {
    const row = db()
      .prepare(`
      SELECT id, source, destination, rel_path, abs_path, filename, group_id,
             size_bytes, downloaded_bytes, status, error, added_at_ms
      FROM downloads WHERE id = ?
    `)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  // On construction: drop persisted Completed rows whose file vanished;
  // flip persisted Downloading rows to Pending (the resume loop will pick
  // them up).
  // Boot-time pass that runs once at construction, so the sync stat here is
  // intentional (a few hundred sync stats during startup is cheaper than
  // restructuring the constructor to be async).
  private normalizePersistedRows(): void {
    const all = db().prepare(`SELECT id, abs_path, status FROM downloads`).all() as Array<{
      id: string;
      abs_path: string;
      status: string;
    }>;
    for (const row of all) {
      if (row.status === "Completed") {
        try {
          Deno.statSync(row.abs_path);
        } catch {
          db().prepare(`DELETE FROM downloads WHERE id = ?`).run(row.id);
        }
      } else if (row.status === "Downloading") {
        db()
          .prepare(`
          UPDATE downloads SET status = 'Pending', downloaded_bytes = 0
          WHERE id = ?
        `)
          .run(row.id);
      }
    }
  }

  // --- fanout --------------------------------------------------------------

  private broadcast(): void {
    if (this.listeners.size === 0) return;
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch (err) {
        log.warn(`download listener threw: ${errMessage(err)}`);
      }
    }
  }

  private fanoutSuccess(id: string, path: string): void {
    const inFlight = this.inFlight.get(id);
    if (!inFlight) return;
    for (const r of inFlight.resolvers) r.resolve(path);
  }

  private fanoutFailure(id: string, msg: string): void {
    const inFlight = this.inFlight.get(id);
    if (!inFlight) return;
    for (const r of inFlight.resolvers) {
      r.reject(new AppError("provider_error", msg));
    }
  }
}

// --- helpers ---------------------------------------------------------------

function downloadId(dest: EnqueueSpec["destination"], absPath: string): string {
  return `${dest}:${absPath}`;
}

function resolveMeta(spec: EnqueueSpec): { relPath: string; filename: string } {
  if (spec.relPath) {
    const filename = spec.filename ?? spec.relPath.split("/").pop() ?? spec.relPath;
    return { relPath: spec.relPath, filename };
  }
  const parsed = parseSource(spec.source);
  return {
    relPath: parsed.relPath,
    filename: spec.filename ?? parsed.filename,
  };
}

function rowToEntry(row: Record<string, unknown>): DownloadEntry {
  return {
    id: String(row.id),
    source: String(row.source),
    destination: String(row.destination) as DownloadEntry["destination"],
    relPath: String(row.rel_path),
    absPath: String(row.abs_path),
    filename: String(row.filename),
    groupId: String(row.group_id),
    sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
    downloadedBytes: Number(row.downloaded_bytes ?? 0),
    status: String(row.status) as DownloadStatus,
    error: row.error == null ? undefined : String(row.error),
    addedAtMs: Number(row.added_at_ms),
  };
}

// Singleton accessor for the rest of core to consume.
let _instance: DownloadManager | null = null;
export function downloadManager(): DownloadManager {
  if (!_instance) _instance = new DownloadManager();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}

// Unused but exported for callers that want to mint an ad-hoc job id.
export { newJobId };

/** Best-effort lookup of a HuggingFace file's published sha256. The resolve
 *  endpoint 302-redirects to a CDN; for git-LFS objects (the large model
 *  weights) the redirect carries the content sha256 in `x-linked-etag`. Returns
 *  it (lowercase hex) when present and shaped like a sha256, else undefined
 *  (e.g. small non-LFS files, whose etag is a git blob sha1, or a non-HF URL).
 *  Used to verify model downloads against HF + TLS. */
async function resolveHfSha256(url: string, signal: AbortSignal): Promise<string | undefined> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  if (host !== HF_HOST) return undefined;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    await res.body?.cancel();
    const raw = res.headers.get("x-linked-etag") ?? res.headers.get("etag");
    if (!raw) return undefined;
    const cleaned = raw.replace(/^W\//, "").replace(/"/g, "").trim();
    return /^[0-9a-f]{64}$/i.test(cleaned) ? cleaned.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
