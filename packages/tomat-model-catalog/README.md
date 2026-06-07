# @tomat/model-catalog

The hand-authored source for tomat's local-model catalog. tomat picks the three
adaptive presets (Smallest / Half / Full) and powers its model browser from this
data. Curation is centralized here so quality judgments stay with a human (or a
coding agent): things like "Gemma 4 QAT matches the standard model at lower
memory" cannot be inferred automatically.

## Layout

- `src/families/<family>.ts` - one file per model family. Adding a family is:
  write a file, add it to `src/families/index.ts`.
- `src/fit.ts` - the data-driven fit policy (budget fractions, the primary score
  selector, the Smallest quality floor, the tie-breaker order).
- `src/index.ts` - `buildCatalogPayload()` assembles + validates everything.

The schemas live in `@tomat/shared` (`domain/catalog.ts`): `ModelFamily`,
`CatalogModel`, `ModelArch`, `CatalogVariant`, `CatalogQuant`, `FitConfig`.

## Authoring a model

For each model record its GGUF variants, architecture, and capability score:

1. **GGUF variants + sizes** - from the provider's GGUF repo (currently Unsloth).
   Each `CatalogQuant` is `{ quant, modelSpec, fileSizeBytes }`, where `modelSpec`
   is the HF spec `@provider/repo/branch/file.gguf`. List quants best-quality
   first. A model may have multiple `variants` (e.g. `standard` and `QAT`); the
   QAT variant is tagged `["qat"]`.
2. **Architecture** (`arch`) - `blockCount`, `embeddingLength`, `headCount`,
   `headCountKv`, `headDim`. These drive the on-device KV-cache footprint math.
3. **Score** (`scores`) - a provider-tagged list; currently the Artificial
   Analysis Intelligence Index (`{ source: "artificial-analysis", metric:
"intelligence-index", value }`). QAT and standard share the model's score.
4. **Capabilities** - `tools`, `vision` (ships an mmproj), `reasoning`.

`scripts/catalog/probe.ts` gathers (1) and (2) from the HF API + GGUF headers:

```
deno run -A scripts/catalog/probe.ts unsloth/Qwen3.5-2B-GGUF [...repos]
```

Scores (3) come from <https://artificialanalysis.ai>; enter them by hand and
re-verify them on each curation pass.

## Build + release

- `deno task catalog:build` - validate the families and write an unsigned
  `dist/catalog.unsigned.json` for inspection. No keys, no upload.
- `deno task release:catalog:stable` / `:beta` - compile, Ed25519-sign (same
  trust root as `core.json` / `binaries.json`), and upload `catalog.json` to R2.
  Also runs as part of `deno task release:<channel>`.

The core fetches + verifies `catalog.json` and runs the fit engine on-device, so
a new curation pass reaches users without a tomat release.
