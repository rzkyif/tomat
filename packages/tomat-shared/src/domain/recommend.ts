// Hardware introspection + per-device model recommendations.
//
// HardwareInfo is produced by the `tomat-core-hwinfo` helper binary and consumed
// by core's fit engine. BucketRecommendation/RecommendationSet are the wire shape
// of GET /api/v1/models/recommend; CatalogModelView is one row of
// GET /api/v1/models/catalog (the model browser). The fit math itself lives in
// core (packages/tomat-core/src/models/fit.ts); these are just the shared shapes.

export type GpuBackend = "metal" | "cuda" | "rocm" | "cpu";

export interface GpuInfo {
  backend: GpuBackend;
  name: string;
  /** Dedicated VRAM in bytes. 0 on CPU-only or when unified (see
   *  `unifiedMemory`), where system RAM is the budget. */
  vramBytes: number;
}

export interface HardwareInfo {
  totalRamBytes: number;
  availableRamBytes: number;
  cpuCoresPhysical: number;
  gpu: GpuInfo;
  /** True on Apple Silicon: GPU shares system RAM, so the memory budget is
   *  availableRamBytes rather than a separate VRAM pool. */
  unifiedMemory: boolean;
}

/** The three adaptive presets. `custom` (a manual model pick or hand-edited
 *  fields) is not a computed bucket and is absent here. */
export type PresetBucket = "smallest" | "half" | "full";

export const PRESET_BUCKETS: readonly PresetBucket[] = ["smallest", "half", "full"] as const;

/** The concrete `llm.*` values a recommendation or a manual pick applies. Mirrors
 *  the LlamaStartArgs-relevant settings the core writes on select. */
export interface AppliedModelSettings {
  modelPath: string; // HF spec "@provider/repo/branch/file.gguf"
  mmprojPath?: string;
  contextSize: number;
  threads: number;
  gpuLayers: number;
  flashAttn: boolean;
  /** Side effect of the chosen model: true iff it ships a vision module. */
  supportImages: boolean;
  /** > 0 only for the Full bucket (aggressive idle-unload). */
  idleUnloadSeconds: number;
}

export interface BucketRecommendation {
  bucket: PresetBucket;
  modelId: string;
  name: string;
  /** Resolved primary "smartness" score. */
  quality: number;
  quant: string;
  footprintBytes: number;
  vision: boolean;
  variantLabel: string;
  apply: AppliedModelSettings;
}

export interface RecommendationSet {
  hardware: HardwareInfo;
  catalogGeneratedAt: string;
  /** null for a bucket when nothing in the catalog fits (extreme low memory). */
  buckets: Record<PresetBucket, BucketRecommendation | null>;
  /** What the live settings currently point at, so the client can diff. */
  applied: { preset?: string; modelPath?: string };
}

/** The concrete `stt.*` values a Speech-to-Text selection applies (host/port
 *  are never touched). */
export interface AppliedSttSettings {
  modelPath: string; // HF spec "@org/repo/branch/file.bin"
  threads: number;
}

/** One curated Speech-to-Text card resolved against the catalog, the wire shape
 *  of GET /api/v1/models/stt/catalog presets (badges for the client). */
export interface SttPresetView {
  id: string;
  modelId: string;
  name: string;
  english: boolean;
  quant: string;
  modelSpec: string;
  fileSizeBytes: number;
}

/** One selectable quantization of a model, with how it lands on this device. */
export interface QuantOption {
  /** Unique HF spec "@provider/repo/branch/file.gguf" (identifies the quant). */
  modelSpec: string;
  quant: string;
  variantLabel: string;
  footprintBytes: number;
  fits: boolean;
  /** The quality/size sweet spot the fit engine recommends (and applies by
   *  default when this model is picked). Capped below Q8's diminishing returns. */
  recommended: boolean;
}

/** One row in the model browser: a catalog model plus how it would land on this
 *  device. */
export interface CatalogModelView {
  id: string;
  family: string;
  name: string;
  quality?: number;
  paramsB: number;
  vision: boolean;
  tags: string[];
  /** Best quant/variant that fits this device, or the smallest quant if none
   *  fit (then `fits` is false). */
  quant: string;
  variantLabel: string;
  footprintBytes: number;
  fits: boolean;
  apply: AppliedModelSettings;
  /** Every quant of this model the user can pick manually (recommended flagged). */
  quants: QuantOption[];
}
