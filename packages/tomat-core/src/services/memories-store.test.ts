// MemoriesStore: CRUD, exact-edit semantics, and rescan reconciliation
// (files are the source of truth). Mutations are synchronous so a
// read-modify-write can't interleave with another caller.

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { memoriesStore } from "./memories-store.ts";

Deno.test("memories: create, get, list, title conflict", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const doc = store.create("Meeting Notes: Q3!", "# Notes\nhello");
    assertEquals(doc.filename, "meeting-notes-q3.md");
    assertEquals(doc.content, "# Notes\nhello");
    assertEquals(
      store.list().map((d) => d.title),
      ["Meeting Notes: Q3!"],
    );
    assertEquals(store.getByTitle("Meeting Notes: Q3!")?.id, doc.id);
    assertThrows(() => store.create("Meeting Notes: Q3!", "again"), AppError, "already exists");
    // Title conflict is case-insensitive: tools address memories by title
    // and could not tell "Notes" from "notes" apart.
    assertThrows(() => store.create("meeting notes: q3!", "again"), AppError, "already exists");
    assertEquals(store.getByTitle("MEETING NOTES: Q3!")?.id, doc.id);
    // Same slug, different title: filename gets a numeric suffix.
    const sibling = store.create("Meeting Notes Q3", "x");
    assertEquals(sibling.filename, "meeting-notes-q3-2.md");
  } finally {
    await env.teardown();
  }
});

Deno.test("memories: editContent requires exactly one match", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const doc = store.create("Todo", "- alpha\n- beta\n- alpha tail");
    const { before, after, memory } = store.editContent(doc.id, "- beta", "- gamma");
    assertEquals(before, "- alpha\n- beta\n- alpha tail");
    assertEquals(after, "- alpha\n- gamma\n- alpha tail");
    assertEquals(memory.content, after);
    assertThrows(() => store.editContent(doc.id, "missing", "x"), AppError, "not found");
    assertThrows(() => store.editContent(doc.id, "- alpha", "x"), AppError, "more than once");
  } finally {
    await env.teardown();
  }
});

Deno.test("memories: a vanished file surfaces as not_found, not empty content", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const doc = store.create("Ghost", "body");
    // Delete the backing file out from under the row.
    Deno.removeSync(join(paths().memoriesDir, doc.filename));
    assertThrows(() => store.get(doc.id), AppError, "missing on disk");
  } finally {
    await env.teardown();
  }
});

Deno.test("memories: rename keeps the file, delete removes it", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const doc = store.create("Old Title", "body");
    const renamed = store.rename(doc.id, "New Title");
    assertEquals(renamed.title, "New Title");
    assertEquals(renamed.filename, doc.filename);
    assertEquals(store.get(doc.id).content, "body");
    store.delete(doc.id);
    assertEquals(store.list(), []);
    let fileGone = false;
    try {
      Deno.statSync(join(paths().memoriesDir, doc.filename));
    } catch {
      fileGone = true;
    }
    assertEquals(fileGone, true);
  } finally {
    await env.teardown();
  }
});

Deno.test("memories: rescan adds, removes, and flags changed files", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const kept = store.create("Kept", "kept body");
    const dropped = store.create("Dropped", "dropped body");
    const dir = paths().memoriesDir;
    // Simulate external changes: a new file, a deleted file, an edited file.
    Deno.writeTextFileSync(join(dir, "handwritten.md"), "external content");
    Deno.removeSync(join(dir, dropped.filename));
    Deno.writeTextFileSync(join(dir, kept.filename), "kept body v2");

    const result = store.rescan();
    assertEquals(result, { added: 1, removed: 1, changed: 1 });
    const titles = store.list().map((d) => d.title);
    assertEquals(titles.includes("handwritten"), true);
    assertEquals(titles.includes("Dropped"), false);
    assertEquals(store.get(kept.id).content, "kept body v2");
    // The changed hash invalidates the (hypothetical) summary pin.
    const state = store.listIndexStates().find((s) => s.id === kept.id)!;
    assertEquals(state.summarySourceHash === state.contentHash, false);
  } finally {
    await env.teardown();
  }
});
