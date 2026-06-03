// Per-call content-hash re-verification (registry.verifyHashFresh): a toolkit
// tampered after boot must be refused at tool-call time, not only flagged at
// startup by verifyAllOnBoot.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { toolkitsRegistry } from "./registry.ts";
import { hashToolkit } from "./hash.ts";
import { AppError } from "../shared/errors.ts";

async function makeToolkitDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-tk-verify-" });
  await Deno.writeTextFile(join(dir, "index.ts"), "export const x = 1;\n");
  return dir;
}

function upsert(id: string, dir: string, contentHash: string): void {
  toolkitsRegistry().upsertToolkit({
    id,
    source: "npm",
    displayName: id,
    description: "",
    version: "1.0.0",
    installedPath: dir,
    toolsJsonHash: "x",
    contentHash,
  });
}

Deno.test("verifyHashFresh: resolves when on-disk content matches the trusted hash", async () => {
  const env = await setupTestEnv();
  try {
    const dir = await makeToolkitDir();
    upsert("tk-ok", dir, await hashToolkit(dir));
    await toolkitsRegistry().verifyHashFresh("tk-ok"); // must not throw
    await Deno.remove(dir, { recursive: true });
  } finally {
    await env.teardown();
  }
});

Deno.test("verifyHashFresh: refuses (toolkit_hash_drift) and flags the row when content changed", async () => {
  const env = await setupTestEnv();
  try {
    const dir = await makeToolkitDir();
    upsert("tk-drift", dir, await hashToolkit(dir));
    // Tamper after "install": the content no longer matches the trusted hash.
    await Deno.writeTextFile(join(dir, "index.ts"), "export const x = 999; // changed\n");
    await assertRejects(
      () => toolkitsRegistry().verifyHashFresh("tk-drift"),
      AppError,
      "content changed",
    );
    assertEquals(typeof toolkitsRegistry().get("tk-drift")?.lastError, "string");
    await Deno.remove(dir, { recursive: true });
  } finally {
    await env.teardown();
  }
});
