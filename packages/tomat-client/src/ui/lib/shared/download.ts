/**
 * Helpers for the Downloads modal: planning/probing model downloads when
 * settings change. After the rework, probes go through `cores().api().models`
 * instead of Tauri commands.
 */

import { cores } from "$lib/core";
import type { BinaryKind, DownloadPlan as SharedDownloadPlan } from "@tomat/shared";
import { EMBED_BASE_FILES, TTS_BASE_FILES } from "@tomat/shared";

export type DownloadPlan = SharedDownloadPlan;

const DOWNLOAD_FIELDS = ["llm.modelPath", "llm.mmprojPath", "stt.modelPath"] as const;

function isHfPath(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("@") && v.length > 1;
}

export function collectDownloadCandidates(
  prev: Record<string, any>,
  next: Record<string, any>,
): string[] {
  const out: string[] = [];
  const llmActive = next["llm.provider"] !== "external";
  const sttActive = !!next["stt.enabled"] && next["stt.provider"] !== "external";
  const imagesOn = !!next["llm.supportImages"];

  for (const key of DOWNLOAD_FIELDS) {
    const newVal = next[key];
    if (!isHfPath(newVal)) continue;
    if (newVal === prev[key]) continue;
    if (key === "llm.modelPath" && !llmActive) continue;
    if (key === "llm.mmprojPath" && (!llmActive || !imagesOn)) continue;
    if (key === "stt.modelPath" && !sttActive) continue;
    out.push(newVal);
  }

  const ttsPrevActive = !!prev["tts.enabled"];
  const ttsNextActive = !!next["tts.enabled"];
  if (ttsNextActive && !ttsPrevActive) {
    for (const f of TTS_BASE_FILES) out.push(f);
  }
  return out;
}

export async function planDownloads(paths: string[]): Promise<DownloadPlan[]> {
  if (paths.length === 0) return [];
  const plans = await cores().api().models.probe(paths);
  return plans.filter((p) => !p.alreadyHave);
}

export function inferGroupIdFromKey(key: string): string {
  if (key.startsWith("llm.")) return "llm";
  if (key.startsWith("stt.")) return "stt";
  if (key.startsWith("tts.")) return "tts";
  if (key.startsWith("toolkits.")) return "toolkits";
  return "general";
}

export async function enqueueDownloads(
  items: Array<{ source: string; group?: "llm" | "stt" | "tts" | "embed" }>,
): Promise<void> {
  if (items.length === 0) return;
  await cores().api().models.download({ items });
}

export interface ActiveDownloadCandidate {
  path: string;
  group_id: string;
}

export function collectActiveDownloads(settings: Record<string, any>): ActiveDownloadCandidate[] {
  const out: ActiveDownloadCandidate[] = [];
  const llmActive = settings["llm.provider"] !== "external";
  const sttActive = !!settings["stt.enabled"] && settings["stt.provider"] !== "external";
  const imagesOn = !!settings["llm.supportImages"];
  const ttsActive = !!settings["tts.enabled"];

  if (llmActive && isHfPath(settings["llm.modelPath"])) {
    out.push({ path: settings["llm.modelPath"], group_id: "llm" });
  }
  if (llmActive && imagesOn && isHfPath(settings["llm.mmprojPath"])) {
    out.push({ path: settings["llm.mmprojPath"], group_id: "llm" });
  }
  if (sttActive && isHfPath(settings["stt.modelPath"])) {
    out.push({ path: settings["stt.modelPath"], group_id: "stt" });
  }
  if (ttsActive) {
    for (const f of TTS_BASE_FILES) out.push({ path: f, group_id: "tts" });
  }
  for (const f of EMBED_BASE_FILES) {
    out.push({ path: f, group_id: "toolkits" });
  }
  return out;
}

/** Synthetic source prefix for sidecar binaries surfaced through the same
 *  DownloadPlan list as HF models. Settings.svelte filters by this prefix
 *  to route the confirm action to `binaries.install` instead of
 *  `models.download`. */
export const BINARY_SOURCE_PREFIX = "binary:";

export function isBinarySource(source: string): boolean {
  return source.startsWith(BINARY_SOURCE_PREFIX);
}

export function binarySourceToKind(source: string): BinaryKind {
  return source.slice(BINARY_SOURCE_PREFIX.length) as BinaryKind;
}

export interface StartupProbeResult {
  plans: DownloadPlan[];
  groupBySource: Record<string, string>;
  missingBinaries: BinaryKind[];
}

export async function detectPendingStartup(
  settings: Record<string, any>,
): Promise<StartupProbeResult> {
  const candidates = collectActiveDownloads(settings);
  const groupBySource: Record<string, string> = {};
  for (const c of candidates) groupBySource[c.path] = c.group_id;

  // Probe HF models + sidecar binaries in parallel — they're independent
  // and the confirm modal shows them as one combined list.
  const [modelPlans, binaryChecks] = await Promise.all([
    candidates.length > 0
      ? cores()
          .api()
          .models.probe(candidates.map((c) => c.path))
      : Promise.resolve([]),
    cores()
      .api()
      .binaries.list()
      .catch(() => []),
  ]);

  const missingModels = modelPlans.filter((p) => !p.alreadyHave);
  const missingBinaries = binaryChecks.filter((b) => !b.installed).map((b) => b.kind);

  // Synthesize DownloadPlan entries for each missing binary so the existing
  // ConfirmModal renders them in the same list as model files.
  const binaryPlans: DownloadPlan[] = missingBinaries.map((kind) => ({
    source: `${BINARY_SOURCE_PREFIX}${kind}`,
    alreadyHave: false,
  }));
  for (const kind of missingBinaries) {
    groupBySource[`${BINARY_SOURCE_PREFIX}${kind}`] = "binary";
  }

  return {
    plans: [...missingModels, ...binaryPlans],
    groupBySource,
    missingBinaries,
  };
}
