// Hono app construction. Wires middleware + route groups.
//
// The chat WS route (/ws/v1) is registered separately by ws/hub.ts because
// Hono's WS upgrade story varies across servers; we use the raw
// Deno.serve hook for upgrades.

import { Hono } from "hono";
import { CORE_VERSION } from "../config.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { errorMiddleware } from "./middleware/errors.ts";
import { binariesRoutes } from "./routes/binaries.ts";
import { llmRoutes } from "./routes/llm.ts";
import { modelsRoutes } from "./routes/models.ts";
import { pairingRoutes } from "./routes/pairing.ts";
import { sessionsRoutes } from "./routes/sessions.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { sidecarsRoutes } from "./routes/sidecars.ts";
import { sttRoutes } from "./routes/stt.ts";
import { ttsRoutes } from "./routes/tts.ts";
import { toolkitsRoutes } from "./routes/toolkits.ts";
import { updateRoutes } from "./routes/update.ts";

export function buildApp(): Hono {
  const app = new Hono();
  app.use("*", corsMiddleware());
  app.use("*", errorMiddleware());

  app.get("/api/v1/health", (c) => {
    return c.json({
      status: "ok",
      version: CORE_VERSION,
      uptimeMs: Math.floor(performance.now()),
    });
  });

  app.route("/api/v1/pairing", pairingRoutes());
  app.route("/api/v1/sessions", sessionsRoutes());
  app.route("/api/v1/models", modelsRoutes());
  app.route("/api/v1/binaries", binariesRoutes());
  app.route("/api/v1/toolkits", toolkitsRoutes());
  app.route("/api/v1/settings", settingsRoutes());
  app.route("/api/v1/stt", sttRoutes());
  app.route("/api/v1/tts", ttsRoutes());
  app.route("/api/v1/llm", llmRoutes());
  app.route("/api/v1/sidecars", sidecarsRoutes());
  app.route("/api/v1/update", updateRoutes());

  return app;
}
