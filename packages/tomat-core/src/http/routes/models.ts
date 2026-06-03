import { Hono } from "hono";
import { modelsManager } from "../../models/manager.ts";
import { downloadManager } from "../../downloads/manager.ts";
import { ensureKindModels } from "../../services/model-ensure.ts";
import { notifyRequirementsChanged } from "../../services/requirements.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

type ModelKind = "llm" | "stt" | "tts" | "embed";

export function modelsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", async (c) => {
    return c.json(await modelsManager().list());
  });

  r.post("/download", async (c) => {
    const body = (await readJson(c)) as {
      items: Array<{ source: string; group?: string }>;
    };
    if (!Array.isArray(body.items)) {
      throw new AppError("validation_error", "items array required");
    }
    const jobIds = modelsManager().download(
      body.items.map((i) => ({
        source: i.source,
        group: i.group as "llm" | "stt" | "tts" | "embed" | undefined,
      })),
    );
    return c.json({ jobIds });
  });

  r.delete("/:relPath{.+}", async (c) => {
    await modelsManager().delete(c.req.param("relPath"));
    // A deleted model file can re-expose a requirement (computeRequirements
    // only re-probes when notified), so recompute now; otherwise the client's
    // pending-downloads snapshot keeps reporting the file as present.
    void notifyRequirementsChanged();
    return c.body(null, 204);
  });

  r.get("/downloads", (c) => c.json(modelsManager().downloads()));

  r.post("/downloads/:id/cancel", (c) => {
    downloadManager().cancel(c.req.param("id"));
    return c.body(null, 204);
  });

  r.post("/downloads/:id/retry", (c) => {
    downloadManager().retry(c.req.param("id"));
    return c.body(null, 204);
  });

  r.delete("/downloads/:id", (c) => {
    downloadManager().remove(c.req.param("id"));
    return c.body(null, 204);
  });

  r.post("/probe", async (c) => {
    const body = (await readJson(c)) as { sources: string[] };
    if (!Array.isArray(body.sources)) {
      throw new AppError("validation_error", "sources array required");
    }
    return c.json(await modelsManager().probe(body.sources));
  });

  // Bulk-ensure every model file the named sidecar kind needs given the
  // current settings. Skips files already on disk; enqueues downloads for
  // the rest. Returns the list of files that were enqueued (jobIds) and
  // those that were already present. Note: `sidecar-boot` auto-calls this
  // internally on settings change, so the client only needs to hit /ensure
  // for explicit "Download required models" buttons.
  r.post("/ensure", async (c) => {
    const body = (await readJson(c)) as { kind?: string };
    if (
      body.kind !== "llm" &&
      body.kind !== "stt" &&
      body.kind !== "tts" &&
      body.kind !== "embed"
    ) {
      throw new AppError("validation_error", "kind must be one of: llm, stt, tts, embed");
    }
    return c.json(await ensureKindModels(body.kind as ModelKind));
  });

  return r;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
