// Module broker gating: grant states, undeclared policy, documents
// read/write coverage, and the db declaration gate. Op dispatch behavior is
// covered by the per-module suites; here a gated request that reaches
// dispatch (clean resolve, or its arg-validation / unknown-op error) is the
// "gate passed" signal.

import { assertEquals, assertRejects } from "@std/assert";
import type { PermissionDecl } from "@tomat/shared";
import { permissionKey } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { toolkitsRegistry } from "../toolkits/registry.ts";
import { AppError } from "../shared/errors.ts";
import {
  deleteToolkitData,
  handleModuleRequest,
  type ModulePrompt,
  type ModuleRequest,
} from "./module-broker.ts";

const TOOLKIT_ID = "example-toolkit";
const TOOL_NAME = "do_thing";

function seedToolkit(
  opts: {
    id?: string;
    permissions?: PermissionDecl[];
    undeclaredPolicy?: "deny" | "ask";
    hasDatabase?: boolean;
  } = {},
): void {
  const id = opts.id ?? TOOLKIT_ID;
  const r = toolkitsRegistry();
  r.upsertToolkit({
    id,
    source: "npm",
    displayName: "Example",
    version: "1.0.0",
    installedPath: "/tmp/example",
    toolsJsonHash: "deadbeef",
    contentHash: "cafebabe",
    status: "installed",
    hasDatabase: opts.hasDatabase ?? false,
  });
  if (opts.undeclaredPolicy) r.setUndeclaredPolicy(id, opts.undeclaredPolicy);
  r.replaceTools(id, [
    {
      toolkitId: id,
      name: TOOL_NAME,
      description: "does",
      parameters: { type: "object", properties: {} },
      triggers: [],
      fnExport: "doThing",
      alwaysAvailable: false,
      requiredPermissions: opts.permissions ?? [],
    },
  ]);
}

function setGrant(decl: PermissionDecl, state: "granted" | "ask" | "denied"): void {
  toolkitsRegistry().setGrants(`${TOOLKIT_ID}::${TOOL_NAME}`, [
    { key: permissionKey(decl), kind: decl.kind, state },
  ]);
}

// Runs a request with a scripted promptUser; returns the outcome plus the
// prompts the broker raised.
async function run(
  module: ModuleRequest["module"],
  op: string,
  allow: boolean,
): Promise<{ outcome: "dispatched" | "forbidden" | "other"; prompts: ModulePrompt[] }> {
  const prompts: ModulePrompt[] = [];
  try {
    await handleModuleRequest({
      toolkitId: TOOLKIT_ID,
      toolName: TOOL_NAME,
      callId: "call-1",
      module,
      op,
      args: {},
      promptUser: (p) => {
        prompts.push(p);
        return Promise.resolve(allow);
      },
    });
    return { outcome: "dispatched", prompts };
  } catch (err) {
    if (err instanceof AppError && err.code === "forbidden") {
      return { outcome: "forbidden", prompts };
    }
    if (
      err instanceof AppError &&
      (err.code === "validation_error" || err.code === "server_unavailable")
    ) {
      // Dispatch-level error (arg validation, unknown op, module turned
      // off, sidecar unreachable): the gate passed.
      return { outcome: "dispatched", prompts };
    }
    return { outcome: "other", prompts };
  }
}

const LLM_DECL: PermissionDecl = { kind: "llm", reason: "summarize things" };
const DOCS_READ: PermissionDecl = { kind: "documents", access: "read", reason: "read notes" };
const DOCS_WRITE: PermissionDecl = { kind: "documents", access: "write", reason: "edit notes" };

Deno.test("broker: granted state dispatches without prompting", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ permissions: [LLM_DECL] });
    setGrant(LLM_DECL, "granted");
    const { outcome, prompts } = await run("llm", "complete", false);
    assertEquals(outcome, "dispatched");
    assertEquals(prompts.length, 0);
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: ask state prompts with the declared reason", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ permissions: [LLM_DECL] });
    // No grant row at all behaves as ask.
    const accepted = await run("llm", "complete", true);
    assertEquals(accepted.outcome, "dispatched");
    assertEquals(accepted.prompts, [
      { permission: "llm", resource: "", declared: true, reason: "summarize things" },
    ]);
    const rejected = await run("llm", "complete", false);
    assertEquals(rejected.outcome, "forbidden");
    assertEquals(rejected.prompts.length, 1);
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: denied state rejects without prompting", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ permissions: [LLM_DECL] });
    setGrant(LLM_DECL, "denied");
    const { outcome, prompts } = await run("llm", "complete", true);
    assertEquals(outcome, "forbidden");
    assertEquals(prompts.length, 0);
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: undeclared follows the toolkit policy", async () => {
  const env = await setupTestEnv();
  try {
    // Default policy is deny: reject without prompting.
    seedToolkit();
    const denied = await run("tts", "speak", true);
    assertEquals(denied.outcome, "forbidden");
    assertEquals(denied.prompts.length, 0);
    // Policy ask: forward as undeclared.
    seedToolkit({ undeclaredPolicy: "ask" });
    const asked = await run("tts", "speak", true);
    assertEquals(asked.outcome, "dispatched");
    assertEquals(asked.prompts, [{ permission: "tts", resource: "", declared: false }]);
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: documents write grant covers read ops, not vice versa", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ permissions: [DOCS_WRITE] });
    setGrant(DOCS_WRITE, "granted");
    const read = await run("documents", "get", false);
    assertEquals(read.outcome, "dispatched");
    assertEquals(read.prompts.length, 0);

    // A read-only declaration leaves write ops undeclared (policy deny).
    seedToolkit({ permissions: [DOCS_READ] });
    setGrant(DOCS_READ, "granted");
    const write = await run("documents", "write", true);
    assertEquals(write.outcome, "forbidden");
    assertEquals(write.prompts.length, 0);
    // The read grant itself still works.
    const read2 = await run("documents", "list", false);
    assertEquals(read2.outcome, "dispatched");
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: documents ops round-trip through the store", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ permissions: [DOCS_WRITE] });
    setGrant(DOCS_WRITE, "granted");
    const call = (op: string, args: unknown) =>
      handleModuleRequest({
        toolkitId: TOOLKIT_ID,
        toolName: TOOL_NAME,
        callId: "call-1",
        module: "documents",
        op,
        args,
        promptUser: () => Promise.resolve(false),
      });

    const created = await call("write", { title: "Notes", content: "alpha" });
    assertEquals(created, { title: "Notes", before: "", after: "alpha", created: true });
    const replaced = await call("write", { title: "Notes", content: "beta" });
    assertEquals(replaced, { title: "Notes", before: "alpha", after: "beta", created: false });
    const edited = await call("edit", { title: "Notes", find: "beta", replace: "gamma" });
    assertEquals(edited, { title: "Notes", before: "beta", after: "gamma" });
    assertEquals(await call("get", { title: "Notes" }), { title: "Notes", content: "gamma" });
    const listing = (await call("list", {})) as Array<{ title: string }>;
    assertEquals(
      listing.map((d) => d.title),
      ["Notes"],
    );

    // Missing documents and missing args surface as clear errors.
    await assertRejects(() => call("get", { title: "Nope" }), AppError, "not found");
    await assertRejects(() => call("write", { title: "X" }), AppError, "content");
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: db is gated by the toolkit database declaration", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ hasDatabase: false });
    const blocked = await run("db", "query", true);
    assertEquals(blocked.outcome, "forbidden");
    assertEquals(blocked.prompts.length, 0);

    seedToolkit({ hasDatabase: true });
    const allowed = await run("db", "query", true);
    assertEquals(allowed.outcome, "dispatched");
    assertEquals(allowed.prompts.length, 0);
  } finally {
    await env.teardown();
  }
});

