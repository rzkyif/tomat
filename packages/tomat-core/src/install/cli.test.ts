// Hermetic tests for the install subcommand dispatcher + bootstrap. Runs the
// `bootstrap` verb against a temp TOMAT_CORE_HOME on the dev channel (which skips
// the network extension plant), so no service registration or network is
// touched. Service registration (launchd/systemd/Task Scheduler) is exercised by
// the end-to-end verification, not here.

import { assertEquals, assertMatch } from "@std/assert";
import { maybeRunInstallCommand } from "./cli.ts";
import { paths } from "../paths.ts";

async function withDevCoreHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "tomat-install-test-" });
  const priorHome = Deno.env.get("TOMAT_CORE_HOME");
  const priorChannel = Deno.env.get("TOMAT_CHANNEL");
  Deno.env.set("TOMAT_CORE_HOME", home);
  Deno.env.set("TOMAT_CHANNEL", "dev");
  try {
    await fn(home);
  } finally {
    if (priorHome === undefined) Deno.env.delete("TOMAT_CORE_HOME");
    else Deno.env.set("TOMAT_CORE_HOME", priorHome);
    if (priorChannel === undefined) Deno.env.delete("TOMAT_CHANNEL");
    else Deno.env.set("TOMAT_CHANNEL", priorChannel);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

Deno.test("dispatcher returns null for non-subcommands", async () => {
  assertEquals(await maybeRunInstallCommand([]), null);
  assertEquals(await maybeRunInstallCommand(["--watch"]), null);
  assertEquals(await maybeRunInstallCommand(["frobnicate"]), null);
});

Deno.test("bootstrap mints a 0600 admin token and is idempotent", async () => {
  await withDevCoreHome(async () => {
    assertEquals(await maybeRunInstallCommand(["bootstrap"]), 0);

    const token = await Deno.readTextFile(paths().adminTokenFile);
    // 16 random bytes as lowercase hex.
    assertMatch(token.trim(), /^[0-9a-f]{32}$/);

    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(paths().adminTokenFile)).mode ?? 0;
      assertEquals(mode & 0o777, 0o600);
    }

    // Dev channel plants no built-in extension (it resolves from the codebase),
    // so bootstrap makes no network request and leaves the extensions dir bare.
    for await (const entry of Deno.readDir(paths().extensionsDir)) {
      throw new Error(`unexpected extensions dir entry on dev: ${entry.name}`);
    }

    // A second run keeps the same token (idempotent).
    assertEquals(await maybeRunInstallCommand(["bootstrap"]), 0);
    assertEquals(await Deno.readTextFile(paths().adminTokenFile), token);
  });
});

Deno.test("bootstrap --bind-all seeds settings.json", async () => {
  await withDevCoreHome(async () => {
    assertEquals(await maybeRunInstallCommand(["bootstrap", "--bind-all"]), 0);
    const settings = JSON.parse(await Deno.readTextFile(paths().settingsFile));
    assertEquals(settings["server.bindHost"], "0.0.0.0");
  });
});
