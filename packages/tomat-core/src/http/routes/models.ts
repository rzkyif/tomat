import { Hono } from "hono";
import { modelsManager } from "../../models/manager.ts";
import { downloadManager } from "../../downloads/manager.ts";
import { ensureKindModels } from "../../services/model-ensure.ts";
import { notifyRequirementsChanged } from "../../services/requirements.ts";
import { loadModelCatalog } from "../../models/catalog.ts";
import { detectHardware } from "../../models/hardware.ts";
import {
  appliedForModelSpec,
  buildCatalogViews,
  computeRecommendations,
} from "../../models/fit.ts";
import { buildSttPresetViews, resolveSttSelection } from "../../models/stt.ts";
import { buildTtsPresetViews, resolveTtsSelection } from "../../models/tts.ts";
import { loadCoreSettings, patchCoreSettings } from "../../services/core-settings.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";
import { type AppliedModelSettings, PRESET_BUCKETS, type PresetBucket } from "@tomat/shared";

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

  // Drop any Completed rows whose file has since been deleted before returning
  // the queue, so a download whose model was removed (in-app or externally)
  // self-clears from the list instead of lingering.
  r.get("/downloads", async (c) => {
    await downloadManager().reconcileCompleted();
    return c.json(modelsManager().downloads());
  });

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

  // --- adaptive presets + model browser ------------------------------------

  // The three computed presets for this device, plus what settings currently
  // point at (so the client can flag a better option).
  r.get("/recommend", async (c) => {
    const [catalog, hw, settings] = await Promise.all([
      loadModelCatalog(),
      detectHardware(),
      loadCoreSettings(),
    ]);
    return c.json(computeRecommendations(catalog, hw, appliedFromSettings(settings)));
  });

  // Force-refresh the catalog + re-probe hardware, then recompute. Used by the
  // non-destructive "Check for better models" action.
  r.post("/recommend/recheck", async (c) => {
    const [catalog, hw, settings] = await Promise.all([
      loadModelCatalog({ force: true }),
      detectHardware(true),
      loadCoreSettings(),
    ]);
    return c.json(computeRecommendations(catalog, hw, appliedFromSettings(settings)));
  });

  // Full model list annotated with fit-on-this-device + the settings each would
  // apply (the model browser).
  r.get("/catalog", async (c) => {
    const [catalog, hw] = await Promise.all([loadModelCatalog(), detectHardware()]);
    return c.json({ generatedAt: catalog.generatedAt, models: buildCatalogViews(catalog, hw) });
  });

  // Apply a preset bucket or a specific catalog model: write the llm.* settings
  // (which makes sidecar-boot restart llama). Does NOT download: writing
  // settings triggers a requirements recompute (ws/hub), which surfaces any
  // missing model file in the client's pending-downloads confirm modal.
  // Downloading multi-GB weights is always the user's explicit choice, never a
  // side effect of selecting a preset.
  r.post("/select", async (c) => {
    const body = (await readJson(c)) as { bucket?: string; modelId?: string; modelSpec?: string };
    const apply = await resolveSelection(body);
    await patchCoreSettings(applyToPatch(apply.settings, apply.preset));
    return c.json({ applied: apply });
  });

  // --- Speech-to-Text catalog picker ----------------------------------------

  // The whole whisper lineup plus the resolved curated cards. No fit engine:
  // whisper models are 31 MB to 3.1 GB, so everything fits everywhere.
  r.get("/stt/catalog", async (c) => {
    const catalog = await loadModelCatalog();
    return c.json({
      generatedAt: catalog.generatedAt,
      models: catalog.stt.models,
      presets: buildSttPresetViews(catalog),
    });
  });

  // Apply a curated card or a specific model/quant: write the stt.* settings
  // (which makes sidecar-boot reconfigure the speech sidecar). Like the LLM select,
  // never downloads; the settings write surfaces any missing model file in the
  // client's pending-downloads confirm modal.
  r.post("/stt/select", async (c) => {
    const body = (await readJson(c)) as {
      presetId?: string;
      modelId?: string;
      modelSpec?: string;
    };
    const [catalog, hw] = await Promise.all([loadModelCatalog(), detectHardware()]);
    const applied = resolveSttSelection(catalog, hw, body);
    await patchCoreSettings({
      "stt.provider": "local",
      "stt.preset": applied.preset,
      "stt.modelType": applied.settings.modelType,
      "stt.modelPath": applied.settings.modelPath,
      "stt.modelFiles": applied.settings.modelFiles,
      "stt.threads": applied.settings.threads,
    });
    return c.json({ applied });
  });

  // --- Text-to-Speech catalog picker ----------------------------------------

  // The whole TTS lineup plus the resolved curated cards (with each model's
  // voices, so the voice dropdown can populate from the selection). No fit
  // engine: TTS bundles are small and all fit everywhere.
  r.get("/tts/catalog", async (c) => {
    const catalog = await loadModelCatalog();
    return c.json({
      generatedAt: catalog.generatedAt,
      models: catalog.tts.models,
      presets: buildTtsPresetViews(catalog),
    });
  });

  // Apply a curated card or a specific model/quant: write the tts.* settings
  // (which makes sidecar-boot reconfigure the speech sidecar). Like STT select,
  // never downloads; the settings write surfaces any missing file in the
  // client's pending-downloads confirm modal. Picking a model resets tts.voice
  // to that model's default voice.
  r.post("/tts/select", async (c) => {
    const body = (await readJson(c)) as {
      presetId?: string;
      modelId?: string;
      modelSpec?: string;
    };
    const catalog = await loadModelCatalog();
    const applied = resolveTtsSelection(catalog, body);
    await patchCoreSettings({
      "tts.preset": applied.preset,
      "tts.modelType": applied.settings.modelType,
      "tts.modelPath": applied.settings.modelPath,
      "tts.modelFiles": applied.settings.modelFiles,
      "tts.voice": applied.settings.voice,
    });
    return c.json({ applied });
  });

  // Delete a model file by its path. Registered last: the `{.+}` catch-all
  // would otherwise shadow the specific `/downloads/...` routes above (a DELETE
  // to /downloads/:id would be misread as deleting a file at "downloads/<id>").
  r.delete("/:relPath{.+}", async (c) => {
    await modelsManager().delete(c.req.param("relPath"));
    // A deleted model file can re-expose a requirement (computeRequirements
    // only re-probes when notified), so recompute now; otherwise the client's
    // pending-downloads snapshot keeps reporting the file as present.
    void notifyRequirementsChanged();
    return c.body(null, 204);
  });

  return r;
}

