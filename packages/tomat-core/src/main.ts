// tomat-core entrypoint.
// Boots: paths → logger → DB → HTTP + WS server.

import { ensureDirs, paths } from "./paths.ts";
import { errMessage } from "@tomat/shared";
import { loadBootConfig } from "./config.ts";
import {
  getLogger,
  initLogger,
  isLoggerReady,
  scrubSecrets,
} from "./shared/log.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { buildApp } from "./http/server.ts";
import { wsHub } from "./ws/hub.ts";
import { downloadManager } from "./downloads/manager.ts";
import { handleUpdateMarkerOnBoot } from "./update/rollback.ts";
import { toolkitsRegistry } from "./toolkits/registry.ts";
import { initSidecarBoot } from "./services/sidecar-boot.ts";
import { sidecarManager } from "./sidecars/manager.ts";
import { shutdownJobctl } from "./sidecars/jobctl.ts";
import { loadCoreSettings } from "./services/core-settings.ts";
import { tlsServeOptions } from "./services/tls.ts";

async function main(): Promise<void> {
  const cfg = loadBootConfig();
  await ensureDirs();
  await initLogger();
  const log = getLogger();

  // `server.bindHost` (persisted core setting) chooses the interface the HTTP
  // listener binds to: 127.0.0.1 (default, this machine only), a specific LAN
  // IP, or 0.0.0.0 (all interfaces, so other devices can pair). The
  // TOMAT_CORE_HOST env var still wins when set.
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
      log.warn(
        `could not read server.bindHost; falling back to ${cfg.host}: ${
          errMessage(err)
        }`,
      );
    }
  }

  log.info(`tomat-core v${cfg.version} starting on ${bindHost}:${cfg.port}`);
  // The API is served over TLS (HTTPS/WSS) with a self-signed cert that clients
  // pin at pairing, so traffic is encrypted and core is authenticated even on a
  // shared network. Binding beyond loopback just widens reachability.
  if (
    bindHost !== "127.0.0.1" && bindHost !== "localhost" && bindHost !== "::1"
  ) {
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

  openDb();
  migrate();
  log.info("db schema ensured");

  // Resume any persisted-Pending downloads from the previous run.
  downloadManager().resumePending();

  // Verify toolkit content hashes in the background. Don't gate boot on
  // it: large toolkits can take seconds to walk, and tool calls against
  // drifted toolkits are blocked by the route layer's `lastError` check
  // anyway. The first verification result is just slightly delayed.
  void toolkitsRegistry().verifyAllOnBoot().then((drifted) => {
    if (drifted.length > 0) {
      log.warn(
        `toolkit content drift: ${drifted.length} toolkit(s) marked ` +
          `with errors: ${drifted.join(", ")}`,
      );
    }
  }).catch((err) => {
    log.error(
      `toolkit verifyAllOnBoot failed: ${errMessage(err)}`,
    );
  });

  // Kick off llama / whisper sidecar boot based on the persisted settings.
  // Runs in the background — `chat.start` and `/stt/transcribe` against a
  // sidecar that hasn't bound its port yet return a clear error; the
  // sidecar.status WS frames let the UI render a loading chip.
  void initSidecarBoot().catch((err) => {
    log.error(
      `sidecar boot failed: ${errMessage(err)}`,
    );
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

  // Graceful shutdown.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        log.info(`received ${sig}; shutting down`);
        hub.shutdown();
        downloadManager().shutdown();
        void sidecarManager().shutdown();
        void shutdownJobctl();
        void server.shutdown().finally(() => Deno.exit(0));
      });
    } catch { /* SIGTERM unsupported on Windows */ }
  }

  await server.finished;
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
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
