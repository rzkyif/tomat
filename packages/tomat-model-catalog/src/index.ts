// @tomat/model-catalog: the hand-authored source for tomat's local-model
// catalog. `scripts/release/catalog.ts` consumes buildCatalogPayload(), signs
// it, and publishes catalog.json. See README.md for the authoring workflow.

import { catalogPayloadSchema, type CatalogPayload, type ModelFamily } from "@tomat/shared";
import { FAMILIES } from "./families/index.ts";
import { FIT_CONFIG } from "./fit.ts";

export { FAMILIES } from "./families/index.ts";
export { FIT_CONFIG } from "./fit.ts";

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
  };
  return catalogPayloadSchema.parse(payload);
}
