import { Hono } from "hono";
import type { BinaryKind } from "@tomat/shared";
import { binariesManager } from "../../binaries/manager.ts";
import { loadBinaryManifest } from "../../binaries/manifest.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function binariesRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", async (c) => c.json(await binariesManager().list()));

  r.post("/install", async (c) => {
    const body = (await readJson(c)) as { kinds?: BinaryKind[] };
    const result = await binariesManager().install(body.kinds);
    return c.json(result);
  });

  r.post("/update", async (c) => {
    const body = (await readJson(c)) as { kind: BinaryKind };
    if (!body.kind) throw new AppError("validation_error", "kind required");
    return c.json(await binariesManager().update(body.kind));
  });

  r.get("/manifest", async (c) => c.json(await loadBinaryManifest()));

  r.get("/check", async (c) => c.json(await binariesManager().check()));

  return r;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
