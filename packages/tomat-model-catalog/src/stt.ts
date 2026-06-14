// Speech-to-Text catalog: the sherpa-onnx Whisper ONNX bundles tomat offers,
// served by the tomat-core-speech sidecar.
//
// Sources (verified against the HuggingFace API on 2026-06-14):
//  - Files + exact sizes: the csukuangfj/sherpa-onnx-whisper-<m> mirrors.
//
// Each model is a 3-file bundle (encoder + decoder + tokens). The catalog
// carries the int8 ENCODER spec as `modelSpec` and the whole-bundle download
// size as `fileSizeBytes`; the decoder + tokens are derived from sherpa's fixed
// naming convention at the use sites (sttBundleFiles in settings/engine.ts).
//
// Curation stances:
//  - Only the self-contained int8 bundles are offered: int8 is near-lossless
//    for Whisper at a fraction of the fp32 size, and the fp32 turbo/large-v3
//    builds split their weights into external `.weights` files (no longer a
//    clean 3-file bundle). One quant per model keeps the picker simple.
//  - English-only (`.en`) models match their multilingual siblings in size but
//    transcribe English slightly better, so both are listed up to small.
//  - large-v3 is omitted: turbo matches it for dictation at ~half the size, so
//    turbo is the single "accurate" option for every language including English.

import type { SttCatalog, SttCatalogModel } from "@tomat/shared";

const REPO = "csukuangfj/sherpa-onnx-whisper";

/** One int8 bundle. `m` is the sherpa file prefix, which also names the repo
 *  (e.g. "small.en" -> repo `${REPO}-small.en`, files `small.en-*`).
 *  `bundleBytes` is the summed download size of encoder.int8 + decoder.int8 +
 *  tokens, shown on the preset/model card. */
function model(
  id: string,
  name: string,
  english: boolean,
  m: string,
  bundleBytes: number,
): SttCatalogModel {
  return {
    id,
    name,
    english,
    quants: [
      {
        quant: "int8",
        modelSpec: `@${REPO}-${m}/main/${m}-encoder.int8.onnx`,
        fileSizeBytes: bundleBytes,
      },
    ],
  };
}

export const STT_CATALOG: SttCatalog = {
  models: [
    model("whisper-tiny.en", "Whisper Tiny (English)", true, "tiny.en", 103_627_191),
    model("whisper-tiny", "Whisper Tiny", false, "tiny", 103_609_903),
    model("whisper-base.en", "Whisper Base (English)", true, "base.en", 160_626_066),
    model("whisper-base", "Whisper Base", false, "base", 160_609_290),
    model("whisper-small.en", "Whisper Small (English)", true, "small.en", 375_501_079),
    model("whisper-small", "Whisper Small", false, "small", 375_485_327),
    model("whisper-medium.en", "Whisper Medium (English)", true, "medium.en", 946_086_998),
    model("whisper-turbo", "Whisper Large v3 Turbo", false, "turbo", 1_036_613_791),
  ],
  // Three cards: light English-only, light multilingual, and the accurate
  // turbo model that covers every language including English.
  presets: [
    { id: "light-english", modelId: "whisper-small.en", quant: "int8" }, // ~375 MB
    { id: "light-multilingual", modelId: "whisper-small", quant: "int8" }, // ~375 MB
    { id: "accurate", modelId: "whisper-turbo", quant: "int8" }, // ~1.04 GB
  ],
};
