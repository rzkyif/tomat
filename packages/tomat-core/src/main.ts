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
import { handleUpdateMarkerOnBoot } from "./update/rollback.ts";
import { toolkitsRegistry } from "./toolkits/registry.ts";
import { seedBuiltinToolkitIfNeeded } from "./toolkits/builtin-seed.ts";
import { BROADCAST_SINK } from "./http/routes/toolkits.ts";
import { initSidecarBoot } from "./services/sidecar-boot.ts";
import { llmIdle } from "./services/llm-idle.ts";
import { sidecarManager } from "./sidecars/manager.ts";
import { shutdownJobctl } from "./sidecars/jobctl.ts";
import { loadCoreSettings } from "./services/core-settings.ts";
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

  // Resume any persisted-Pending downloads from the previous run.
  downloadManager().resumePending();

  // Verify toolkit content hashes in the background. Don't gate boot on it:
  // large toolkits can take seconds to walk. A drifted toolkit is flipped to
  // status='drift' and has its tools disabled, so the chat-exposure gate blocks
  // its tools until the user confirms re-enable. The first verification result
  // is just slightly delayed.
  void toolkitsRegistry()
    .verifyAllOnBoot()
    .then((drifted) => {
      if (drifted.length > 0) {
        log.warn(
          `toolkit content drift: ${drifted.length} toolkit(s) flipped to ` +
            `status='drift' (tools disabled): ${drifted.join(", ")}`,
        );
      }
    })
    .catch((err) => {
      log.error(`toolkit verifyAllOnBoot failed: ${errMessage(err)}`);
    });

  // Seed the built-in toolkit on a fresh install (background, non-blocking).
  // Respects a prior user delete via the seed marker; retries next boot if the
  // first attempt is offline.
  void seedBuiltinToolkitIfNeeded(BROADCAST_SINK).catch((err) => {
    log.warn(`builtin toolkit seed failed (will retry next boot): ${errMessage(err)}`);
  });

  // Surface an unreadable secrets vault (sealed secrets.enc but no master key)
  // at startup rather than mid-request. Background, non-mutating.
  void warnIfVaultUnreadable().catch((err) => {
    log.warn(`secrets vault check failed: ${errMessage(err)}`);
  });

  // Kick off llama / whisper sidecar boot based on the persisted settings.
  // Runs in the background. `chat.start` and `/stt/transcribe` against a
  // sidecar that hasn't bound its port yet return a clear error; the
  // sidecar.status WS frames let the UI render a loading chip.
  void initSidecarBoot().catch((err) => {
    log.error(`sidecar boot failed: ${errMessage(err)}`);
  });

  const app = buildApp();
  const hub = wsHub();

  // Self-signed cert + sealed key; clients pin the SPKI (see services/tls.ts).
  const tls = await tlsServeOptions(bindHost);

  const server = Deno.serve(
    { hostname: bindHost, port: cfg.port, cert: tls.cert, key: tls.key },
    async (req, info) => {
      const url = new URL(req.url);
      // WS upgrade path.
      if (url.pathname === "/ws/v1" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return await hub.handleUpgrade(req);
      }
      // Pass the real socket peer address into the Hono env so security-
      // sensitive routes (pairing rate limit) can key on it instead of a
      // spoofable X-Forwarded-For header.
      return await app.fetch(req, { remoteAddr: info.remoteAddr });
    },
  );

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
    Deno.exit(1);
  }
}
