// arg parser. The rest of tomat-core-updater is process-orchestration
// (sleep, rename, spawn, exit) that can't usefully be unit tested. Cover
// that path with a real-binary integration run when needed; for now we
// only lock the contract that core depends on.

import { assertEquals } from "@std/assert";
import { parseUpdaterArgs } from "./main.ts";

Deno.test("parseUpdaterArgs: accepts --staged and --current, defaults restart-args to []", () => {
  const r = parseUpdaterArgs([
    "--staged",
    "/tmp/new",
    "--current",
    "/usr/local/bin/tomat-core",
  ]);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.value.staged, "/tmp/new");
    assertEquals(r.value.current, "/usr/local/bin/tomat-core");
    assertEquals(r.value.restartArgs, "[]");
  }
});

Deno.test("parseUpdaterArgs: forwards --restart-args JSON verbatim", () => {
  const r = parseUpdaterArgs([
    "--staged",
    "/tmp/new",
    "--current",
    "/usr/local/bin/tomat-core",
    "--restart-args",
    `["--port","8000"]`,
  ]);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value.restartArgs, `["--port","8000"]`);
});

Deno.test("parseUpdaterArgs: missing --staged returns missing-required", () => {
  const r = parseUpdaterArgs(["--current", "/x"]);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "missing-required");
});

Deno.test("parseUpdaterArgs: missing --current returns missing-required", () => {
  const r = parseUpdaterArgs(["--staged", "/x"]);
  assertEquals(r.ok, false);
});

Deno.test("parseUpdaterArgs: empty argv returns missing-required", () => {
  const r = parseUpdaterArgs([]);
  assertEquals(r.ok, false);
});
