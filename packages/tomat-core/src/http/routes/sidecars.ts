// Sidecar lifecycle routes. Status + manual stop/restart per kind.
//
// Start args are NOT user-supplied; they're computed from settings by
// services/sidecar-boot.ts. POST /restart re-applies the boot decision
// (effectively: stop + start with fresh args from the current settings),
// and POST /stop just terminates without re-spawning. /start exists as a
// convenience that's equivalent to /restart in this design.

import { Hono } from "hono";
import type { SidecarKind, SidecarSnapshot, SidecarsStatusResponse } from "@tomat/shared";
import { sidecarManager } from "../../sidecars/manager.ts";
import { loadCoreSettings } from "../../services/core-settings.ts";
import { buildLlamaStartOptions, llamaStartArgsFromSettings } from "../../sidecars/llama.ts";
import { buildWhisperStartOptions, whisperStartArgsFromSettings } from "../../sidecars/whisper.ts";
import { ttsController } from "../../sidecars/tts.ts";
import { sampleProcessMetrics } from "../../sidecars/process-metrics.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

const SUPERVISED: ReadonlySet<SidecarKind> = new Set(["llama", "whisper", "tts"]);

export function sidecarsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  // Live status + resource usage for the core process and its sidecars. The
  // set of sampled PIDs is fixed by this route (manager-tracked sidecars + the
  // tts worker + the core process); no PID is ever taken from the request.
  r.get("/status", async (c) => {
    // Manager sidecars (llama/whisper) carry `pid` on their Running snapshot;
    // tts is a separate controller, synthesized here when its worker is up.
    const sidecars: SidecarSnapshot[] = sidecarManager().getStatuses();
    const ttsPid = ttsController().pid();
    if (ttsPid !== null) {
      sidecars.push({ kind: "tts", status: "Running", pid: ttsPid });
    }

    const pids = [Deno.pid, ...sidecars.flatMap((s) => (s.pid !== undefined ? [s.pid] : []))];
    const samples = await sampleProcessMetrics(pids);

    const withMetrics = sidecars.map((s): SidecarSnapshot => {
      const m = s.pid !== undefined ? samples.get(s.pid) : undefined;
      return m ? { ...s, rssMb: m.rssMb, cpuPct: m.cpuPct } : s;
    });
    const coreSample = samples.get(Deno.pid);
    const body: SidecarsStatusResponse = {
      sidecars: withMetrics,
      core: {
        pid: Deno.pid,
        rssMb: coreSample?.rssMb ?? 0,
        cpuPct: coreSample?.cpuPct ?? 0,
      },
    };
    return c.json(body);
  });

  r.post("/:kind/stop", async (c) => {
    const kind = c.req.param("kind") as SidecarKind;
    assertSupervised(kind);
    if (kind === "tts") {
      await ttsController().unload();
    } else {
      await sidecarManager().stop(kind);
    }
    return c.body(null, 204);
  });

  // POST /:kind/start and POST /:kind/restart are equivalent: both
  // recompute the start args from current settings and (re-)start.
  for (const op of ["start", "restart"] as const) {
    r.post(`/:kind/${op}`, async (c) => {
      const kind = c.req.param("kind") as SidecarKind;
      assertSupervised(kind);
      if (kind === "tts") {
        await ttsController().ensureLoaded();
        return c.body(null, 204);
      }
      const settings = await loadCoreSettings();
      if (kind === "llama") {
        const args = llamaStartArgsFromSettings(settings);
        if (!args) {
          throw new AppError(
            "validation_error",
            "llama-server cannot start: llm.provider is not local",
          );
        }
        await sidecarManager().restart("llama", buildLlamaStartOptions(args));
      } else if (kind === "whisper") {
        const args = whisperStartArgsFromSettings(settings);
        if (!args) {
          throw new AppError(
            "validation_error",
            "whisper-server cannot start: stt is disabled or external",
          );
        }
        await sidecarManager().restart("whisper", buildWhisperStartOptions(args));
      }
      return c.body(null, 204);
    });
  }

  return r;
}

function assertSupervised(kind: SidecarKind): void {
  if (!SUPERVISED.has(kind)) {
    throw new AppError("validation_error", `sidecar "${kind}" is not externally controllable`);
  }
}
