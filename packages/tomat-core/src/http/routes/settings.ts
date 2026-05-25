import { Hono } from "hono";
import {
  loadCoreSettings,
  patchCoreSettings,
} from "../../services/core-settings.ts";
import {
  deleteSecret,
  listSecretNames,
  setSecret,
} from "../../services/secrets.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function settingsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", async (c) => c.json(await loadCoreSettings()));

  r.patch("/", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("validation_error", "object body required");
    }
    return c.json(await patchCoreSettings(body as Record<string, unknown>));
  });

  // --- secrets -------------------------------------------------------------
  // Stored encrypted on disk in secrets.enc (see services/secrets.ts).
  // Plan §9 / client refactor: "Client receives only boolean flags
  // indicating which keys are configured — never the values." So GET
  // returns names only; values are never read back over the API.

  r.get("/secrets", async (c) => c.json({ names: await listSecretNames() }));

  r.put("/secrets/:name", async (c) => {
    const name = c.req.param("name");
    const body = await readJson(c);
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as Record<string, unknown>).value !== "string"
    ) {
      throw new AppError(
        "validation_error",
        "body must be { value: string }",
      );
    }
    await setSecret(name, (body as { value: string }).value);
    return c.body(null, 204);
  });

  r.delete("/secrets/:name", async (c) => {
    const name = c.req.param("name");
    const ok = await deleteSecret(name);
    if (!ok) throw new AppError("not_found", `secret "${name}" not set`);
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
