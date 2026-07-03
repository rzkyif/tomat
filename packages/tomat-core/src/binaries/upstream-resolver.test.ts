import { assertEquals, assertRejects } from "@std/assert";
import { isResolverEntry } from "@tomat/shared";
import type { BinaryManifestEntry } from "@tomat/shared";
import {
  __resetResolverCacheForTesting,
  resolveBinaryEntry,
  resolveUpstream,
} from "./upstream-resolver.ts";

// Swap globalThis.fetch for a canned GitHub /releases/latest response so the
// digest-verification branches are exercised without touching the network.
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

Deno.test("isResolverEntry distinguishes pinned vs resolver entries", () => {
  const pinned: BinaryManifestEntry = {
    version: "v1",
    platforms: {} as never,
  };
  const resolver: BinaryManifestEntry = {
    resolver: { repo: "a/b", assets: {} },
  };
  assertEquals(isResolverEntry(pinned), false);
  assertEquals(isResolverEntry(resolver), true);
});

Deno.test("resolveBinaryEntry returns the pinned URL+hash without network", async () => {
  const entry: BinaryManifestEntry = {
    version: "b9310",
    platforms: {
      // Bare pinned target normalizes to the cpu variant.
      "aarch64-apple-darwin": { url: "https://example/x", sha256: "abc" },
    } as never,
  };
  const got = await resolveBinaryEntry(entry, "aarch64-apple-darwin", "cpu");
  assertEquals(got, {
    version: "b9310",
    variant: "cpu",
    url: "https://example/x",
    sha256: "abc",
  });
});

Deno.test("resolveBinaryEntry resolves a pinned GPU variant with its extras", async () => {
  const entry: BinaryManifestEntry = {
    version: "b9310",
    platforms: {
      "x86_64-pc-windows-msvc": {
        cpu: { url: "https://example/cpu", sha256: "c" },
        cuda: {
          url: "https://example/cuda",
          sha256: "g",
          extras: [{ url: "https://example/cudart", sha256: "r" }],
        },
      },
    } as never,
  };
  assertEquals(await resolveBinaryEntry(entry, "x86_64-pc-windows-msvc", "cuda"), {
    version: "b9310",
    variant: "cuda",
    url: "https://example/cuda",
    sha256: "g",
    extras: [{ url: "https://example/cudart", sha256: "r" }],
  });
});

Deno.test("resolveBinaryEntry returns null for a triple the entry doesn't cover", async () => {
  const entry: BinaryManifestEntry = {
    version: "b9310",
    platforms: {
      "aarch64-apple-darwin": { url: "https://example/x", sha256: "abc" },
    } as never,
  };
  assertEquals(await resolveBinaryEntry(entry, "x86_64-pc-windows-msvc", "cpu"), null);
});

Deno.test("resolveBinaryEntry returns null for a variant the triple doesn't offer", async () => {
  const entry: BinaryManifestEntry = {
    version: "b9310",
    platforms: {
      "aarch64-apple-darwin": { url: "https://example/x", sha256: "abc" },
    } as never,
  };
  // mac ships a single (cpu) build; asking for cuda yields null.
  assertEquals(await resolveBinaryEntry(entry, "aarch64-apple-darwin", "cuda"), null);
});

Deno.test("resolveUpstream returns null (no GitHub call) when the triple has no asset", async () => {
  // whisper.cpp ships only Windows assets, so mac/linux latest must degrade to
  // null, not throw, and must not hit the network.
  const resolver = {
    repo: "ggml-org/whisper.cpp",
    assets: { "x86_64-pc-windows-msvc": "whisper-bin-x64.zip" },
  };
  assertEquals(await resolveUpstream(resolver, "aarch64-apple-darwin", "cpu"), null);
});

Deno.test(
  "resolveUpstream resolves the latest asset + verifies via GitHub's sha256 digest",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [
        {
          name: "llama-b9999-bin-macos-arm64.tar.gz",
          browser_download_url: "https://github.test/llama-b9999.tar.gz",
          digest: "sha256:deadbeef",
          size: 8675309,
        },
      ],
    },
    async () => {
      const got = await resolveUpstream(
        {
          repo: "ggml-org/llama.cpp",
          assets: {
            "aarch64-apple-darwin": "llama-{tag}-bin-macos-arm64.tar.gz",
          },
        },
        "aarch64-apple-darwin",
        "cpu",
      );
      assertEquals(got, {
        version: "b9999",
        variant: "cpu",
        url: "https://github.test/llama-b9999.tar.gz",
        sha256: "deadbeef",
        sizeBytes: 8675309,
      });
    },
  ),
);

Deno.test(
  "resolveUpstream resolves a GPU variant asset + its cudart extra",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [
        {
          name: "llama-b9999-bin-win-cuda-13.3-x64.zip",
          browser_download_url: "https://github.test/cuda.zip",
          digest: "sha256:aaa",
          size: 100,
        },
        {
          name: "cudart-llama-bin-win-cuda-13.3-x64.zip",
          browser_download_url: "https://github.test/cudart.zip",
          digest: "sha256:bbb",
          size: 50,
        },
      ],
    },
    async () => {
      const got = await resolveUpstream(
        {
          repo: "ggml-org/llama.cpp",
          assets: {
            "x86_64-pc-windows-msvc": {
              cpu: "llama-{tag}-bin-win-cpu-x64.zip",
              cuda: {
                asset: "llama-{tag}-bin-win-cuda-13.3-x64.zip",
                extra: ["cudart-llama-bin-win-cuda-13.3-x64.zip"],
              },
            },
          },
        },
        "x86_64-pc-windows-msvc",
        "cuda",
      );
      assertEquals(got, {
        version: "b9999",
        variant: "cuda",
        url: "https://github.test/cuda.zip",
        sha256: "aaa",
        extras: [{ url: "https://github.test/cudart.zip", sha256: "bbb" }],
        sizeBytes: 150,
      });
    },
  ),
);

Deno.test(
  "resolveUpstream refuses an asset with no sha256 digest (unverifiable)",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [
        {
          name: "llama-b9999-bin-macos-arm64.tar.gz",
          browser_download_url: "https://github.test/llama-b9999.tar.gz",
          digest: null,
        },
      ],
    },
    () =>
      assertRejects(
        () =>
          resolveUpstream(
            {
              repo: "ggml-org/llama.cpp",
              assets: {
                "aarch64-apple-darwin": "llama-{tag}-bin-macos-arm64.tar.gz",
              },
            },
            "aarch64-apple-darwin",
            "cpu",
          ),
        Error,
        "no sha256 digest",
      ),
  ),
);

Deno.test(
  "resolveUpstream throws when the expected asset is absent from the release",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [{ name: "something-else.zip", browser_download_url: "x" }],
    },
    () =>
      assertRejects(
        () =>
          resolveUpstream(
            {
              repo: "ggml-org/llama.cpp",
              assets: {
                "aarch64-apple-darwin": "llama-{tag}-bin-macos-arm64.tar.gz",
              },
            },
            "aarch64-apple-darwin",
            "cpu",
          ),
        Error,
        "has no asset",
      ),
  ),
);