Deno.test("broker: db rejects ATTACH/DETACH and VACUUM INTO (sandbox escape)", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ hasDatabase: true });
    const call = (sql: string) =>
      handleModuleRequest({
        toolkitId: TOOLKIT_ID,
        toolName: TOOL_NAME,
        callId: "call-1",
        module: "db",
        op: "execute",
        args: { sql, params: [] },
        promptUser: () => Promise.resolve(false),
      });
    for (const sql of [
      "ATTACH DATABASE 'x.db' AS x",
      "attach database 'x.db' as x",
      "  DETACH DATABASE x",
      "VACUUM main INTO 'out.db'",
    ]) {
      await assertRejects(() => call(sql), AppError, "not allowed");
    }
    // A literal containing the word "attach" is fine: the screen strips
    // string contents before matching keywords.
    await call("CREATE TABLE notes (body TEXT)");
    const ok = await call("INSERT INTO notes (body) VALUES ('please attach the file')");
    assertEquals((ok as { changes: number }).changes, 1);
  } finally {
    deleteToolkitData(TOOLKIT_ID);
    await env.teardown();
  }
});

Deno.test("broker: db returns BigInt-magnitude integers as JSON-safe values", async () => {
  const env = await setupTestEnv();
  try {
    seedToolkit({ hasDatabase: true });
    const call = (op: string, sql: string) =>
      handleModuleRequest({
        toolkitId: TOOLKIT_ID,
        toolName: TOOL_NAME,
        callId: "call-1",
        module: "db",
        op,
        args: { sql, params: [] },
        promptUser: () => Promise.resolve(false),
      });
    await call("execute", "CREATE TABLE big (n INTEGER)");
    // 2^60 exceeds MAX_SAFE_INTEGER, so int64 returns it as a BigInt; the
    // broker must map it to a JSON-serializable form.
    await call("execute", "INSERT INTO big (n) VALUES (1152921504606846976)");
    const rows = (await call("query", "SELECT n FROM big")) as Array<{ n: unknown }>;
    const value = rows[0].n;
    assertEquals(typeof value === "number" || typeof value === "string", true);
    // Whatever the representation, it must survive JSON.stringify (the module
    // response is sent as JSON); a raw BigInt would throw here.
    JSON.stringify(rows);
  } finally {
    deleteToolkitData(TOOLKIT_ID);
    await env.teardown();
  }
});

Deno.test("broker: db ops persist per toolkit and stay isolated", async () => {
  const env = await setupTestEnv();
  const A = "db-iso-a";
  const B = "db-iso-b";
  try {
    seedToolkit({ id: A, hasDatabase: true });
    seedToolkit({ id: B, hasDatabase: true });
    const call = (toolkitId: string, op: string, args: unknown) =>
      handleModuleRequest({
        toolkitId,
        toolName: TOOL_NAME,
        callId: "call-1",
        module: "db",
        op,
        args,
        promptUser: () => Promise.resolve(false),
      });

    await call(A, "execute", { sql: "CREATE TABLE notes (body TEXT)", params: [] });
    const inserted = await call(A, "execute", {
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["hello"],
    });
    assertEquals((inserted as { changes: number }).changes, 1);
    assertEquals(await call(A, "query", { sql: "SELECT body FROM notes", params: [] }), [
      { body: "hello" },
    ]);

    // Toolkit B has its own database file: A's table does not exist there.
    await assertRejects(
      () => call(B, "query", { sql: "SELECT body FROM notes", params: [] }),
      Error,
      "no such table",
    );
  } finally {
    deleteToolkitData(A);
    deleteToolkitData(B);
    await env.teardown();
  }
});
