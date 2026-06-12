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

Deno.test("upsertToolkit + status transitions: downloaded -> installed -> drift", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    // Download leaves the toolkit unpinned + 'downloaded'.
    r.upsertToolkit(tk({ contentHash: "" }));
    assertEquals(r.get("example-toolkit")?.status, "downloaded");
    assertEquals(r.get("example-toolkit")?.contentHash, "");
    // Install pins the hash + flips to 'installed'.
    r.markInstalled("example-toolkit", "cafebabe");
    assertEquals(r.get("example-toolkit")?.status, "installed");
    assertEquals(r.get("example-toolkit")?.contentHash, "cafebabe");
    // Uninstall reverts to 'downloaded' and unpins the hash.
    r.markDownloaded("example-toolkit");
    assertEquals(r.get("example-toolkit")?.status, "downloaded");
    assertEquals(r.get("example-toolkit")?.contentHash, "");
    // A re-download resets to 'downloaded' + clears the pin (re-install needed).
    r.upsertToolkit(tk({ version: "1.0.1", contentHash: "" }));
    assertEquals(r.get("example-toolkit")?.status, "downloaded");
    assertEquals(r.get("example-toolkit")?.contentHash, "");
    assertEquals(r.get("example-toolkit")?.version, "1.0.1");
    // Drift keeps the pinned hash but flips status.
    r.markInstalled("example-toolkit", "feedface");
    r.markDrift("example-toolkit");
    assertEquals(r.get("example-toolkit")?.status, "drift");
    assertEquals(r.get("example-toolkit")?.contentHash, "feedface");
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

Deno.test("replaceTools: preserves grants when required perms unchanged, drops when changed", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    const net: PermissionDecl = { kind: "net", host: "x.example.com", ports: [443], reason: "y" };
    r.replaceTools("example-toolkit", [tool({ name: "t", requiredPermissions: [net] })]);
    const toolId = r.listTools("example-toolkit")[0].id;
    r.setGrants(toolId, [{ key: permissionKey(net), kind: "net", state: "granted" }]);

    // Re-download with the SAME required-permission set: grant survives.
    r.replaceTools("example-toolkit", [tool({ name: "t", requiredPermissions: [net] })]);
    assertEquals(r.listGrantsForTool(toolId).length, 1);
    assertEquals(r.listGrantsForTool(toolId)[0].state, "granted");

    // Re-download with a CHANGED required-permission set: grant dropped.
    const net2: PermissionDecl = { kind: "net", host: "y.example.com", ports: [443], reason: "y" };
    r.replaceTools("example-toolkit", [tool({ name: "t", requiredPermissions: [net2] })]);
    assertEquals(r.listGrantsForTool(toolId).length, 0);
  } finally {
    await env.teardown();
  }
});

Deno.test("disableAllTools: clears every tool's enabled flag (drift auto-disable)", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    r.replaceTools("example-toolkit", [tool({ name: "a" }), tool({ name: "b" })]);
    r.setToolEnabled("example-toolkit", "a", true);
    r.setToolEnabled("example-toolkit", "b", true);
    r.disableAllTools("example-toolkit");
    assertEquals(
      r.listTools("example-toolkit").every((t) => !t.enabled),
      true,
    );
  } finally {
    await env.teardown();
  }
});

Deno.test("list/get project tool counts: total + enabled", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    r.replaceTools("example-toolkit", [
      tool({ name: "a" }),
      tool({ name: "b" }),
      tool({ name: "c" }),
    ]);
    r.setToolEnabled("example-toolkit", "a", true);
    r.setToolEnabled("example-toolkit", "b", true);
    const got = r.get("example-toolkit");
    assertEquals(got?.toolCount, 3);
    assertEquals(got?.enabledToolCount, 2);
    const listed = r.list().find((t) => t.id === "example-toolkit");
    assertEquals(listed?.toolCount, 3);
    assertEquals(listed?.enabledToolCount, 2);
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

Deno.test("setGrants: round-trips the ask state", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    const net: PermissionDecl = { kind: "net", host: "api.example.com", ports: [443], reason: "x" };
    r.replaceTools("example-toolkit", [tool({ requiredPermissions: [net] })]);
    const toolId = r.listTools("example-toolkit")[0].id;
    const key = permissionKey(net);
    r.setGrants(toolId, [{ key, kind: "net", state: "ask" }]);
    assertEquals(r.listGrantsForTool(toolId)[0].state, "ask");
    // ask -> granted upserts in place.
    r.setGrants(toolId, [{ key, kind: "net", state: "granted" }]);
    const grants = r.listGrantsForTool(toolId);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].state, "granted");
  } finally {
    await env.teardown();
  }
});

Deno.test("undeclared policy: defaults to deny, settable, survives re-download", async () => {
  const env = await setupTestEnv();
  try {
    const r = toolkitsRegistry();
    r.upsertToolkit(tk());
    assertEquals(r.get("example-toolkit")?.undeclaredPolicy, "deny");
    r.setUndeclaredPolicy("example-toolkit", "ask");
    assertEquals(r.get("example-toolkit")?.undeclaredPolicy, "ask");
    // A toolkit update (re-download upsert) must not reset the user's choice.
    r.upsertToolkit(tk({ version: "1.0.1" }));
    assertEquals(r.get("example-toolkit")?.undeclaredPolicy, "ask");
  } finally {
    await env.teardown();
  }
});
