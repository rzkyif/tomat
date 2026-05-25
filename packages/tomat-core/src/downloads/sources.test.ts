// source-string parser for the HF-spec format `@user/repo/branch/file`.
//
// `parseSource` is the single seam every other download helper trusts to
// translate user-supplied source strings into (relPath, url, filename), so
// the edge cases are worth pinning down.

import { assertEquals, assertThrows } from "@std/assert";
import { parseSource } from "./sources.ts";

Deno.test("parseSource: HF spec -> resolve URL + relPath stripped of branch", () => {
  const out = parseSource("@user/repo/main/file.gguf");
  assertEquals(out.relPath, "user/repo/file.gguf");
  assertEquals(out.filename, "file.gguf");
  assertEquals(
    out.url,
    "https://huggingface.co/user/repo/resolve/main/file.gguf?download=true",
  );
});

Deno.test("parseSource: nested filenames keep their full path under repo", () => {
  const out = parseSource("@user/repo/main/dir/sub/file.bin");
  assertEquals(out.relPath, "user/repo/dir/sub/file.bin");
  // Filename is the basename only — the path lives in relPath.
  assertEquals(out.filename, "file.bin");
});

Deno.test("parseSource: filename containing slashes resolves correctly", () => {
  const out = parseSource("@u/r/b/x.json");
  assertEquals(out.filename, "x.json");
});

Deno.test("parseSource: non-`@` source treated as absolute path, url is empty", () => {
  const out = parseSource("/abs/path/to/file.gguf");
  assertEquals(out.relPath, "/abs/path/to/file.gguf");
  assertEquals(out.url, "");
  assertEquals(out.filename, "file.gguf");
});

Deno.test("parseSource: rejects HF specs missing branch or file", () => {
  assertThrows(() => parseSource("@u/r"), Error, "invalid source format");
  assertThrows(() => parseSource("@u/r/b"), Error, "invalid source format");
});
