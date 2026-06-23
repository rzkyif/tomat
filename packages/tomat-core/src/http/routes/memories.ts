// Memory store CRUD + rescan. Backs the Memories settings manager and
// the client's @-autocomplete; tools reach the same store through the
// module broker instead of these routes.

import { Hono } from "hono";
import { z } from "zod";
import { memoriesStore } from "../../services/memories-store.ts";
import { scheduleMemoryIndexing } from "../../services/memories-indexer.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

const createBodySchema = z
  .object({
    kind: z.enum(["knowledge", "skill"]).default("knowledge"),
    title: z.string().min(1),
    content: z.string().default(""),
  })
  .strict();

const patchBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export function memoriesRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => c.json({ memories: memoriesStore().list() }));

  r.post("/", async (c) => {
    const parsed = createBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const doc = memoriesStore().create(parsed.data.kind, parsed.data.title, parsed.data.content);
    scheduleMemoryIndexing(doc.id);
    return c.json(doc, 201);
  });

  r.post("/rescan", (c) => {
    const result = memoriesStore().rescan();
    scheduleMemoryIndexing();
    return c.json(result);
  });

  r.get("/:id", (c) => c.json(memoriesStore().get(c.req.param("id"))));

  // One bundled reference file from a skill folder.
  r.get("/:id/files/:name", (c) =>
    c.json({
      content: memoriesStore().getFile(c.req.param("id"), c.req.param("name")),
    }),
  );

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = patchBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    if (parsed.data.enabled !== undefined) {
      memoriesStore().setEnabled(id, parsed.data.enabled);
    }
    if (parsed.data.title !== undefined) {
      memoriesStore().rename(id, parsed.data.title);
    }
    if (parsed.data.content !== undefined) {
      memoriesStore().replaceContent(id, parsed.data.content);
    }
    scheduleMemoryIndexing(id);
    return c.json(memoriesStore().get(id));
  });

  r.delete("/:id", (c) => {
    memoriesStore().delete(c.req.param("id"));
    return c.json({ ok: true });
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
