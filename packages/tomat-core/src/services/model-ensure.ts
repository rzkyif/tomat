// Resolve which model files each sidecar kind needs from the current
// settings, then enqueue downloads for any that aren't on disk yet. Shared
// between `POST /api/v1/models/ensure` (explicit client-driven trigger) and
// `sidecar-boot` (implicit auto-download when applying a sidecar finds its
// model missing).

import { requiredModelRefs } from "@tomat/shared";
import type { RequirementGroup } from "@tomat/shared";
import { modelsManager } from "../models/manager.ts";
import { loadCoreSettingsResolved } from "./core-settings.ts";

export type ModelKind = RequirementGroup;

export interface EnsureResult {
  enqueued: string[]; // job ids
  alreadyHave: string[];
}

/** HF source specs the named sidecar kind needs given the current settings.
 *  Delegates to the shared `requiredModelRefs` mapping (the single source of
 *  truth shared with the client). Returns [] when the kind is disabled / on an
 *  external provider. */
export async function sourcesForKind(kind: ModelKind): Promise<string[]> {
  const settings = await loadCoreSettingsResolved();
  return requiredModelRefs(settings)
    .filter((r) => r.group === kind)
    .map((r) => r.source);
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
  const enqueued = modelsManager().download(missing.map((source) => ({ source, group: kind })));
  return { enqueued, alreadyHave };
}
