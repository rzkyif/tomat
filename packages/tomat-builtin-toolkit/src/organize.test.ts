// organize_downloads against a tempdir Downloads folder with a scripted
// askUser: file listing/filtering, the planned-layout diff, and applying
// or rejecting the plan.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "node:path";
import * as fs from "node:fs";
import { organizeDownloads } from "./organize.ts";
import type { AskUserAnswer, AskUserQuestion, ToolContext } from "./types.ts";

interface ScriptedCtx extends ToolContext {
  /** Every askUser call's questions, in order. */
  asked: AskUserQuestion[][];
}

/** ctx whose askUser pops one scripted answer set per call. */
function makeCtx(answers: AskUserAnswer[][]): ScriptedCtx {
  const queue = [...answers];
  const ctx = {
    asked: [],
    setProgress() {},
    askUser(questions: AskUserQuestion[]) {
      ctx.asked.push(questions);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error("askUser called more times than scripted"));
      return Promise.resolve(next);
    },
    log() {},
    display: { markdown() {}, image() {}, table() {}, diff() {} },
    memories: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("not scripted")),
      write: () => Promise.reject(new Error("not scripted")),
      edit: () => Promise.reject(new Error("not scripted")),
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
    getChatContext: () => ({ userMessage: "", sessionId: null }),
  } as ScriptedCtx;
  return ctx;
}

async function withTempDownloads<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-organize-t1-" });
  const prior = Deno.env.get("XDG_DOWNLOAD_DIR");
  Deno.env.set("XDG_DOWNLOAD_DIR", dir);
  try {
    return await fn(dir);
  } finally {
    if (prior === undefined) Deno.env.delete("XDG_DOWNLOAD_DIR");
    else Deno.env.set("XDG_DOWNLOAD_DIR", prior);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function seed(dir: string, names: string[]): void {
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

Deno.test("organize_downloads: moves accepted files into category folders", async () => {
  await withTempDownloads(async (dir) => {
    seed(dir, ["report.pdf", "photo.png", "mystery.xyz"]);
    const all = ["report.pdf", "photo.png", "mystery.xyz"].map((n) => path.join(dir, n));
    const ctx = makeCtx([[all], ["accept"]]);

    const result = await organizeDownloads({}, ctx);

    assertEquals(result.applied, true);
    assertEquals(result.moved.length, 3);
    assert(fs.existsSync(path.join(dir, "Documents", "report.pdf")));
    assert(fs.existsSync(path.join(dir, "Images", "photo.png")));
    assert(fs.existsSync(path.join(dir, "Other", "mystery.xyz")));
    assert(!fs.existsSync(path.join(dir, "report.pdf")));

    // First question lists the files; second carries the layout diff.
    assertEquals(ctx.asked[0][0].kind, "files");
    const diffQ = ctx.asked[1][0];
    assertEquals(diffQ.kind, "diff");
    if (diffQ.kind === "diff") {
      assert(diffQ.after.includes("Documents/report.pdf"));
    }
  });
});

Deno.test("organize_downloads: a rejected plan moves nothing", async () => {
  await withTempDownloads(async (dir) => {
    seed(dir, ["report.pdf"]);
    const ctx = makeCtx([[[path.join(dir, "report.pdf")]], ["reject"]]);

    const result = await organizeDownloads({}, ctx);

    assertEquals(result, { applied: false, moved: [] });
    assert(fs.existsSync(path.join(dir, "report.pdf")));
  });
});

Deno.test("organize_downloads: skips dotfiles and in-flight downloads in the listing", async () => {
  await withTempDownloads(async (dir) => {
    seed(dir, ["keep.txt", ".hidden", "partial.zip.part", "page.crdownload"]);
    fs.mkdirSync(path.join(dir, "Subfolder"));
    // Decline by picking the one offered file and rejecting the plan; the
    // assertion is about what was offered.
    const ctx = makeCtx([[[path.join(dir, "keep.txt")]], ["reject"]]);

    await organizeDownloads({}, ctx);

    const offered = ctx.asked[0][0];
    assertEquals(offered.kind, "files");
    if (offered.kind === "files") {
      assertEquals(
        offered.entries.map((e) => e.label),
        ["keep.txt"],
      );
    }
  });
});

Deno.test("organize_downloads: errors when the Downloads folder has no loose files", async () => {
  await withTempDownloads(async () => {
    const ctx = makeCtx([]);
    await assertRejects(() => organizeDownloads({}, ctx), Error, "no loose files");
  });
});
