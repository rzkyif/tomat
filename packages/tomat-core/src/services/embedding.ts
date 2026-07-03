// Re-export shim: the embedding service now lives in @tomat/core-engine (it
// resolves its endpoint through host().localEmbed for the local sidecar or the
// external Relevance Model). Core keeps importing from this path unchanged.

export {
  activeEmbedModelId,
  embed,
  initEmbeddingService,
  isEmbeddingModelReady,
} from "@tomat/core-engine/services/embedding";
