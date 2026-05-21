/**
 * Helpers for the Downloads modal: planning/probing model downloads when
 * settings change. After the rework, probes go through `cores().api().models`
 * instead of Tauri commands.
 */

import { cores } from "$lib/core";
import type { DownloadPlan as SharedDownloadPlan } from "@tomat/shared";
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

export interface StartupProbeResult {
  plans: DownloadPlan[];
  groupBySource: Record<string, string>;
}

export async function detectPendingStartup(
  settings: Record<string, any>,
): Promise<StartupProbeResult> {
  const candidates = collectActiveDownloads(settings);
  if (candidates.length === 0) return { plans: [], groupBySource: {} };
  const groupBySource: Record<string, string> = {};
  for (const c of candidates) groupBySource[c.path] = c.group_id;
  const sources = candidates.map((c) => c.path);
  const all = await cores().api().models.probe(sources);
  const missing = all.filter((p) => !p.alreadyHave);
  return { plans: missing, groupBySource };
}
