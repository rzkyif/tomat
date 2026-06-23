// Memory context injection: the relevant-summaries prompt block (scored
// against stored embeddings with a caller-supplied query vector, so no
// embed sidecar is needed) and `@token` expansion in user messages.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import { memoriesStore } from "./memories-store.ts";
import { memoryTokenBlocks, relevantMemoriesPrompt } from "./memory-injection.ts";

Deno.test("injection: ranks by similarity and applies the floor", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    const recipes = store.create("knowledge", "Recipes", "pasta things");
    store.setSummary(recipes.id, "Pasta recipes and cooking notes.", recipes.contentHash);
    store.setEmbedding(recipes.id, new Float32Array([1, 0]), "h1");
    const taxes = store.create("knowledge", "Taxes", "tax things");
    store.setEmbedding(taxes.id, new Float32Array([0, 1]), "h2");

    // Query aligned with "Recipes"; "Taxes" is orthogonal (below the floor).
    const block = await relevantMemoriesPrompt("dinner ideas", new Float32Array([1, 0]), 3, true);
    assertStringIncludes(block ?? "", "Recipes: Pasta recipes and cooking notes.");
    assertEquals(block?.includes("Taxes"), false);
    assertStringIncludes(block ?? "", "read_memory");

    // maxRelevant caps the list even when both clear the floor.
    const capped = await relevantMemoriesPrompt("anything", new Float32Array([0.8, 0.7]), 1, true);
    assertEquals((capped?.match(/^- /gm) ?? []).length, 1);
  } finally {
    await env.teardown();
  }
});

Deno.test("injection: no embeddings or no query yields null", async () => {
  const env = await setupTestEnv();
  try {
    assertEquals(await relevantMemoriesPrompt("query", new Float32Array([1]), 3, true), null);
    memoriesStore().create("knowledge", "Doc", "body");
    assertEquals(await relevantMemoriesPrompt(undefined, new Float32Array([1]), 3, true), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("token expansion: matches filename stems, dedupes, ignores unknown", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    store.create("knowledge", "Meeting Notes", "agenda body");
    const blocks = memoryTokenBlocks(
      "see @meeting-notes and again @meeting-notes plus @unknown-token",
    );
    assertStringIncludes(blocks ?? "", '[Knowledge @meeting-notes "Meeting Notes"');
    assertStringIncludes(blocks ?? "", "agenda body");
    // Injected content is fenced + flagged as untrusted data (prompt-injection guard).
    assertStringIncludes(blocks ?? "", "--- BEGIN KNOWLEDGE ---");
    assertEquals((blocks?.match(/\[Knowledge /g) ?? []).length, 1);
    assertEquals(blocks?.includes("unknown-token"), false);

    // Email-like text must not trigger (token must not follow a word char).
    assertEquals(memoryTokenBlocks("mail me at notes@meeting-notes.com"), null);
    assertEquals(memoryTokenBlocks("no tokens here"), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("token expansion: a quoted token references a filename with spaces", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    // A hand-placed file whose stem has a space: only the quoted form can
    // address it (created-in-app memories get slug filenames instead).
    Deno.writeTextFileSync(join(paths().memoriesDir, "My Notes.md"), "spaced body");
    store.rescan();

    const blocks = memoryTokenBlocks('look at @"my notes" please');
    assertStringIncludes(blocks ?? "", "spaced body");
    assertStringIncludes(blocks ?? "", '[Knowledge @"my notes"');

    // The bare form can't match a spaced stem.
    assertEquals(memoryTokenBlocks("look at @my please"), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("token expansion: a bare token may contain dots, ignoring trailing punctuation", async () => {
  const env = await setupTestEnv();
  try {
    const store = memoriesStore();
    // A stem with no spaces but characters outside the slug set (here a dot) is
    // addressable bare: quotes are only needed to span whitespace.
    Deno.writeTextFileSync(join(paths().memoriesDir, "node.js.md"), "dotted body");
    store.rescan();

    // The sentence-ending period must not be swallowed into the stem.
    const blocks = memoryTokenBlocks("see @node.js.");
    assertStringIncludes(blocks ?? "", "dotted body");
    assertStringIncludes(blocks ?? "", '[Knowledge @node.js "node.js"');
  } finally {
    await env.teardown();
  }
});
