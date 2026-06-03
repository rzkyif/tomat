// The single authoritative "required files" computation: given the current
// settings, what model files and sidecar binaries does the configuration need,
// and which are missing. The client renders this as one pending-downloads
// popup and gates the app on it. Recomputed + broadcast over WS whenever the
// inputs change (settings, a finished download, an installed binary).

import type { RequiredFile, RequirementsSnapshot } from "@tomat/shared";
import {
  binaryUnavailableOnTriple,
  binarySource,
  requiredBinaryKinds,
  requiredModelRefs,
} from "@tomat/shared";
import { loadCoreSettingsResolved } from "./core-settings.ts";
import { modelsManager } from "../models/manager.ts";
import { binariesManager } from "../binaries/manager.ts";
import { hostTriple } from "../binaries/versions.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("requirements");

/** Compute the full required-files list (models + binaries) and the missing
 *  subset for the current settings. Network HEADs happen only for missing
 *  models (present files short-circuit) and for missing-available binaries. */
export async function computeRequirements(): Promise<RequirementsSnapshot> {
  const settings = await loadCoreSettingsResolved();

  // Models: dedupe by source (embed/tts base files are fixed; llm/stt could
  // theoretically collide). Keep the first group seen.
  const seen = new Set<string>();
  const modelRefs = requiredModelRefs(settings).filter((r) => {
    if (seen.has(r.source)) return false;
    seen.add(r.source);
    return true;
  });
  const modelProbes = await modelsManager().probe(modelRefs.map((r) => r.source));
  const probeBySource = new Map(modelProbes.map((p) => [p.source, p]));

  const required: RequiredFile[] = modelRefs.map((ref) => {
    const probe = probeBySource.get(ref.source);
    const present = probe?.alreadyHave ?? false;
    return {
      source: ref.source,
      type: "model",
      group: ref.group,
      present,
      sizeHint: present ? undefined : probe?.sizeHint,
    };
  });

  // Binaries: installed-ness is a local check; only probe (GitHub-cached) the
  // missing-and-available kinds for a version/size to show in the popup.
  const triple = hostTriple();
  const binKinds = requiredBinaryKinds(settings);
  const list = await binariesManager()
    .list()
    .catch(() => []);
  const installed = new Set(list.filter((b) => b.installed).map((b) => b.kind));
  const missingAvailable = binKinds.filter(
    (k) => !installed.has(k) && !binaryUnavailableOnTriple(k, triple),
  );
  const binProbes =
    missingAvailable.length > 0
      ? await binariesManager()
          .probe(missingAvailable)
          .catch(() => [])
      : [];
  const binProbeByKind = new Map(binProbes.map((p) => [p.kind, p]));

  for (const kind of binKinds) {
    const present = installed.has(kind);
    const unavailable = !present && binaryUnavailableOnTriple(kind, triple);
    const probe = present ? undefined : binProbeByKind.get(kind);
    required.push({
      source: binarySource(kind),
      type: "binary",
      group: "binary",
      present,
      unavailable: unavailable || undefined,
      sizeHint: probe?.sizeBytes,
      version: probe && probe.version !== "unknown" ? probe.version : undefined,
    });
  }

  const missing = required.filter((r) => !r.present && !r.unavailable);
  return { required, missing };
}

// --- change notification ----------------------------------------------------

type RequirementsListener = (snap: RequirementsSnapshot) => void;
const listeners = new Set<RequirementsListener>();

/** Subscribe to recomputed requirements snapshots (the WS hub uses this to
 *  rebroadcast). */
export function onRequirementsChanged(fn: RequirementsListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Recompute and fan out to listeners. Called from the settings-change,
 *  download-completion, and binary-installed triggers. Fire-and-forget safe:
 *  a failed recompute logs and skips the broadcast rather than throwing. */
export async function notifyRequirementsChanged(): Promise<void> {
  let snap: RequirementsSnapshot;
  try {
    snap = await computeRequirements();
  } catch (err) {
    log.warn(`requirements recompute failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch (err) {
      log.warn(`requirements listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function __resetListenersForTesting(): void {
  listeners.clear();
}
