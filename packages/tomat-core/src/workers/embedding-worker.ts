// Embedding subprocess: hosts @huggingface/transformers, reads NDJSON
// frames from stdin, writes NDJSON frames to stdout. Spawned by
// sidecars/embedding.ts with minimal Deno permissions
// (--allow-read=<models-dir>, --allow-env=ORT_LOG_LEVEL).
//
// The model (Xenova/all-MiniLM-L6-v2, 384-dim, L2-normalized) is loaded
// lazily on first embed call and stays warm for the worker's lifetime.
//
// Frame protocol:
//   in  -> { kind: "embed", id, texts }
//   out <- { kind: "embedded", id, vectorsBase64 }
//        | { kind: "embed_err", id, error }
//
// The worker emits { kind: "ready" } once env config is in place — the
// host waits for this before sending any embed request.
//
// Vectors are Float32Array serialized as base64-encoded little-endian
// bytes (4 bytes per float). Each Float32Array is 1.5 KB on the wire.

// Full `npm:` specifier (not the workspace import-map alias) so this file
// can run standalone from ~/.tomat/core/workers/ after install, with no
// deno.json nearby. Keep the version pinned in lockstep with tomat-core's
// own deno.json import.
import { env, pipeline } from "npm:@huggingface/transformers@^4.1.0";

const REPO = "Xenova/all-MiniLM-L6-v2";

type In = { kind: "embed"; id: string; texts: string[] };

type Out =
  | { kind: "ready" }
  | { kind: "embedded"; id: string; vectorsBase64: string[] }
  | { kind: "embed_err"; id: string; error: string };

function send(frame: Out): void {
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
}

let extractor: unknown | null = null;
let loadInflight: Promise<void> | null = null;

function configureEnv(modelsRoot: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsRoot;
  env.cacheDir = modelsRoot;
  (env as unknown as { useBrowserCache?: boolean }).useBrowserCache = false;
}

async function ensureLoaded(): Promise<void> {
  if (extractor) return;
  if (loadInflight) return loadInflight;
  loadInflight = (async () => {
    extractor = await pipeline("feature-extraction", REPO, {
      dtype: "q8",
      device: "cpu",
    });
  })();
  try {
    await loadInflight;
  } finally {
    loadInflight = null;
  }
}

async function embed(id: string, texts: string[]): Promise<void> {
  try {
    if (texts.length === 0) {
      send({ kind: "embedded", id, vectorsBase64: [] });
      return;
    }
    await ensureLoaded();
    const fn = extractor as (
      inputs: string[],
      opts: { pooling: "mean"; normalize: true },
    ) => Promise<{ tolist: () => number[][] }>;
    const tensor = await fn(texts, { pooling: "mean", normalize: true });
    const rows = tensor.tolist();
    const vectorsBase64 = rows.map((row) => f32ToBase64(new Float32Array(row)));
    send({ kind: "embedded", id, vectorsBase64 });
  } catch (err) {
    send({
      kind: "embed_err",
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function f32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(bin);
}

// --- stdin loop -----------------------------------------------------------

async function main(): Promise<void> {
  const modelsRoot = Deno.args[0];
  if (!modelsRoot) {
    Deno.stderr.writeSync(new TextEncoder().encode("missing modelsRoot arg\n"));
    Deno.exit(1);
  }
  configureEnv(modelsRoot);
  send({ kind: "ready" });

  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: In;
      try {
        frame = JSON.parse(line) as In;
      } catch {
        Deno.stderr.writeSync(new TextEncoder().encode(`bad frame: ${line}\n`));
        continue;
      }
      if (frame.kind === "embed") {
        await embed(frame.id, frame.texts);
      }
    }
  }
}

if (import.meta.main) {
  await main();
}
