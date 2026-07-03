import { assertEquals } from "@std/assert";
import type { BinaryManifestEntry } from "@tomat/shared";
import { resolveWithFallback } from "./manager.ts";
import { __resetResolverCacheForTesting } from "./upstream-resolver.ts";

// Swap globalThis.fetch for a canned GitHub /releases/latest response so the
// resolver-entry cases run without touching the network (mirrors the helper in
// upstream-resolver.test.ts).
function withMockRelease(body: unknown, fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    const orig = globalThis.fetch;
    __resetResolverCacheForTesting();
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    try {
      await fn();
    } finally {
      globalThis.fetch = orig;
      __resetResolverCacheForTesting();
    }
  };
}

Deno.test("resolveWithFallback: a pinned target resolves directly, no degrade, no network", async () => {
  const entry: BinaryManifestEntry = {
    version: "b1",
    platforms: {
      "x86_64-pc-windows-msvc": {
        cpu: { url: "https://e/cpu", sha256: "c" },
        cuda: { url: "https://e/cuda", sha256: "g" },
      },
    } as never,
  };
  const r = await resolveWithFallback(
    "llama-server",
    entry,
    "x86_64-pc-windows-msvc",
    "cuda",
    "cuda",
  );
  assertEquals(r?.variant, "cuda");
  assertEquals(r?.url, "https://e/cuda");
});

Deno.test(
  "resolveWithFallback: a missing upstream GPU asset degrades to the next offered variant (cuda -> vulkan)",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [
        {
          name: "llama-b9999-cpu.zip",
          browser_download_url: "https://gh/cpu.zip",
          digest: "sha256:c",
          size: 10,
        },
        {
          name: "llama-b9999-vulkan.zip",
          browser_download_url: "https://gh/vulkan.zip",
          digest: "sha256:v",
          size: 20,
        },
        // This release ships NO cuda asset (the maintenance-point case: llama.cpp
        // renamed/dropped it), so a cuda device must degrade rather than fail.
      ],
    },
    async () => {
      const entry: BinaryManifestEntry = {
        resolver: {
          repo: "ggml-org/llama.cpp",
          assets: {
            "x86_64-unknown-linux-gnu": {
              cpu: "llama-{tag}-cpu.zip",
              vulkan: "llama-{tag}-vulkan.zip",
              cuda: "llama-{tag}-cuda.zip",
            },
          },
        },
      };
      const r = await resolveWithFallback(
        "llama-server",
        entry,
        "x86_64-unknown-linux-gnu",
        "cuda",
        "cuda",
      );
      // Preference order for cuda is [cuda, directml, vulkan, cpu]; cuda's asset
      // is absent and directml isn't offered, so it lands on vulkan (not cpu).
      assertEquals(r?.variant, "vulkan");
      assertEquals(r?.url, "https://gh/vulkan.zip");
    },
  ),
);

Deno.test(
  "resolveWithFallback: the target resolves when its asset is present (no degrade)",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [
        {
          name: "llama-b9999-cpu.zip",
          browser_download_url: "https://gh/cpu.zip",
          digest: "sha256:c",
          size: 10,
        },
        {
          name: "llama-b9999-cuda.zip",
          browser_download_url: "https://gh/cuda.zip",
          digest: "sha256:g",
          size: 30,
        },
      ],
    },
    async () => {
      const entry: BinaryManifestEntry = {
        resolver: {
          repo: "ggml-org/llama.cpp",
          assets: {
            "x86_64-unknown-linux-gnu": {
              cpu: "llama-{tag}-cpu.zip",
              cuda: "llama-{tag}-cuda.zip",
            },
          },
        },
      };
      const r = await resolveWithFallback(
        "llama-server",
        entry,
        "x86_64-unknown-linux-gnu",
        "cuda",
        "cuda",
      );
      assertEquals(r?.variant, "cuda");
      assertEquals(r?.url, "https://gh/cuda.zip");
    },
  ),
);
