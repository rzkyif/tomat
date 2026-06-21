// Embedding service: a thin client over the llama-embed sidecar's OpenAI-style
// /v1/embeddings endpoint (a second llama-server instance hosting the MiniLM
// GGUF; see sidecars/llama-embed.ts + services/sidecar-boot.ts applyLlamaEmbed).
// Returns 384-dim L2-normalized vectors that tool-relevance + memory RAG
// compare with cosine similarity (services/relevance.ts).

import { EMBED_DIM, EMBED_MODEL_FILE, errMessage } from "@tomat/shared";
import { embedPort } from "../paths.ts";
import { resolveHfPath } from "../models/manager.ts";
import { AppError } from "../shared/errors.ts";

// Upper bound on a single embeddings call. Embedding a handful of short strings
// is fast; this only guards against a wedged-but-listening sidecar pinning the
// caller forever (mirrors stt-transcribe's local timeout).
const EMBED_TIMEOUT_MS = 30_000;

// Returns L2-normalized 384-dim vectors, one per input text, in input order.
// Empty input array returns []. Rejects (server_unavailable / provider_error)
// when the sidecar is down or errors, so callers can degrade as they already do.
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const url = `http://127.0.0.1:${embedPort()}/v1/embeddings`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tomat-embed", input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(
      "server_unavailable",
      `llama-embed not reachable at ${url}: ${errMessage(err)}`,
    );
  }
  if (!res.ok) {
    throw new AppError("provider_error", `llama-embed HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };
  // Reassemble in input order (the endpoint returns one entry per input with an
  // `index`; sort defensively in case order isn't guaranteed).
  const data = (body.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) {
    throw new AppError(
      "provider_error",
      `llama-embed returned ${data.length} vectors for ${texts.length} inputs`,
    );
  }
  return data.map((d) => {
    const vec = Float32Array.from(d.embedding ?? []);
    if (vec.length !== EMBED_DIM) {
      throw new AppError(
        "provider_error",
        `llama-embed returned a ${vec.length}-dim vector (expected ${EMBED_DIM})`,
      );
    }
    return l2normalize(vec);
  });
}

/** True when the embedding GGUF is on disk. A purely-local existence check (no
 *  network) used to gate /embed and /reindex with a clean 503 / skip instead of
 *  an opaque error when the model hasn't been downloaded yet. */
export async function isEmbeddingModelReady(): Promise<boolean> {
  try {
    const st = await Deno.stat(resolveHfPath(EMBED_MODEL_FILE));
    return st.isFile;
  } catch {
    return false;
  }
}

/** L2-normalize in place. llama-server already normalizes with `--pooling mean`,
 *  but normalizing defensively keeps cosineNormalized (a bare dot product)
 *  correct regardless of the server's `--embd-normalize` default. */
function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}
