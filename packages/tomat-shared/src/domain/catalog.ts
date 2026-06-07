// Model catalog: the hand-authored, signed list of local models tomat can run,
// served at get.au.tomat.ing/manifests[/<channel>]/catalog.json.
//
// Authoring lives in the `@tomat/model-catalog` package as one TS file per model
// family; `scripts/release/catalog.ts` validates each family against the schemas
// here, flattens them into one ModelCatalog, Ed25519-signs it (whole object minus
// `signature`, canonicalized; same trust root as core.json/binaries.json), and
// uploads it. The core fetches + verifies it and runs the fit engine on-device.
//
// Deliberately provider-agnostic: the GGUF provider is whatever the `@provider/...`
// modelSpec encodes, scores are a generic provider-tagged list, and the
// "smartness" metric + tie-break policy are data-driven in FitConfig. Unsloth
// (GGUF) and Artificial Analysis (score) are the current sources, not baked in.

import { z } from "zod";

/** One capability score from one provider, e.g. Artificial Analysis's
 *  intelligence index. Kept generic so a different provider/metric can be added
 *  without a schema change; FitConfig.primaryScore selects which one ranks. */
export const modelScoreSchema = z
  .object({
    source: z.string(), // e.g. "artificial-analysis"
    metric: z.string(), // e.g. "intelligence-index"
    value: z.number(),
  })
  .strict();
export type ModelScore = z.infer<typeof modelScoreSchema>;

/** A single GGUF quantization. Weights size only; the architecture fields used
 *  for KV-cache math live on the model (identical across quants). */
export const catalogQuantSchema = z
  .object({
    quant: z.string(), // "Q4_K_M", "Q8_0", ...
    modelSpec: z.string(), // "@unsloth/repo/branch/file.gguf"
    fileSizeBytes: z.number().int().positive(),
  })
  .strict();
export type CatalogQuant = z.infer<typeof catalogQuantSchema>;

/** Transformer shape needed to estimate the KV-cache footprint without reading
 *  the GGUF. headDim is explicit because it is not always embeddingLength /
 *  headCount (e.g. Gemma uses a larger head_dim). */
export const modelArchSchema = z
  .object({
    blockCount: z.number().int().positive(), // n_layers
    embeddingLength: z.number().int().positive(), // n_embd
    headCount: z.number().int().positive(), // n_head
    headCountKv: z.number().int().positive(), // n_head_kv (GQA)
    headDim: z.number().int().positive(), // key/value length per head
  })
  .strict();
export type ModelArch = z.infer<typeof modelArchSchema>;

/** A distribution of one model: standard weights, a QAT build, etc. Variants of
 *  one model share its scores; they differ in memory footprint. `tags` is
 *  open-ended so the fit engine's tie-breakers can prefer e.g. "qat". */
export const catalogVariantSchema = z
  .object({
    label: z.string(), // "standard", "QAT", ...
    tags: z.array(z.string()).default([]), // ["qat"], ["moe"], ...
    provider: z.string(), // "unsloth" (also implied by modelSpec)
    mmprojSpec: z.string().optional(), // vision module GGUF, if any
    mmprojSizeBytes: z.number().int().positive().optional(),
    quants: z.array(catalogQuantSchema).min(1), // best quality first
  })
  .strict();
export type CatalogVariant = z.infer<typeof catalogVariantSchema>;

export const catalogModelSchema = z
  .object({
    id: z.string(), // canonical HF base id, e.g. "Qwen/Qwen3.5-4B"
    name: z.string(), // "Qwen3.5 4B"
    scores: z.array(modelScoreSchema).default([]),
    paramsB: z.number().positive(),
    contextMax: z.number().int().positive(),
    arch: modelArchSchema,
    capabilities: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        reasoning: z.boolean(),
      })
      .strict(),
    variants: z.array(catalogVariantSchema).min(1),
  })
  .strict();
export type CatalogModel = z.infer<typeof catalogModelSchema>;

/** One authoring file in `@tomat/model-catalog`. */
export const modelFamilySchema = z
  .object({
    family: z.string(), // "Qwen 3.5"
    publisher: z.string(), // "Qwen"
    models: z.array(catalogModelSchema).min(1),
  })
  .strict();
export type ModelFamily = z.infer<typeof modelFamilySchema>;

/** Selects which ModelScore ranks "smartness". Swapping the score provider is a
 *  data change here, not a code change. */
export const scoreSelectorSchema = z.object({ source: z.string(), metric: z.string() }).strict();
export type ScoreSelector = z.infer<typeof scoreSelectorSchema>;

/** Data-driven fit policy, shipped in the catalog so tuning needs no release. */
export const fitConfigSchema = z
  .object({
    budgetFraction: z
      .object({
        half: z.number().positive().max(1),
        full: z.number().positive().max(1),
      })
      .strict(),
    safetyMarginBytes: z.number().int().nonnegative(),
    primaryScore: scoreSelectorSchema,
    /** Smallest bucket's quality floor = this model's primaryScore. */
    smallestQualityFloorRef: z.string(),
    /** Ordered, named rules applied when primary scores tie. Known rules:
     *  "lowerFootprint", "preferTag:<tag>". Unknown rules are ignored. */
    tieBreakers: z.array(z.string()).default([]),
  })
  .strict();
export type FitConfig = z.infer<typeof fitConfigSchema>;

/** The compiled catalog payload (everything that gets signed). */
export const catalogPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(), // ISO 8601
    families: z.array(modelFamilySchema).min(1),
    fit: fitConfigSchema,
  })
  .strict();
export type CatalogPayload = z.infer<typeof catalogPayloadSchema>;

/** The signed catalog as served + cached. `signature` is base64 Ed25519 over
 *  canonicalize(payload) (the whole object minus `signature`). */
export const modelCatalogSchema = catalogPayloadSchema.extend({ signature: z.string() }).strict();
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

/** Flatten every model across families (browser + fit both iterate models). */
export function catalogModels(c: CatalogPayload): Array<CatalogModel & { family: string }> {
  return c.families.flatMap((f) => f.models.map((m) => ({ ...m, family: f.family })));
}

/** Resolve the primary "smartness" score for a model, or undefined if the model
 *  carries no score for the configured selector. */
export function primaryScore(model: CatalogModel, sel: ScoreSelector): number | undefined {
  return model.scores.find((s) => s.source === sel.source && s.metric === sel.metric)?.value;
}
