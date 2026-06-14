// Background document indexing: keeps each document's LLM summary and
// embedding in sync with its content, via the idle-gated background queue.
// One job per document; the job no-ops cheaply when both are fresh (hash
// comparisons), so callers schedule liberally: on boot and after every
// mutation. Jobs are not persisted; staleness is re-derived from the
// hashes, so anything dropped at shutdown is found again on the next boot.

import { DEFAULT_DOCUMENT_SUMMARY_PROMPT, errMessage } from "@tomat/shared";
import { backgroundQueue } from "./background-queue.ts";
import { documentsStore } from "./documents-store.ts";
import { isEmbeddingModelReady } from "./embedding.ts";
import { llmIdle } from "./llm-idle.ts";
import { embedSourceHash, embedWithHash } from "./relevance.ts";
import { loadCoreSettings } from "./core-settings.ts";
import { resolveEndpoint } from "./endpoint-resolver.ts";
import { singleShot } from "./single-shot.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("doc-indexer");

// Caps so a huge pasted document can't blow up the summary request or the
// embedding text.
const SUMMARY_INPUT_MAX_CHARS = 8_000;
const EMBED_FALLBACK_HEAD_CHARS = 512;

/** Enqueue an index pass for one document, or for every document when no id
 *  is given (boot, rescan). */
export function scheduleDocumentIndexing(id?: string): void {
  const ids =
    id !== undefined
      ? [id]
      : documentsStore()
          .listIndexStates()
          .map((s) => s.id);
  for (const docId of ids) {
    backgroundQueue().enqueue({
      key: `doc-index:${docId}`,
      run: () => indexDocument(docId),
    });
  }
}

async function indexDocument(id: string): Promise<void> {
  const store = documentsStore();
  const state = store.listIndexStates().find((s) => s.id === id);
  if (!state) return; // deleted while queued

  // Summary: regenerate when it was derived from different content.
  if (state.summarySourceHash !== state.contentHash) {
    const doc = store.get(id);
    const settings = await loadCoreSettings();
    try {
      // Background jobs run during the idle window, which is exactly when
      // idle-unload may have stopped the local model. ensureLoaded() reloads
      // it (no-op for an external provider or an already-loaded model);
      // without this the summary request races a stopped sidecar and the
      // job is dropped, leaving the document permanently unsummarized.
      await llmIdle().ensureLoaded(settings);
      const endpoint = await resolveEndpoint(settings);
      endpoint.reasoning = "off";
      const summary = await singleShot({
        systemPrompt: summaryPrompt(settings),
        userMessage: `Document title: ${doc.title}\n\n${doc.content.slice(
          0,
          SUMMARY_INPUT_MAX_CHARS,
        )}`,
        endpoint,
        overrides: { temperature: 0, maxTokens: 160 },
      });
      if (summary) store.setSummary(id, summary, state.contentHash);
    } catch (err) {
      // Re-found on the next mutation/boot; never fatal.
      log.warn(`summary for document ${id} failed: ${errMessage(err)}`);
    }
  }

  // Embedding: derived from title + summary (or the content head until a
  // summary exists), so it refreshes after the summary lands above.
  if (!(await isEmbeddingModelReady())) {
    // The model isn't downloaded yet: re-enqueue so the embedding lands once
    // it is, rather than waiting for the next unrelated mutation. Guard with
    // the source hash so a steady not-ready state doesn't spin (the embed
    // text is still stale, so we only re-arm when there is real work).
    const pending = store.listIndexStates().find((s) => s.id === id);
    if (pending && pending.embeddingSourceHash !== embedSourceHash(embedText(store.get(id)))) {
      backgroundQueue().enqueueDeferred({ key: `doc-index:${id}`, run: () => indexDocument(id) });
    }
    return;
  }
  const doc = store.get(id);
  const text = embedText(doc);
  const currentState = store.listIndexStates().find((s) => s.id === id);
  if (!currentState) return;
  if (currentState.embeddingSourceHash === embedSourceHash(text)) return; // fresh
  const result = await embedWithHash(text);
  if (result) store.setEmbedding(id, result.vector, result.sourceHash);
}

function embedText(doc: { title: string; summary?: string; content: string }): string {
  return `${doc.title}\n${doc.summary ?? doc.content.slice(0, EMBED_FALLBACK_HEAD_CHARS)}`;
}

function summaryPrompt(settings: Record<string, unknown>): string {
  const v = settings["prompts.documentSummaryPrompt"];
  return typeof v === "string" && v.trim() !== "" ? v : DEFAULT_DOCUMENT_SUMMARY_PROMPT;
}
