// tomat-core entrypoint.
// Boots: paths → logger → DB → HTTP + WS server.

import { ensureDirs, paths } from "./paths.ts";
import { loadBootConfig } from "./config.ts";
import { getLogger, initLogger } from "./shared/log.ts";
import { openDb } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { buildApp } from "./http/server.ts";
import { wsHub } from "./ws/hub.ts";
import { downloadManager } from "./downloads/manager.ts";
import { handleUpdateMarkerOnBoot } from "./update/rollback.ts";
import { toolkitsRegistry } from "./toolkits/registry.ts";
import { initSidecarBoot } from "./services/sidecarBoot.ts";
import { sidecarManager } from "./sidecars/manager.ts";
import { shutdownJobctl } from "./sidecars/jobctl.ts";

async function main(): Promise<void> {
  const cfg = loadBootConfig();
  await ensureDirs();
  await initLogger();
  const log = getLogger();
  log.info(`tomat-core v${cfg.version} starting on ${cfg.host}:${cfg.port}`);
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
      `toolkit verifyAllOnBoot failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
  });

  // Kick off llama / whisper sidecar boot based on the persisted settings.
  // Runs in the background — `chat.start` and `/stt/transcribe` against a
  // sidecar that hasn't bound its port yet return a clear error; the
  // sidecar.status WS frames let the UI render a loading chip.
  void initSidecarBoot().catch((err) => {
    log.error(
      `sidecar boot failed: ${err instanceof Error ? err.message : err}`,
    );
  });

  const app = buildApp();
  const hub = wsHub();

  const server = Deno.serve(
    { hostname: cfg.host, port: cfg.port },
    async (req) => {
      const url = new URL(req.url);
      // WS upgrade path.
      if (
        url.pathname === "/ws/v1" &&
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        return await hub.handleUpgrade(req);
      }
      return await app.fetch(req);
    },
  );

  // Graceful shutdown.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        log.info(`received ${sig}; shutting down`);
        hub.shutdown();
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
    console.error("tomat-core failed to start:", err);
    Deno.exit(1);
  }
}
