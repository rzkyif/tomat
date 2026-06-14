// Scheduled prompt CRUD + manual run. Backs the Scheduled Prompts settings
// manager; agent-created schedules arrive through the schedule confirm flow
// instead of these routes.

import { Hono } from "hono";
import { z } from "zod";
import { scheduledPromptDraftSchema, scheduleSpecSchema } from "@tomat/shared";
import { promptScheduler } from "../../services/prompt-scheduler.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware, requireClient } from "../middleware/auth.ts";

const patchBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    instruction: z.string().min(1).optional(),
    schedule: scheduleSpecSchema.optional(),
    runMissed: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export function scheduledPromptsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => {
    const me = requireClient(c);
    return c.json({ scheduledPrompts: promptScheduler().list(me.id) });
  });

  r.post("/", async (c) => {
    const me = requireClient(c);
    const parsed = scheduledPromptDraftSchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AppError("validation_error", parsed.error.message);
    return c.json(promptScheduler().create(me.id, parsed.data), 201);
  });

  r.patch("/:id", async (c) => {
    const me = requireClient(c);
    const parsed = patchBodySchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AppError("validation_error", parsed.error.message);
    return c.json(promptScheduler().update(me.id, c.req.param("id"), parsed.data));
  });

  r.delete("/:id", (c) => {
    const me = requireClient(c);
    promptScheduler().delete(me.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  r.post("/:id/run", (c) => {
    const me = requireClient(c);
    const session = promptScheduler().runNow(me.id, c.req.param("id"));
    return c.json({ sessionId: session.id });
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
