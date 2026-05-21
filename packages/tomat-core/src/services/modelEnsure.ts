// Resolve which model files each sidecar kind needs from the current
// settings, then enqueue downloads for any that aren't on disk yet. Shared
// between `POST /api/v1/models/ensure` (explicit client-driven trigger) and
// `sidecarBoot` (implicit auto-download when applying a sidecar finds its
// model missing).

import { EMBED_BASE_FILES, TTS_BASE_FILES } from "@tomat/shared";
import { modelsManager } from "../models/manager.ts";
import { loadCoreSettings } from "./coreSettings.ts";

export type ModelKind = "llm" | "stt" | "tts" | "embed";

export interface EnsureResult {
  enqueued: string[]; // job ids
  alreadyHave: string[];
}

/** HF source specs the named sidecar kind needs given the current settings.
 *  Returns [] when the kind is disabled / on an external provider. */
export async function sourcesForKind(kind: ModelKind): Promise<string[]> {
  const settings = await loadCoreSettings();
  const str = (k: string, def: string): string => {
    const v = settings[k];
    return typeof v === "string" ? v : def;
  };
  const bool = (k: string, def: boolean): boolean => {
    const v = settings[k];
    return typeof v === "boolean" ? v : def;
  };
  switch (kind) {
    case "llm": {
      const out: string[] = [];
      if (str("llm.provider", "local") !== "local") return [];
      const model = str("llm.modelPath", "");
      if (model) out.push(model);
      if (bool("llm.supportImages", true)) {
        const mmproj = str("llm.mmprojPath", "");
        if (mmproj) out.push(mmproj);
      }
      return out;
    }
    case "stt": {
      if (!bool("stt.enabled", true)) return [];
      if (str("stt.provider", "local") !== "local") return [];
      const model = str("stt.modelPath", "");
      return model ? [model] : [];
    }
    case "tts":
      return [...TTS_BASE_FILES];
    case "embed":
      return [...EMBED_BASE_FILES];
  }
}

/** Probe + enqueue any missing files for the kind. Idempotent: files already
 *  present are reported in `alreadyHave`. */
export async function ensureKindModels(kind: ModelKind): Promise<EnsureResult> {
  const sources = await sourcesForKind(kind);
  if (sources.length === 0) return { enqueued: [], alreadyHave: [] };
  const probes = await modelsManager().probe(sources);
  const alreadyHave = probes.filter((p) => p.alreadyHave).map((p) => p.source);
  const missing = probes.filter((p) => !p.alreadyHave).map((p) => p.source);
  if (missing.length === 0) return { enqueued: [], alreadyHave };
  const enqueued = modelsManager().download(
    missing.map((source) => ({ source, group: kind })),
  );
  return { enqueued, alreadyHave };
}
