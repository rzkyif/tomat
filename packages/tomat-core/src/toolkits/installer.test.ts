// toolkit installer: local install path (no network, no npm tarball
// fetch). Drives the full path from source dir -> registry rows via the
// real `startInstall`. The npm tarball path is covered by integration in
// real installs; isolating it would require a fixture tarball server.

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import {
  flattenNpmName,
  flattenPermissions,
  type InstallEventSink,
  isWithin,
  startInstall,
} from "./installer.ts";
import { toolkitsRegistry } from "./registry.ts";

// --- Pure helper tests ------------------------------------------------------

Deno.test("flattenNpmName: scope rewrite", () => {
  assertEquals(flattenNpmName("plain"), "plain");
  assertEquals(flattenNpmName("@tomat/builtin"), "@tomat__builtin");
});

Deno.test("flattenPermissions: walks every documented kind", () => {
  const out = flattenPermissions({
    net: [{ host: "api.example", reason: "fetch", ports: [443] }],
    read: [{ path: "$home/x", reason: "config" }],
    write: [{ path: "$downloads", reason: "save" }],
    run: [{ binary: "git", reason: "vcs" }],
    env: [{ key: "OPENAI_KEY", reason: "auth" }],
    ffi: [{ reason: "native" }],
    sys: [{ flag: "hostname", reason: "ident" }],
  });
  const kinds = out.map((p) => p.kind).sort();
  assertEquals(kinds, ["env", "ffi", "net", "read", "run", "sys", "write"]);
});

Deno.test("flattenPermissions: returns empty array when permissions object is absent", () => {
  assertEquals(flattenPermissions(undefined), []);
});

Deno.test("isWithin: accepts in-tree paths, rejects zip-slip traversal", () => {
  const root = "/tmp/toolkit";
  // In-tree entries are allowed.
  assertEquals(isWithin(root, join(root, "tools.json")), true);
  assertEquals(isWithin(root, join(root, "src/index.ts")), true);
  assertEquals(isWithin(root, root), true);
  // A `package/`-stripped traversal entry must be rejected.
  assertEquals(isWithin(root, join(root, "../../../bin/tomat-core")), false);
  assertEquals(isWithin(root, join(root, "../sibling")), false);
  // A sibling dir that merely shares a prefix is NOT inside root.
  assertEquals(isWithin(root, "/tmp/toolkit-evil/x"), false);
  // Absolute escape outside root.
  assertEquals(isWithin(root, "/etc/passwd"), false);
});

// --- Local-install integration ----------------------------------------------

const MIN_TOOLS_JSON = JSON.stringify({
  $schema: "https://au.tomat.ing/schemas/tools.json",
  name: "mini",
  description: "tiny test toolkit",
  tools: [
    {
      name: "noop",
      description: "does nothing",
      function: "noop",
      parameters: { type: "object", properties: {} },
    },
  ],
});

async function awaitDone(
  sink: InstallEventSink & { result: Promise<{ ok: boolean; code: number }> },
): Promise<{ ok: boolean; code: number }> {
  return await sink.result;
}

function makeRecordingSink() {
  let done!: (r: { ok: boolean; code: number }) => void;
  const result = new Promise<{ ok: boolean; code: number }>((r) => {
    done = r;
  });
  const logs: Array<{ stream: string; line: string }> = [];
  const sink: InstallEventSink & {
    result: Promise<{ ok: boolean; code: number }>;
    logs: typeof logs;
  } = {
    log(_jobId, _id, stream, line) {
      logs.push({ stream, line });
    },
    done(_jobId, _id, ok, code) {
      done({ ok, code });
    },
    result,
    logs,
  };
  return sink;
}

Deno.test("startInstall(local): copies tree -> validates tools.json -> upserts registry", async () => {
  const env = await setupTestEnv();
  try {
    // Synthesize a "local" toolkit on disk with tools.json + index.ts.
    const srcDir = await Deno.makeTempDir({ prefix: "tomat-tk-src-" });
    await Deno.writeTextFile(join(srcDir, "tools.json"), MIN_TOOLS_JSON);
    await Deno.writeTextFile(
      join(srcDir, "index.ts"),
      `export async function noop() { return null; }\n`,
    );

    const sink = makeRecordingSink();
    const { toolkitId } = startInstall({ source: "local", path: srcDir, slug: "mini-test" }, sink);
    assertEquals(toolkitId, "mini-test");

    const out = await awaitDone(sink);
    assertEquals(out.ok, true);
    assertEquals(out.code, 0);

    // Registry row exists with the right metadata.
    const tk = toolkitsRegistry().get("mini-test");
    assertExists(tk);
    assertEquals(tk?.displayName, "mini");
    // Local installs are recorded with version "local".
    assertEquals(tk?.version, "local");
    // Tool row exists.
    const tools = toolkitsRegistry().listTools("mini-test");
    assertEquals(tools.length, 1);
    assertEquals(tools[0].name, "noop");

    // Files landed at the install path.
    const installed = join(paths().toolkitsDir, "mini-test");
    const installedToolsJson = await Deno.readTextFile(join(installed, "tools.json"));
    assertEquals(installedToolsJson, MIN_TOOLS_JSON);
  } finally {
    await env.teardown();
  }
});

Deno.test("startInstall(local): missing tools.json reports failure code 3", async () => {
  const env = await setupTestEnv();
  try {
    const srcDir = await Deno.makeTempDir({ prefix: "tomat-tk-bad-" });
    // No tools.json at all.
    await Deno.writeTextFile(join(srcDir, "index.ts"), `export const x = 1;`);

    const sink = makeRecordingSink();
    startInstall({ source: "local", path: srcDir, slug: "bad" }, sink);
    const out = await awaitDone(sink);
    assertEquals(out.ok, false);
    assertEquals(out.code, 3);

    // No registry row written.
    assertEquals(toolkitsRegistry().get("bad"), undefined);
  } finally {
    await env.teardown();
  }
});

Deno.test("startInstall(local): malformed tools.json reports failure code 4", async () => {
  const env = await setupTestEnv();
  try {
    const srcDir = await Deno.makeTempDir({ prefix: "tomat-tk-malformed-" });
    await Deno.writeTextFile(join(srcDir, "tools.json"), `{ not valid json`);

    const sink = makeRecordingSink();
    startInstall({ source: "local", path: srcDir, slug: "malformed" }, sink);
    const out = await awaitDone(sink);
    assertEquals(out.ok, false);
    assertEquals(out.code, 4);
  } finally {
    await env.teardown();
  }
});
