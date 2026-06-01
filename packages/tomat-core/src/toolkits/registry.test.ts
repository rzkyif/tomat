// ToolkitsRegistry CRUD + the grant/tool relationship that the
// permission system depends on. Skip the hash-drift / verifyAllOnBoot path.
// That's exercised separately under hash.test.ts plus an installer
// integration test.

import { assertEquals, assertThrows } from "@std/assert";
import type { PermissionDecl } from "@tomat/shared";
import { permissionKey } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { type ToolInsertInput, type ToolkitInsertInput, toolkitsRegistry } from "./registry.ts";
import { AppError } from "../shared/errors.ts";

function tk(overrides: Partial<ToolkitInsertInput> = {}): ToolkitInsertInput {
  return {
    id: "example-toolkit",
    source: "npm",
    displayName: "Example",
    description: "demo",
    version: "1.0.0",
    installedPath: "/tmp/example",
    toolsJsonHash: "deadbeef",
    contentHash: "cafebabe",
    ...overrides,
  };
}

function tool(overrides: Partial<ToolInsertInput> = {}): ToolInsertInput {
  return {
    toolkitId: "example-toolkit",
    name: "do_thing",
    description: "does",
    parameters: { type: "object", properties: {} },
    triggers: [],
    fnExport: "doThing",
    alwaysAvailable: false,
    requiredPermissions: [],
    ...overrides,
  };
}

Deno.test("upsertToolkit: insert then update preserves enabled state", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    assertEquals(r.get("example-toolkit")?.enabled, true);
    r.setEnabled("example-toolkit", false);
    // Re-upsert with the same id must not reset `enabled` (only an explicit
    // setEnabled does that). Update path runs UPDATE without touching the
    // enabled column.
    r.upsertToolkit(tk({ version: "1.0.1" }));
    assertEquals(r.get("example-toolkit")?.enabled, false);
    assertEquals(r.get("example-toolkit")?.version, "1.0.1");
  } finally {
    await env.teardown();
  }
});

Deno.test("getOrThrow: throws toolkit_not_found on missing id", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    const err = assertThrows(() => r.getOrThrow("nope"), AppError);
    assertEquals(err.code, "toolkit_not_found");
  } finally {
    await env.teardown();
  }
});

Deno.test("replaceTools: drops old tools, inserts new, preserves enabled on matched names", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    r.replaceTools("example-toolkit", [tool({ name: "keep" }), tool({ name: "drop" })]);
    r.setToolEnabled("example-toolkit", "keep", true);
    // Re-install: "keep" stays, "drop" is gone, "new" arrives disabled.
    r.replaceTools("example-toolkit", [tool({ name: "keep" }), tool({ name: "new" })]);
    const tools = r.listTools("example-toolkit");
    const byName = new Map(tools.map((t) => [t.name, t]));
    assertEquals(byName.has("keep"), true);
    assertEquals(byName.has("drop"), false);
    assertEquals(byName.has("new"), true);
    // Preserved enabled.
    assertEquals(byName.get("keep")?.enabled, true);
    // New tool defaults to disabled (conservative re-install policy).
    assertEquals(byName.get("new")?.enabled, false);
  } finally {
    await env.teardown();
  }
});

Deno.test("setGrants + listGrantsForTool: records granted + denied, upserts by (tool, key)", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    r.replaceTools("example-toolkit", [tool()]);
    const toolId = r.listTools("example-toolkit")[0].id;
    const decl: PermissionDecl = {
      kind: "net",
      host: "x.example.com",
      ports: [443],
      reason: "y",
    };
    const key = permissionKey(decl);
    r.setGrants(toolId, [{ key, kind: "net", state: "granted" }]);
    let grants = r.listGrantsForTool(toolId);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].state, "granted");
    // Upsert to denied must not duplicate the row.
    r.setGrants(toolId, [{ key, kind: "net", state: "denied" }]);
    grants = r.listGrantsForTool(toolId);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].state, "denied");
  } finally {
    await env.teardown();
  }
});

Deno.test("delete: cascades to tools and grants", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    r.replaceTools("example-toolkit", [tool()]);
    const toolId = r.listTools("example-toolkit")[0].id;
    const decl: PermissionDecl = { kind: "ffi", reason: "x" };
    r.setGrants(toolId, [
      {
        key: permissionKey(decl),
        kind: "ffi",
        state: "granted",
      },
    ]);
    r.delete("example-toolkit");
    assertEquals(r.get("example-toolkit"), undefined);
    assertEquals(r.listTools("example-toolkit"), []);
    assertEquals(r.listGrantsForTool(toolId), []);
  } finally {
    await env.teardown();
  }
});
