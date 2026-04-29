import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// transformers.js's env is already configured at the top of src/bun/index.ts
// to point at ~/.tomat/models/ with remote models disallowed. We just import
// the pipeline lazily so the sidecar doesn't pay the ONNX startup cost until
// the first embed request.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;

type ExtractorLike = (
  texts: string[],
  opts: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let extractor: ExtractorLike | null = null;
let loadPromise: Promise<void> | null = null;

/** Returns true once all required MiniLM files exist on disk under the
 *  shared model cache. The Rust sidecar provisions them on startup; we
 *  gate /api/embed on this so early calls produce a clean 503. */
export function isEmbeddingModelReady(): boolean {
  const root = path.join(os.homedir(), ".tomat", "models", "Xenova", "all-MiniLM-L6-v2");
  const required = [
    path.join(root, "config.json"),
    path.join(root, "tokenizer.json"),
    path.join(root, "tokenizer_config.json"),
    path.join(root, "onnx", "model_quantized.onnx"),
  ];
  return required.every((p) => fs.existsSync(p));
}

async function ensureLoaded(): Promise<void> {
  if (extractor) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    // Dynamic import so a bundler can't accidentally pull transformers.js
    // into the main sidecar bundle at build time. It's externalized (see
    // package.json build:bun) but importing lazily is still the safer
    // pattern - it defers first-load cost to the first actual embed call.
    const { pipeline } = await import("@huggingface/transformers");
    const pipe = (await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      device: "cpu",
    })) as unknown as ExtractorLike;
    extractor = pipe;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  await ensureLoaded();
  const pipe = extractor;
  if (!pipe) throw new Error("embedding model did not initialize");

  const out = await pipe(texts, { pooling: "mean", normalize: true });
  // The pipeline returns a single tensor of shape [batch, dim] with the
  // embeddings contiguous. Split into per-text Float32Arrays.
  const flat = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  const dim = out.dims[out.dims.length - 1] ?? EMBED_DIM;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    const slice = flat.subarray(i * dim, (i + 1) * dim);
    // Copy into a fresh buffer so callers can keep it after `out` is GC'd.
    result.push(new Float32Array(slice));
  }
  return result;
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embedTexts([text]);
  return v;
}

/** Cosine similarity. Vectors are assumed L2-normalized, which transformers.js
 *  guarantees with `normalize: true`. Equivalent to a plain dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

export function embeddingDim(): number {
  return EMBED_DIM;
}

export function vectorFromBlob(blob: Uint8Array): Float32Array {
  // Float32Array must be aligned; copy when the blob isn't aligned to 4 bytes.
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
