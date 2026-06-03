import { Hono } from "hono";
import type { BinaryKind } from "@tomat/shared";
import { binarySourceToKind } from "@tomat/shared";
import { computeRequirements } from "../../services/requirements.ts";
import { ensureKindModels, type ModelKind } from "../../services/model-ensure.ts";
import { binariesManager } from "../../binaries/manager.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function requirementsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  // The full required-files list + the missing subset for the current config.
  r.get("/", async (c) => c.json(await computeRequirements()));

  // Download everything missing: enqueue each missing model group (reusing the
  // probe+enqueue+dedup in ensureKindModels) and install the missing binaries.
  // `missing` already excludes binaries unavailable on this platform.
  r.post("/download", async (c) => {
    const snap = await computeRequirements();

    const groups = new Set<ModelKind>(
      snap.missing.filter((m) => m.type === "model").map((m) => m.group as ModelKind),
    );
    const modelJobIds: string[] = [];
    for (const g of groups) {
      const res = await ensureKindModels(g);
      modelJobIds.push(...res.enqueued);
    }

    const binKinds: BinaryKind[] = snap.missing
      .filter((m) => m.type === "binary")
      .map((m) => binarySourceToKind(m.source));
    const { jobIds: binaryJobIds } =
      binKinds.length > 0 ? await binariesManager().install(binKinds) : { jobIds: [] };

    return c.json({ modelJobIds, binaryJobIds });
  });

  return r;
}
