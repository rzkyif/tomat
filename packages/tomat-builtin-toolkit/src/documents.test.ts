// Document tools over a scripted ctx.documents (no real host bridge):
// argument validation, result kinds, and show_document's markdown push.

import { assertEquals, assertRejects } from "@std/assert";
import { editDocument, readDocument, showDocument, writeDocument } from "./documents.ts";
import type { ToolContext } from "./types.ts";

interface MockCtx extends ToolContext {
  /** Replay log: every documents call as [op, ...args]. */
  calls: string[][];
  /** Replay log: markdown pushed via ctx.display. */
  shown: string[];
}

function makeMockCtx(): MockCtx {
  const ctx = {
    calls: [],
    shown: [],
    setProgress() {},
    askUser: () => Promise.resolve([]),
    log() {},
    display: {
      markdown(markdown: string) {
        ctx.shown.push(markdown);
      },
      image() {},
      table() {},
      diff() {},
    },
    documents: {
      list() {
        ctx.calls.push(["list"]);
        return Promise.resolve([]);
      },
      get(title: string) {
        ctx.calls.push(["get", title]);
        return Promise.resolve({ title, content: `# ${title}\nbody` });
      },
      write(title: string, content: string) {
        ctx.calls.push(["write", title, content]);
        return Promise.resolve({ title, before: "", after: content, created: true });
      },
      edit(title: string, find: string, replace: string) {
        ctx.calls.push(["edit", title, find, replace]);
        return Promise.resolve({ title, before: find, after: replace });
      },
    },
    db: {
      query: () => Promise.reject(new Error("not scripted")),
      execute: () => Promise.reject(new Error("not scripted")),
    },
    llm: { complete: () => Promise.reject(new Error("not scripted")) },
    tts: { speak: () => Promise.reject(new Error("not scripted")) },
    stt: { transcribe: () => Promise.reject(new Error("not scripted")) },
    schedulePrompt: () => Promise.reject(new Error("not scripted")),
    signal: new AbortController().signal,
    getChatContext() {
      return { userMessage: "", sessionId: null };
    },
  } as MockCtx;
  return ctx;
}

Deno.test("write_document: returns a document_diff and allows empty content", async () => {
  const ctx = makeMockCtx();
  const result = await writeDocument({ title: "Notes", content: "" }, ctx);
  assertEquals(result, {
    kind: "document_diff",
    title: "Notes",
    before: "",
    after: "",
    created: true,
  });
  assertEquals(ctx.calls, [["write", "Notes", ""]]);
  await assertRejects(() => writeDocument({ content: "x" }, ctx), Error, "title");
});

Deno.test("edit_document: returns a document_diff and requires non-empty find", async () => {
  const ctx = makeMockCtx();
  const result = await editDocument({ title: "Notes", find: "a", replace: "" }, ctx);
  assertEquals(result, { kind: "document_diff", title: "Notes", before: "a", after: "" });
  await assertRejects(
    () => editDocument({ title: "Notes", find: " ", replace: "x" }, ctx),
    Error,
    "find",
  );
});

Deno.test("read_document: returns a document_content result", async () => {
  const ctx = makeMockCtx();
  const result = await readDocument({ title: "Notes" }, ctx);
  assertEquals(result, {
    kind: "document_content",
    title: "Notes",
    content: "# Notes\nbody",
  });
});

Deno.test("show_document: pushes the content as a markdown display", async () => {
  const ctx = makeMockCtx();
  const result = await showDocument({ title: "Notes" }, ctx);
  assertEquals(result, { title: "Notes", shown: true });
  assertEquals(ctx.shown, ["# Notes\nbody"]);
});
