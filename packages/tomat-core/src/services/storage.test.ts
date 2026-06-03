import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import { buildStorageTree, deleteStoragePaths } from "./storage.ts";
import { AppError } from "../shared/errors.ts";

async function writeModel(rel: string, bytes: string): Promise<string> {
  const abs = join(paths().modelsDir, rel);
  await Deno.mkdir(dirname(abs), { recursive: true });
  await Deno.writeTextFile(abs, bytes);
  return abs;
}

Deno.test("buildStorageTree: groups multi-file repos as folders, inlines single-file repos", async () => {
  const env = await setupTestEnv();
  try {
    await writeModel("unsloth/Qwen3/model.gguf", "A".repeat(10));
    await writeModel("unsloth/Qwen3/mmproj-F16.gguf", "B".repeat(20));
    await writeModel("ggml-org/whisper/ggml-base.bin", "C".repeat(5));
    await writeModel("unsloth/Qwen3/README.md", "ignore-me"); // non-model file

    const tree = await buildStorageTree();
    const byName = new Map(tree.models.map((n) => [n.name, n]));

    const folder = byName.get("unsloth/Qwen3");
    assert(folder && folder.kind === "folder");
    assertEquals(folder.children.length, 2); // gguf + mmproj; README excluded
    assertEquals(folder.size, 30);

    // Single-file repo rendered inline as "user/repo/file".
    assert(
      [...byName.keys()].some((k) => k.startsWith("ggml-org/whisper/")),
      "single-file repo should be inlined",
    );
    assertEquals(tree.models_size, 35);
    // root_path/models must resolve to the actual models dir (for in-use locks).
    assertEquals(join(tree.root_path, "models"), paths().modelsDir);
  } finally {
    await env.teardown();
  }
});

Deno.test("deleteStoragePaths: removes a model file but rejects paths outside the models dir", async () => {
  const env = await setupTestEnv();
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline test"));
  try {
    const abs = await writeModel("u/r/model.gguf", "X".repeat(8));
    await assertRejects(
      () => deleteStoragePaths([join(paths().modelsDir, "..", "escape.txt")]),
      AppError,
      "not under the models dir",
    );
    await deleteStoragePaths([abs]);
    await assertRejects(() => Deno.stat(abs), Deno.errors.NotFound);
  } finally {
    globalThis.fetch = origFetch;
    await env.teardown();
  }
});
