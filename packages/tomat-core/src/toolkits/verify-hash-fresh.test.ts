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
  // verifyHashFresh only acts on installed toolkits; seed status accordingly.
  toolkitsRegistry().upsertToolkit({
    id,
    source: "npm",
    displayName: id,
    description: "",
    version: "1.0.0",
    installedPath: dir,
    toolsJsonHash: "x",
    contentHash,
    status: "installed",
  });
}

function addEnabledTool(id: string, name: string): void {
  const r = toolkitsRegistry();
  r.replaceTools(id, [
    {
      toolkitId: id,
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      triggers: [],
      fnExport: name,
      alwaysAvailable: false,
      requiredPermissions: [],
    },
  ]);
  r.setToolEnabled(id, name, true);
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

Deno.test("verifyHashFresh: drift flips status to 'drift' and disables tools", async () => {
  const env = await setupTestEnv();
  try {
    const dir = await makeToolkitDir();
    upsert("tk-drift", dir, await hashToolkit(dir));
    addEnabledTool("tk-drift", "t");
    // Tamper after "install": the content no longer matches the trusted hash.
    await Deno.writeTextFile(join(dir, "index.ts"), "export const x = 999; // changed\n");
    await assertRejects(
      () => toolkitsRegistry().verifyHashFresh("tk-drift"),
      AppError,
      "content changed",
    );
    assertEquals(toolkitsRegistry().get("tk-drift")?.status, "drift");
    // Tools are auto-disabled so a drifted toolkit can never be LLM-exposed.
    assertEquals(toolkitsRegistry().listTools("tk-drift")[0].enabled, false);
    await Deno.remove(dir, { recursive: true });
  } finally {
    await env.teardown();
  }
});
