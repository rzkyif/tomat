// Greeting trigger. The client POSTs /run once per app start (after its
// first core connect) with how it was launched; core decides from the
// greetings.* settings whether that start earns an automated greeting
// session and reports what it did. The session itself starts asynchronously
// once the local model is done loading (the connected edge that triggers
// this POST is exactly when llama begins loading on boot, so an immediate
// turn would race the load and error); the client navigates via the
// session.created frame, not this response.
//
// Settings read here (defaults mirror the shared schema):
//   greetings.enabled      : boolean (default false)
//   greetings.runOn        : "autostart" | "every_start" (default "autostart")
//   greetings.sessionTitle : string (default "Greeting {datetime}")
//   greetings.instruction  : string (default DEFAULT_GREETING_INSTRUCTION)

import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_GREETING_INSTRUCTION, errMessage } from "@tomat/shared";
import { runAutomatedSession } from "../../services/automated-session.ts";
import { loadCoreSettings } from "../../services/core-settings.ts";
import { llmStillLoading } from "../../services/prompt-scheduler.ts";
import { AppError } from "../../shared/errors.ts";
import { getLogger } from "../../shared/log.ts";
import { bearerMiddleware, requireClient } from "../middleware/auth.ts";

const log = getLogger("greetings");

// One greeting per client per window: `launch` is client-asserted, so a
// crash-looping client (or a buggy caller) must not mint a session per
// retry. Suppressed runs answer ran:false so an autostarted launch still
// reveals its window.
const GREETING_MIN_INTERVAL_MS = 60_000;
// How long to wait for the local model before starting the turn anyway
// (an error then surfaces in the session, which still reveals the window).
const GREETING_READY_TIMEOUT_MS = 180_000;
const GREETING_READY_POLL_MS = 2_000;

const lastGreetingAtByClient = new Map<string, number>();

const runBodySchema = z
  .object({
    launch: z.enum(["autostart", "manual"]),
  })
  .strict();

export function greetingsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.post("/run", async (c) => {
    const me = requireClient(c);
    const parsed = runBodySchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AppError("validation_error", parsed.error.message);
    const settings = await loadCoreSettings();
    if (settings["greetings.enabled"] !== true) {
      return c.json({ ran: false, reason: "disabled" });
    }
    const runOn = strSetting(settings, "greetings.runOn", "autostart");
    if (runOn === "autostart" && parsed.data.launch !== "autostart") {
      return c.json({ ran: false, reason: "manual_launch" });
    }
    const last = lastGreetingAtByClient.get(me.id);
    if (last !== undefined && Date.now() - last < GREETING_MIN_INTERVAL_MS) {
      return c.json({ ran: false, reason: "recent" });
    }
    lastGreetingAtByClient.set(me.id, Date.now());
    const instruction =
      strSetting(settings, "greetings.instruction", DEFAULT_GREETING_INSTRUCTION).trim() ||
      DEFAULT_GREETING_INSTRUCTION;
    void runGreetingWhenReady(
      me.id,
      strSetting(settings, "greetings.sessionTitle", "Greeting {datetime}"),
      instruction,
    );
    return c.json({ ran: true });
  });

  return r;
}

// Mirror of the scheduler's defer-while-loading: hold the greeting until the
// local model is up so the turn doesn't race the boot-time load.
async function runGreetingWhenReady(
  ownerClientId: string,
  title: string,
  instruction: string,
): Promise<void> {
  try {
    const deadline = Date.now() + GREETING_READY_TIMEOUT_MS;
    while (await llmStillLoading()) {
      if (Date.now() > deadline) {
        log.warn("local model still loading after wait budget; starting the greeting anyway");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, GREETING_READY_POLL_MS));
    }
    runAutomatedSession({
      ownerClientId,
      title,
      instruction,
      reason: "greeting",
      focus: "show_when_done",
    });
  } catch (err) {
    log.error(`greeting failed to start: ${errMessage(err)}`);
  }
}

function strSetting(s: Record<string, unknown>, key: string, def: string): string {
  const v = s[key];
  return typeof v === "string" && v.length > 0 ? v : def;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
