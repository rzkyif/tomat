// tomat-core entrypoint.
// Boots: paths → logger → DB → HTTP + WS server.

import { ensureDirs, paths } from "./paths.ts";
import { ensureHelperBinaries } from "./binaries/helpers.ts";
import { errMessage } from "@tomat/shared";
import { loadBootConfig } from "./config.ts";
import { getLogger, initLogger, isLoggerReady, scrubSecrets } from "./shared/log.ts";
import { closeDb, openDb } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { buildApp } from "./http/server.ts";
import { wsHub } from "./ws/hub.ts";
import { downloadManager } from "./downloads/manager.ts";
import { commitUpdate, handleUpdateMarkerOnBoot } from "./update/rollback.ts";
import { extensionsRegistry } from "./extensions/registry.ts";
import { mcpRegistry } from "./mcp/registry.ts";
import { mcpManager } from "./mcp/manager.ts";
import { seedBuiltinExtensionIfNeeded } from "./extensions/builtin-seed.ts";
import { BROADCAST_SINK } from "./http/routes/extensions.ts";
import { initSidecarBoot } from "./services/sidecar-boot.ts";
import { coreStatus } from "./services/core-status.ts";
import { llmIdle } from "./services/llm-idle.ts";
import { backgroundQueue } from "./services/background-queue.ts";
import { memoriesStore, registerMemoryProvider } from "./services/memories-store.ts";
import { scheduleMemoryIndexing } from "./services/memories-indexer.ts";
import { promptScheduler } from "./services/prompt-scheduler.ts";
import { sidecarManager } from "./sidecars/manager.ts";
import { shutdownJobctl } from "./sidecars/jobctl.ts";
import { loadCoreSettings } from "./services/core-settings.ts";
import { sweepOrphanedSessionDirs } from "./services/sessions-store.ts";
import { warnIfVaultUnreadable } from "./services/secrets.ts";
import { tlsServeOptions } from "./services/tls.ts";