/** Resolve a {bucket|modelId|modelSpec} selection into the settings to apply. */
async function resolveSelection(body: {
  bucket?: string;
  modelId?: string;
  modelSpec?: string;
}): Promise<{ preset: string; settings: AppliedModelSettings }> {
  const [catalog, hw, settings] = await Promise.all([
    loadModelCatalog(),
    detectHardware(),
    loadCoreSettings(),
  ]);
  if (body.bucket) {
    if (!(PRESET_BUCKETS as readonly string[]).includes(body.bucket)) {
      throw new AppError("validation_error", `unknown bucket: ${body.bucket}`);
    }
    const rec = computeRecommendations(catalog, hw, appliedFromSettings(settings)).buckets[
      body.bucket as PresetBucket
    ];
    if (!rec) throw new AppError("validation_error", `no model fits the "${body.bucket}" preset`);
    return { preset: body.bucket, settings: rec.apply };
  }
  // A specific quant (by its unique modelSpec) from the manual picker.
  if (body.modelSpec) {
    const resolved = appliedForModelSpec(catalog, hw, body.modelSpec);
    if (!resolved) throw new AppError("not_found", `quant not in catalog: ${body.modelSpec}`);
    return { preset: "custom", settings: resolved.apply };
  }
  if (body.modelId) {
    const view = buildCatalogViews(catalog, hw).find((m) => m.id === body.modelId);
    if (!view) throw new AppError("not_found", `model not in catalog: ${body.modelId}`);
    return { preset: "custom", settings: view.apply };
  }
  throw new AppError("validation_error", "bucket, modelId, or modelSpec required");
}

function applyToPatch(a: AppliedModelSettings, preset: string): Record<string, unknown> {
  return {
    "llm.provider": "local",
    "llm.preset": preset,
    "llm.modelPath": a.modelPath,
    "llm.mmprojPath": a.mmprojPath ?? "",
    "llm.contextSize": a.contextSize,
    "llm.threads": a.threads,
    "llm.gpuLayers": a.gpuLayers,
    "llm.flashAttn": a.flashAttn,
    "llm.supportImages": a.supportImages,
    "llm.idleUnloadSeconds": a.idleUnloadSeconds,
    "llm.reasoningBudget": a.reasoningBudget,
    // Sampling is always written (even at the default), so switching models
    // resets these to the new model's tuning rather than leaving stale values.
    "llm.temperature": a.temperature,
    "llm.topP": a.topP,
    "llm.topK": a.topK,
    "llm.minP": a.minP,
    "llm.repeatPenalty": a.repeatPenalty,
  };
}

function appliedFromSettings(s: Record<string, unknown>): { preset?: string; modelPath?: string } {
  const preset = typeof s["llm.preset"] === "string" ? (s["llm.preset"] as string) : undefined;
  const modelPath =
    typeof s["llm.modelPath"] === "string" ? (s["llm.modelPath"] as string) : undefined;
  return { preset, modelPath };
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
