// Embedding service: thin client that delegates to the embedding sidecar
// subprocess (see sidecars/embedding.ts). Keeps @huggingface/transformers
// out of the main tomat-core binary's import graph — that dependency
// (with ONNX runtimes) is ~340 MB and used to dominate the compiled size.

import { embeddingController } from "../sidecars/embedding.ts";

// Returns L2-normalized 384-dim vectors, one per input text.
// Empty inputs allowed; result preserves order.
export function embed(texts: string[]): Promise<Float32Array[]> {
  return embeddingController().embed(texts);
}
