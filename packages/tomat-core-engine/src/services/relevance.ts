// Embedding-similarity primitives shared by tool relevance filtering and
// memory relevance injection. One implementation so the two stay
// rank-identical: cosine over L2-normalized vectors, top-K selection, and
// the embed-plus-source-hash pairing the reindex paths persist.

import { activeEmbedModelId, embed } from "./embedding.ts";
import { sha256HexSync } from "../platform/hash.ts";

// Both inputs are assumed L2-normalized (the embedding sidecar + embedding.ts
// return unit vectors). Cosine reduces to dot product in that case.
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  // A length mismatch means vectors from different embedding models (a stale
  // index) got compared. Silently truncating to the shorter one would return a
  // plausible-but-meaningless score, so fail loudly instead.
  if (a.length !== b.length) {
    throw new Error(`cosine: vector length mismatch (${a.length} vs ${b.length}); reindex needed`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Score every item against the query vector and return the top-K by
 *  descending cosine. Stable for ties (sort is stable in V8). */
export function topKBySimilarity<T>(
  queryVector: Float32Array,
  items: Iterable<{ item: T; vector: Float32Array }>,
  topK: number,
): Array<{ item: T; score: number }> {
  const scored: Array<{ item: T; score: number }> = [];
  for (const { item, vector } of items) {
    scored.push({ item, score: cosineNormalized(queryVector, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, topK));
}

/** The staleness hash for an embedded text. The embedding model identity is
 *  folded in so vectors from a different model (never comparable) read as
 *  stale and re-embed instead of silently mis-scoring. Every freshness
 *  comparison against a stored sourceHash must use this, not a raw sha256. */
export function embedSourceHash(text: string): string {
  return sha256HexSync(`${activeEmbedModelId()}\n${text}`);
}

/** The text embedded for a tool's relevance vector. Defined once so the reindex
 *  path and the phase-1 freshness check derive the same string (and therefore
 *  the same source hash). */
export function toolEmbedText(t: { description: string; triggers?: readonly string[] }): string {
  return `${t.description}\n${(t.triggers ?? []).join("\n")}`;
}

/** Embed one text and pair the vector with its staleness hash, so an index
 *  row can later detect drift by hash comparison. Returns null when the
 *  embed sidecar yields nothing. Callers should gate on
 *  isEmbeddingModelReady() to avoid opaque worker errors. */
export async function embedWithHash(
  text: string,
): Promise<{ vector: Float32Array; sourceHash: string } | null> {
  const [vector] = await embed([text]);
  if (!vector) return null;
  return { vector, sourceHash: embedSourceHash(text) };
}
