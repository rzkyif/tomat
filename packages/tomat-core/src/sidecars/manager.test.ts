// Integration test for SidecarManager. Spawns a fake HTTP sidecar
// (tests/fixtures/sidecars/http-stub.ts) via the real Deno binary and
// drives the manager through its lifecycle.

import { assertEquals } from "@std/assert";
import { __resetForTesting, sidecarManager } from "./manager.ts";
import type { SidecarSnapshot } from "./types.ts";
import { initLogger } from "../shared/log.ts";
import { freePort } from "../../tests/helpers/free-port.ts";

// Isolate core paths (incl. the logger's core.log) to a tempdir so this
// integration test never writes into the developer's real ~/.tomat.
Deno.env.set(
  "TOMAT_CORE_HOME",
  await Deno.makeTempDir({ prefix: "tomat-sidecar-test-" }),
);
await initLogger();

const STUB_PATH = new URL(
  "../../tests/fixtures/sidecars/http-stub.ts",
  import.meta.url,
).pathname;

function buildOpts(port: number) {
  return {
    binary: Deno.execPath(),
    args: ["run", `--allow-net=127.0.0.1:${port}`, STUB_PATH, String(port)],
    readiness: {
      kind: "http" as const,
      url: `http://127.0.0.1:${port}/health`,
    },
    startupTimeoutMs: 10_000,
    restartPolicy: "none" as const,
  };
}

Deno.test({
  name: "SidecarManager: start transitions Disabled -> Loading -> Running",
  // The manager intentionally keeps a watchExit task alive on the spawned
  // subprocess for restart-on-crash, so the default sanitizers complain
  // about leftover async ops. We assert clean stop below.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    __resetForTesting();
    const mgr = sidecarManager();
    const port = freePort();
    const states: SidecarSnapshot["status"][] = [];
    mgr.subscribe((s) => {
      if (s.kind === "llama") states.push(s.status);
    });

    await mgr.start("llama", buildOpts(port));
    assertEquals(mgr.status("llama").status, "Running");
    assertEquals(states.at(-1), "Running");
    // First transition off "Disabled" must be "Loading".
    assertEquals(states[0], "Loading");

    await mgr.stop("llama");
    assertEquals(mgr.status("llama").status, "Disabled");
  },
});

Deno.test({
  name: "SidecarManager: second start supersedes the first and reaches Running",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    __resetForTesting();
    const mgr = sidecarManager();
    const port = freePort();

    await mgr.start("llama", buildOpts(port));
    assertEquals(mgr.status("llama").status, "Running");
    await mgr.start("llama", buildOpts(port));
    assertEquals(mgr.status("llama").status, "Running");
    await mgr.stop("llama");
  },
});

Deno.test({
  name: "SidecarManager: status() reports Disabled before any start",
  fn() {
    __resetForTesting();
    const mgr = sidecarManager();
    assertEquals(mgr.status("llama").status, "Disabled");
  },
});
