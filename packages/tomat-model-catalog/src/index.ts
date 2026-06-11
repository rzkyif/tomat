// @tomat/model-catalog: the hand-authored source for tomat's local-model
// catalog. `scripts/release/catalog.ts` consumes buildCatalogPayload(), signs
// it, and publishes catalog.json. See README.md for the authoring workflow.

import { catalogPayloadSchema, type CatalogPayload, type ModelFamily } from "@tomat/shared";
import { FAMILIES } from "./families/index.ts";
import { FIT_CONFIG } from "./fit.ts";
import { STT_CATALOG } from "./stt.ts";

export { FAMILIES } from "./families/index.ts";
export { FIT_CONFIG } from "./fit.ts";
export { STT_CATALOG } from "./stt.ts";

/** Assemble + validate the catalog payload (everything that gets signed).
 *  `generatedAt` is passed in (scripts stamp it) since the scripts environment
 *  forbids ambient clock access in some contexts. Throws on schema violations. */
export function buildCatalogPayload(
  generatedAt: string,
  families: ModelFamily[] = FAMILIES,
): CatalogPayload {
  const payload = {
    schemaVersion: 1 as const,
    generatedAt,
    families,
    fit: FIT_CONFIG,
    stt: STT_CATALOG,
  };
  const parsed = catalogPayloadSchema.parse(payload);
  checkSttReferences(parsed);
  return parsed;
}

/** Referential checks zod can't express without ZodEffects (which would break
 *  the `.extend()` building modelCatalogSchema): unique STT ids, and every STT
 *  preset pointing at an existing model+quant. */
function checkSttReferences(payload: CatalogPayload): void {
  const modelIds = new Set<string>();
  for (const model of payload.stt.models) {
    if (modelIds.has(model.id)) throw new Error(`duplicate stt model id: ${model.id}`);
    modelIds.add(model.id);
  }
  const presetIds = new Set<string>();
  for (const preset of payload.stt.presets) {
    if (presetIds.has(preset.id)) throw new Error(`duplicate stt preset id: ${preset.id}`);
    presetIds.add(preset.id);
    const model = payload.stt.models.find((m) => m.id === preset.modelId);
    if (!model) {
      throw new Error(`stt preset "${preset.id}" references unknown model: ${preset.modelId}`);
    }
    if (!model.quants.some((q) => q.quant === preset.quant)) {
      throw new Error(
        `stt preset "${preset.id}" references unknown quant ${preset.quant} of ${preset.modelId}`,
      );
    }
  }
}
