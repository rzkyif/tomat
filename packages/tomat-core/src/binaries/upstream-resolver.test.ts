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
function withMockRelease(
  body: unknown,
  fn: () => Promise<void>,
): () => Promise<void> {
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
      "aarch64-apple-darwin": { url: "https://example/x", sha256: "abc" },
    } as never,
  };
  const got = await resolveBinaryEntry(entry, "aarch64-apple-darwin");
  assertEquals(got, {
    version: "b9310",
    url: "https://example/x",
    sha256: "abc",
  });
});

Deno.test("resolveBinaryEntry returns null for a triple the entry doesn't cover", async () => {
  const entry: BinaryManifestEntry = {
    version: "b9310",
    platforms: {
      "aarch64-apple-darwin": { url: "https://example/x", sha256: "abc" },
    } as never,
  };
  assertEquals(await resolveBinaryEntry(entry, "x86_64-pc-windows-msvc"), null);
});

Deno.test("resolveUpstream returns null (no GitHub call) when the triple has no asset", async () => {
  // whisper.cpp ships only Windows assets — mac/linux beta must degrade to
  // null, not throw, and must not hit the network.
  const resolver = {
    repo: "ggml-org/whisper.cpp",
    assets: { "x86_64-pc-windows-msvc": "whisper-bin-x64.zip" },
  };
  assertEquals(await resolveUpstream(resolver, "aarch64-apple-darwin"), null);
});

Deno.test(
  "resolveUpstream resolves the latest asset + verifies via GitHub's sha256 digest",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [{
        name: "llama-b9999-bin-macos-arm64.tar.gz",
        browser_download_url: "https://github.test/llama-b9999.tar.gz",
        digest: "sha256:deadbeef",
      }],
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
      );
      assertEquals(got, {
        version: "b9999",
        url: "https://github.test/llama-b9999.tar.gz",
        sha256: "deadbeef",
      });
    },
  ),
);

Deno.test(
  "resolveUpstream refuses an asset with no sha256 digest (unverifiable)",
  withMockRelease(
    {
      tag_name: "b9999",
      assets: [{
        name: "llama-b9999-bin-macos-arm64.tar.gz",
        browser_download_url: "https://github.test/llama-b9999.tar.gz",
        digest: null,
      }],
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
          ),
        Error,
        "has no asset",
      ),
  ),
);