async function main(): Promise<void> {
  const cfg = loadBootConfig();
  await ensureDirs();
  await initLogger();
  const log = getLogger();

  // `server.bindHost` chooses the interface the HTTP listener binds to:
  // 127.0.0.1 (default, this machine only), a specific LAN IP, or 0.0.0.0
  // (all interfaces, so other devices can pair). Deliberately NOT a schema
  // setting: a paired client must never be able to widen network exposure
  // over the API. It is read raw from the local settings.json, so the only
  // ways to change it are editing that file by hand or the TOMAT_CORE_HOST
  // env var (which wins when set).
  const hostFromEnv = Deno.env.get("TOMAT_CORE_HOST");
  let bindHost = cfg.host;
  if (!hostFromEnv) {
    try {
      const settings = await loadCoreSettings();
      const configured = settings["server.bindHost"];
      if (typeof configured === "string" && configured.trim().length > 0) {
        bindHost = configured.trim();
      }
    } catch (err) {
      log.warn(`could not read server.bindHost; falling back to ${cfg.host}: ${errMessage(err)}`);
    }
  }

  log.info(`tomat-core v${cfg.version} starting on ${bindHost}:${cfg.port}`);
  // The API is served over TLS (HTTPS/WSS) with a self-signed cert that clients
  // pin at pairing, so traffic is encrypted and core is authenticated even on a
  // shared network. Binding beyond loopback just widens reachability.
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost" && bindHost !== "::1") {
    log.info(
      `core is bound to ${bindHost} (not loopback): the HTTPS/WSS API is ` +
        `reachable from the network. Paired clients pin the TLS cert.`,
    );
  }
  log.info(`root: ${paths().root}`);

  // Check the update marker BEFORE we open the DB / bind the port. If
  // rollback fires, we exit cleanly and the supervisor relaunches the
  // (now-restored) previous binary.
  const rolledBack = await handleUpdateMarkerOnBoot();
  if (rolledBack) Deno.exit(0);

  // Fail loud if a native helper binary is missing rather than silently
  // degrading (file-backed secrets, guessed hardware, no permission prompts).
  // Helpers are install-time artifacts, so a gap means a broken install.
  ensureHelperBinaries();

  openDb();
  migrate();
  log.info("db schema ensured");

  // Remove session directories left behind by a temporary session whose
  // attachments hit disk but whose RAM-only doc was lost on an unclean
  // shutdown. A persistent session always has a session.json, so this only
  // ever touches those orphans.
  sweepOrphanedSessionDirs();

  // Resume any persisted-Pending downloads from the previous run.
  downloadManager().resumePending();

  // Verify extension content hashes in the background. Don't gate boot on it:
  // large extensions can take seconds to walk. A drifted extension is flipped to
  // status='drift' and has its tools disabled, so the chat-exposure gate blocks
  // its tools until the user confirms re-enable. The first verification result
  // is just slightly delayed.
  void extensionsRegistry()
    .verifyAllOnBoot()
    .then((drifted) => {
      if (drifted.length > 0) {
        log.warn(
          `extension content drift: ${drifted.length} extension(s) flipped to ` +
            `status='drift' (tools disabled): ${drifted.join(", ")}`,
        );
      }
    })
    .catch((err) => {
      log.error(`extension verifyAllOnBoot failed: ${errMessage(err)}`);
    });

  // Seed the built-in extension on a fresh install (background, non-blocking).
  // This only brings it to status 'downloaded'; installing its tools is an
  // explicit user choice from the Tools prompt (requestBuiltinInstall). Respects
  // a prior user delete via the seed marker; retries next boot if offline.
  void seedBuiltinExtensionIfNeeded(BROADCAST_SINK).catch((err) => {
    log.warn(`builtin extension seed failed (will retry next boot): ${errMessage(err)}`);
  });

  // Surface an unreadable secrets vault (sealed secrets.enc but no master key)
  // at startup rather than mid-request. Background, non-mutating.
  void warnIfVaultUnreadable().catch((err) => {
    log.warn(`secrets vault check failed: ${errMessage(err)}`);
  });

  // Re-register the base dir for memories shipped by already-installed
  // extensions so their (read-only) content resolves after a restart; the rows
  // persist in the DB, only the provider->dir mapping is in-memory.
  try {
    for (const ext of extensionsRegistry().list()) {
      registerMemoryProvider(ext.id, paths().extensionsDir);
    }
  } catch (err) {
    log.warn(`extension memory provider registration failed: ${errMessage(err)}`);
  }

  // Reconcile the memory store with the files on disk, then queue summary /
  // embedding refreshes for anything stale (idle-gated, background).
  try {
    memoriesStore().rescan();
    scheduleMemoryIndexing();
  } catch (err) {
    log.warn(`memory rescan failed: ${errMessage(err)}`);
  }

  // Arm the scheduled-prompt timer. Overdue rows (core was off at fire
  // time) tick immediately; the scheduler defers while llama is loading.
  promptScheduler().start();

  // Connect to enabled MCP servers in the background; their tools/prompts/
  // resources become available as each connection settles. Failures are
  // captured per-server (status='error'), never block boot.
  void mcpManager()
    .sync(mcpRegistry().list())
    .catch((err) => {
      log.warn(`MCP sync failed: ${errMessage(err)}`);
    });

  // Kick off llama / whisper sidecar boot based on the persisted settings.
  // Runs in the background. `chat.start` and `/stt/transcribe` against a
  // sidecar that hasn't bound its port yet return a clear error; the aggregate
  // `core.status` frame (with its per-subsystem breakdown) lets the UI render
  // the loading / error state in the CoreBar.
  void initSidecarBoot().catch((err) => {
    log.error(`sidecar boot failed: ${errMessage(err)}`);
  });

  const app = buildApp();
  const hub = wsHub();

  // Self-signed cert + sealed key; clients pin the SPKI (see services/tls.ts).
  const tls = await tlsServeOptions(bindHost);

  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname: bindHost, port: cfg.port, cert: tls.cert, key: tls.key },
      async (req, info) => {
        const url = new URL(req.url);
        // WS upgrade path.
        if (
          url.pathname === "/ws/v1" &&
          req.headers.get("upgrade")?.toLowerCase() === "websocket"
        ) {
          return await hub.handleUpgrade(req);
        }
        // Pass the real socket peer address into the Hono env so security-
        // sensitive routes (pairing rate limit) can key on it instead of a
        // spoofable X-Forwarded-For header.
        return await app.fetch(req, { remoteAddr: info.remoteAddr });
      },
    );
  } catch (err) {
    // The most common boot failure: the port is taken (a leftover core, another
    // channel misconfigured to the same port, or an unrelated program). Deno's
    // bare "AddrInUse" reaches the user as an opaque connection timeout, so
    // rewrite it into something actionable. main()'s caller records the reason
    // to bootErrorFile for a supervising client / the install script to surface.
    if (err instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `port ${cfg.port} on ${bindHost} is already in use. Another tomat Core may ` +
          `already be running, or a different program holds the port. Stop it, or set ` +
          `TOMAT_CORE_HOST to a free host:port and relaunch.`,
      );
    }
    throw err;
  }

  // The listener bound cleanly: drop any stale boot-failure breadcrumb so a
  // supervising client / the install script doesn't surface a resolved error.
  void Deno.remove(paths().bootErrorFile).catch(() => {});

  // Healthy checkpoint: the HTTP listener is bound (the DB is open and the TLS
  // key is unsealed by now), so a pending self-update has proven it can run.
  // Commit it (remove the marker + `<bin>.old` anchor) so a later ordinary
  // restart can't roll back this working binary. No-op when no update is pending.
  void commitUpdate().catch((err) => log.warn(`update commit failed: ${errMessage(err)}`));

  // Boot is past the point where the core can serve: the listener is bound and
  // sidecar boot has been kicked. The aggregate status now follows sidecar
  // readiness (still "starting_up" while a required model is loading).
  coreStatus().noteBootDone();

  // Graceful shutdown. Register one handler per signal and have the first
  // signal remove BOTH: under dev `--watch` the runtime re-runs this module in
  // the same process WITHOUT clearing prior signal listeners, so leaving ours
  // installed makes every reload add another pair (the handler would then fire,
  // log, and shut down once per past reload). An installed listener also keeps
  // the event loop alive, so removing it is part of letting the dev drain end.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = new Map<(typeof signals)[number], () => void>();
  const onSignal = (sig: (typeof signals)[number]): void => {
    for (const [s, h] of handlers) {
      try {
        Deno.removeSignalListener(s, h);
      } catch {
        /* already gone */
      }
    }
    handlers.clear();

    const devWatch = Boolean(Deno.env.get("TOMAT_DEV_WATCH"));
    // Under dev `--watch` the console shows a single friendly "reloading" marker
    // (scripts/dev.ts reformats the watcher notice), so keep the shutdown
    // chatter at debug; standalone keeps it as operational info.
    const trace = devWatch ? log.debug.bind(log) : log.info.bind(log);
    trace(`received ${sig}; shutting down`);

    hub.shutdown();
    downloadManager().shutdown();
    // Cancel the pending idle-unload timer so it can't keep the event loop
    // alive; under dev `--watch` a pending timer stalls the restart for up to
    // `llm.idleUnloadSeconds`.
    llmIdle().dispose();
    // Drop queued background jobs and their pending timer (same event-loop
    // concern); jobs are re-derived from source hashes on the next boot.
    backgroundQueue().dispose();
    // Same for the scheduled-prompt timer; it re-arms from SQLite on boot.
    promptScheduler().dispose();
    // Tear down sidecars + jobctl in the background, NOT awaited before the
    // server close below: reaping the llama child can take up to the 5s graceful
    // window, and serializing the server behind it would leave the HTTP listener
    // up (so `await server.finished` never returns and the watcher never gets
    // its drain). Run them in parallel.
    void sidecarManager()
      .shutdown()
      .then(() => trace("shutdown: sidecars stopped"))
      .catch((err) => log.warn(`shutdown: sidecar stop failed: ${errMessage(err)}`));
    void shutdownJobctl();
    // Disconnect MCP servers so spawned stdio children are SIGTERM'd rather than
    // orphaned. Background like sidecars: each close has its own graceful window
    // and we don't want to serialize the HTTP drain behind it.
    void mcpManager()
      .shutdown()
      .then(() => trace("shutdown: mcp servers stopped"))
      .catch((err) => log.warn(`shutdown: mcp stop failed: ${errMessage(err)}`));
    // Close the HTTP server immediately so `await server.finished` in main() can
    // return.
    const closed = server.shutdown().then(() => trace("shutdown: http server closed"));
    if (devWatch) {
      // `deno run --watch` re-runs this module in the same process once the
      // event loop drains to empty; Deno.exit() would kill the watcher and end
      // the dev session, so rely on the drain. Leave the DB open (openDb()
      // reuses it on the re-run).
      void closed;
    } else {
      // Standalone/compiled core: nothing supervises us, so exit explicitly once
      // the server closes. Checkpoint + close the DB so the WAL folds back.
      void closed.finally(() => {
        try {
          closeDb();
        } catch {
          /* best-effort */
        }
        Deno.exit(0);
      });
    }
  };
  for (const sig of signals) {
    try {
      const handler = (): void => onSignal(sig);
      handlers.set(sig, handler);
      Deno.addSignalListener(sig, handler);
    } catch {
      /* SIGTERM unsupported on Windows */
    }
  }

  await server.finished;
  // Under dev `--watch` the module must return so the watcher can re-run it. If
  // this prints but the watcher never restarts, the server closed fine and a
  // lingering timer/child is what's holding the event loop open.
  if (Deno.env.get("TOMAT_DEV_WATCH")) {
    log.debug("server.finished resolved; entrypoint returning for watcher restart");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (isLoggerReady()) {
      getLogger().error(`tomat-core failed to start: ${msg}`);
    } else {
      // Logger setup itself failed (or boot threw before it ran); the
      // structured sink is unavailable, so fall back to console + scrub
      // manually since the formatter never runs.
      console.error(scrubSecrets(`tomat-core failed to start: ${msg}`));
    }
    // Leave a one-line breadcrumb a supervising client / the install script can
    // read to explain why the core won't come up (cleared once it next binds).
    // Best-effort and scrubbed: a write failure here must not mask the real
    // error, and the reason can echo a path/token-bearing message.
    try {
      const reason = err instanceof Error ? err.message : String(err);
      await Deno.writeTextFile(paths().bootErrorFile, scrubSecrets(reason) + "\n");
    } catch {
      /* best-effort: the root dir may itself be unwritable */
    }
    Deno.exit(1);
  }
}
