import { Hono } from "hono";
import type { DeleteStoragePathsRequest } from "@tomat/shared";
import { buildStorageTree, clearModels, deleteStoragePaths } from "../../services/storage.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function storageRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  // The on-disk storage tree (downloaded models + sizes) for the Settings view.
  r.get("/", async (c) => c.json(await buildStorageTree()));

  // Delete the selected model files/folders (validated to sit under the models
  // dir). Recomputes requirements so a now-missing model re-surfaces.
  r.post("/delete", async (c) => {
    const body = (await readJson(c)) as DeleteStoragePathsRequest;
    if (!Array.isArray(body.paths)) {
      throw new AppError("validation_error", "paths array required");
    }
    await deleteStoragePaths(body.paths);
    return c.body(null, 204);
  });

  // Remove every downloaded model.
  r.post("/clear-models", async (c) => {
    await clearModels();
    return c.body(null, 204);
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
