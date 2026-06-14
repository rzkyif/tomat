// Document store CRUD + rescan. Backs the Documents settings manager and
// the client's @-autocomplete; tools reach the same store through the
// module broker instead of these routes.

import { Hono } from "hono";
import { z } from "zod";
import { documentsStore } from "../../services/documents-store.ts";
import { scheduleDocumentIndexing } from "../../services/documents-indexer.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

const createBodySchema = z
  .object({
    title: z.string().min(1),
    content: z.string().default(""),
  })
  .strict();

const patchBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
  })
  .strict();

export function documentsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => c.json({ documents: documentsStore().list() }));

  r.post("/", async (c) => {
    const parsed = createBodySchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AppError("validation_error", parsed.error.message);
    const doc = documentsStore().create(parsed.data.title, parsed.data.content);
    scheduleDocumentIndexing(doc.id);
    return c.json(doc, 201);
  });

  r.post("/rescan", (c) => {
    const result = documentsStore().rescan();
    scheduleDocumentIndexing();
    return c.json(result);
  });

  r.get("/:id", (c) => c.json(documentsStore().get(c.req.param("id"))));

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = patchBodySchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AppError("validation_error", parsed.error.message);
    if (parsed.data.title !== undefined) documentsStore().rename(id, parsed.data.title);
    if (parsed.data.content !== undefined) {
      documentsStore().replaceContent(id, parsed.data.content);
    }
    scheduleDocumentIndexing(id);
    return c.json(documentsStore().get(id));
  });

  r.delete("/:id", (c) => {
    documentsStore().delete(c.req.param("id"));
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
