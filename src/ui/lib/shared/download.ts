/**
 * Figures out which model files need downloading when settings change.
 * Compares old and new settings, picks out HuggingFace paths that are
 * actually being used (skipping ones for features the user hasn't turned
 * on), and asks the Rust downloader to plan the fetch.
 */

import { invoke } from "@tauri-apps/api/core";
import { EMBED_BASE_FILES, TTS_BASE_FILES } from "./settings";
import type { DownloadDestination } from "./types";

export type DownloadPlan = {
  path: string;
  url: string;
  filename: string;
  size_bytes: number | null;
  already_downloaded: boolean;
};

export interface EnqueueSpec {
  source: string;
  destination: DownloadDestination;
  group_id: string;
  size_hint: number | null;
}

const DOWNLOAD_FIELDS = ["llm.modelPath", "llm.mmprojPath", "stt.modelPath"] as const;

function isHfPath(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("@") && v.length > 1;
}

/**
 * Compare prev vs next settings; return HF paths referenced by next that
 * were changed or newly set, filtering out paths that are not currently
 * in effect based on related toggles (e.g. mmproj only matters when
 * llm.supportImages is true, model paths only matter for non-external presets).
 */
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

  // Text-to-speech assets. Voice tensors ship bundled with the runtime, so we
  // only ever propose the shared model/tokenizer files - and only the first
  // time TTS is enabled.
  const ttsPrevActive = !!prev["tts.enabled"];
  const ttsNextActive = !!next["tts.enabled"];
  if (ttsNextActive && !ttsPrevActive) {
    for (const f of TTS_BASE_FILES) out.push(f);
  }

  return out;
}

export async function planDownloads(paths: string[]): Promise<DownloadPlan[]> {
  if (paths.length === 0) return [];
  const plans = (await invoke("probe_downloads", { paths })) as DownloadPlan[];
  return plans.filter((p) => !p.already_downloaded);
}

/**
 * Map a settings key (e.g. `llm.modelPath`, `stt.modelPath`) to the
 * corresponding settings group id, used by the Downloads modal to pick a
 * row icon. TTS asset paths come in via the `tts.enabled` toggle.
 */
export function inferGroupIdFromKey(key: string): string {
  if (key.startsWith("llm.")) return "llm";
  if (key.startsWith("stt.")) return "stt";
  if (key.startsWith("tts.")) return "tts";
  if (key.startsWith("toolkits.")) return "toolkits";
  return "general";
}

/**
 * Convert a probe-side `DownloadPlan` into the manager-side `EnqueueSpec`.
 * Models are the only currently-supported destination; future destinations
 * (snippets, presets) reuse the same plumbing.
 */
export function planToEnqueueSpec(plan: DownloadPlan, groupId: string): EnqueueSpec {
  return {
    source: plan.path,
    destination: "Models",
    group_id: groupId,
    size_hint: plan.size_bytes,
  };
}

export async function enqueueDownloads(items: EnqueueSpec[]): Promise<void> {
  if (items.length === 0) return;
  await invoke("enqueue_downloads", { items });
}

export interface ActiveDownloadCandidate {
  path: string;
  group_id: string;
}

/**
 * Walk the current settings and return every HuggingFace path the active
 * configuration references, paired with the settings group id that drives
 * its row icon in the Downloads modal. Used at startup to detect missing
 * required files; the result feeds the auto-shown ConfirmModal and the
 * input-disable + gear-blink UX cues.
 */
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
  // The toolkit tool-relevance filter always uses the embedding model -
  // include it so the user can see it queued alongside the obvious ones.
  for (const f of EMBED_BASE_FILES) {
    out.push({ path: f, group_id: "toolkits" });
  }
  return out;
}

export interface StartupProbeResult {
  /** Probe results for every missing required file, in the same order
   *  collectActiveDownloads returned them. */
  plans: DownloadPlan[];
  /** Maps `plan.path` (the HF source string) to the settings group id so
   *  the Downloads modal row icon resolves correctly and downstream
   *  enqueue calls can pass the right group_id. */
  groupBySource: Record<string, string>;
}

/**
 * Probe every HF path the current configuration references and return the
 * subset that isn't already on disk, plus a path → group_id mapping.
 * Caller is responsible for surfacing this to the user (input-disable
 * cue, blinking gear, auto-shown ConfirmModal on settings open).
 */
export async function detectPendingStartup(
  settings: Record<string, any>,
): Promise<StartupProbeResult> {
  const candidates = collectActiveDownloads(settings);
  if (candidates.length === 0) return { plans: [], groupBySource: {} };
  const groupBySource: Record<string, string> = {};
  for (const c of candidates) groupBySource[c.path] = c.group_id;

  const paths = candidates.map((c) => c.path);
  const allPlans = (await invoke("probe_downloads", { paths })) as DownloadPlan[];
  const missing = allPlans.filter((p) => !p.already_downloaded);
  return { plans: missing, groupBySource };
}
