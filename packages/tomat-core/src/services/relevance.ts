// Re-export shim: the embedding-similarity primitives now live in
// @tomat/core-engine. Core keeps importing from this path unchanged.

export {
  cosineNormalized,
  embedSourceHash,
  embedWithHash,
  toolEmbedText,
  topKBySimilarity,
} from "@tomat/core-engine/services/relevance";
