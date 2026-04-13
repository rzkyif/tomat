import { invoke } from "@tauri-apps/api/core";
import { TTS_BASE_FILES } from "./settings";

export type DownloadPlan = {
  path: string;
  url: string;
  filename: string;
  size_bytes: number | null;
  already_downloaded: boolean;
};

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
  const llmActive = next["llm.preset"] !== "external";
  const sttActive = next["stt.preset"] !== "external" && next["stt.preset"] !== "disabled";
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
