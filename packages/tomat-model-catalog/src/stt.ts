// Speech-to-Text catalog: every whisper.cpp GGML model tomat offers.
//
// Sources (verified against the HuggingFace API on 2026-06-11):
//  - Files + exact sizes: ggerganov/whisper.cpp on HuggingFace.
//
// Curation stances:
//  - Quants are ordered best quality first. Q8_0 is effectively lossless for
//    whisper at about half the F16 size, so the curated cards prefer it. Quant
//    naming follows upstream: tiny/base/small ship q5_1, medium/large q5_0,
//    and large-v3 has no q8_0 build.
//  - large-v1 is omitted: superseded by large-v2 at identical size, no quants.
//    large-v2 stays as the lower-hallucination fallback to large-v3.
//  - Distil-Whisper is omitted: whisper.cpp flags its support as sub-optimal
//    (sequential decoding only) and short-utterance dictation is encoder-bound,
//    so large-v3-turbo dominates it on this stack.

import type { CatalogQuant, SttCatalog } from "@tomat/shared";

const spec = (file: string) => `@ggerganov/whisper.cpp/main/${file}`;

/** Quant ladder for one whisper model: F16, Q8_0, then the q5 build. `q5quant`
 *  is "Q5_1" for tiny/base/small and "Q5_0" for medium/large (upstream naming).
 *  Pass 0 for a missing build (large-v3 has no q8). */
function quants(
  base: string,
  sizes: { f16: number; q8: number; q5: number },
  q5quant: string,
): CatalogQuant[] {
  const out: CatalogQuant[] = [
    { quant: "F16", modelSpec: spec(`ggml-${base}.bin`), fileSizeBytes: sizes.f16 },
  ];
  if (sizes.q8 > 0) {
    out.push({
      quant: "Q8_0",
      modelSpec: spec(`ggml-${base}-q8_0.bin`),
      fileSizeBytes: sizes.q8,
    });
  }
  out.push({
    quant: q5quant,
    modelSpec: spec(`ggml-${base}-${q5quant.toLowerCase()}.bin`),
    fileSizeBytes: sizes.q5,
  });
  return out;
}

export const STT_CATALOG: SttCatalog = {
  models: [
    {
      id: "whisper-tiny",
      name: "Whisper Tiny",
      english: false,
      quants: quants("tiny", { f16: 77691713, q8: 43537433, q5: 32152673 }, "Q5_1"),
    },
    {
      id: "whisper-tiny.en",
      name: "Whisper Tiny (English)",
      english: true,
      quants: quants("tiny.en", { f16: 77704715, q8: 43550795, q5: 32166155 }, "Q5_1"),
    },
    {
      id: "whisper-base",
      name: "Whisper Base",
      english: false,
      quants: quants("base", { f16: 147951465, q8: 81768585, q5: 59707625 }, "Q5_1"),
    },
    {
      id: "whisper-base.en",
      name: "Whisper Base (English)",
      english: true,
      quants: quants("base.en", { f16: 147964211, q8: 81781811, q5: 59721011 }, "Q5_1"),
    },
    {
      id: "whisper-small",
      name: "Whisper Small",
      english: false,
      quants: quants("small", { f16: 487601967, q8: 264464607, q5: 190085487 }, "Q5_1"),
    },
    {
      id: "whisper-small.en",
      name: "Whisper Small (English)",
      english: true,
      quants: quants("small.en", { f16: 487614201, q8: 264477561, q5: 190098681 }, "Q5_1"),
    },
    {
      id: "whisper-medium",
      name: "Whisper Medium",
      english: false,
      quants: quants("medium", { f16: 1533763059, q8: 823369779, q5: 539212467 }, "Q5_0"),
    },
    {
      id: "whisper-medium.en",
      name: "Whisper Medium (English)",
      english: true,
      quants: quants("medium.en", { f16: 1533774781, q8: 823382461, q5: 539225533 }, "Q5_0"),
    },
    {
      id: "whisper-large-v2",
      name: "Whisper Large v2",
      english: false,
      quants: quants("large-v2", { f16: 3094623691, q8: 1656129691, q5: 1080732091 }, "Q5_0"),
    },
    {
      id: "whisper-large-v3",
      name: "Whisper Large v3",
      english: false,
      quants: quants("large-v3", { f16: 3095033483, q8: 0, q5: 1081140203 }, "Q5_0"),
    },
    {
      id: "whisper-large-v3-turbo",
      name: "Whisper Large v3 Turbo",
      english: false,
      quants: quants("large-v3-turbo", { f16: 1624555275, q8: 874188075, q5: 574041195 }, "Q5_0"),
    },
  ],
  // Three cards, not four: there is no English-only model above the light tier
  // worth a card (medium.en loses to large-v3-turbo on English), so turbo is
  // the single accurate option for every language including English.
  presets: [
    { id: "light-english", modelId: "whisper-small.en", quant: "Q8_0" }, // 264 MB
    { id: "light-multilingual", modelId: "whisper-small", quant: "Q8_0" }, // 264 MB
    { id: "accurate", modelId: "whisper-large-v3-turbo", quant: "Q8_0" }, // 874 MB
  ],
};
