// `open` validation prefix. Skips the actual subprocess spawn, which
// would open a real browser. Tests cover the URL-validation branches that
// don't depend on the host OS.

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { open } from "./open.ts";
import type { ToolContext } from "./types.ts";

function emptyCtx(): ToolContext {
  return {
    setProgress() {},
    askUser: () => Promise.resolve([]),
    log() {},
    signal: new AbortController().signal,
    getChatContext: () => ({ userMessage: "", sessionId: null }),
  };
}

Deno.test("open: rejects missing url", async () => {
  await assertRejects(() => open({}, emptyCtx()), Error, "url is required");
});

Deno.test("open: rejects empty / whitespace-only url", async () => {
  await assertRejects(() => open({ url: "   " }, emptyCtx()), Error, "url is required");
});

Deno.test("open: rejects non-http(s) URLs", async () => {
  for (const url of ["ftp://example.com", "javascript:alert(1)", "file:///etc/hosts"]) {
    await assertRejects(() => open({ url }, emptyCtx()), Error, "only http(s)");
  }
});

Deno.test("open: ToolContext shape is satisfied (compile-time sanity)", () => {
  // Sanity that the local types still describe a ctx we can instantiate.
  // If types.ts grows a required field, this test starts failing first.
  const ctx = emptyCtx();
  assertEquals(typeof ctx.setProgress, "function");
  assertEquals(typeof ctx.askUser, "function");
  assertEquals(typeof ctx.log, "function");
  assertEquals(typeof ctx.signal, "object");
  assertEquals(typeof ctx.getChatContext, "function");
});
