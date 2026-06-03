// Embedding service: thin client that delegates to the embedding sidecar
// subprocess (see sidecars/embedding.ts). Keeps @huggingface/transformers
// out of the main tomat-core binary's import graph. That dependency
// (with ONNX runtimes) is ~340 MB and used to dominate the compiled size.

import { EMBED_BASE_FILES } from "@tomat/shared";
import { embeddingController } from "../sidecars/embedding.ts";
import { resolveHfPath } from "../models/manager.ts";

// Returns L2-normalized 384-dim vectors, one per input text.
// Empty inputs allowed; result preserves order.
export function embed(texts: string[]): Promise<Float32Array[]> {
  return embeddingController().embed(texts);
}

/** True when every embed base file (@Xenova/all-MiniLM-L6-v2) is on disk. A
 *  purely-local existence check (no network) used to gate /embed and /reindex
 *  with a clean 503 / skip instead of an opaque transformers.js error when the
 *  model hasn't been downloaded yet. */
export async function isEmbeddingModelReady(): Promise<boolean> {
  for (const spec of EMBED_BASE_FILES) {
    try {
      const st = await Deno.stat(resolveHfPath(spec));
      if (!st.isFile) return false;
    } catch {
      return false;
    }
  }
  return true;
}
