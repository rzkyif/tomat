// client.json is the Tauri updater endpoint, so its `platforms` map is keyed in
// Tauri's `<os>-<arch>` format (darwin-aarch64, windows-x86_64, linux-x86_64),
// produced by tauriPlatformKey() in scripts/release/client.ts. The standalone
// install scripts (curl | bash / irm | iex) must look up the SAME key, not the
// Rust triple - a regression to `.platforms[<rust-triple>]` silently breaks
// first-install on every platform (the lookup misses and the script aborts with
// "no client artifact for ... in manifest"). This guards the scripts' key
// formula + lookup against that drift.

import { assert, assertEquals } from "@std/assert";

const SCRIPTS = new URL("../../../../scripts/install/", import.meta.url);

async function readScript(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, SCRIPTS));
}

// The canonical Tauri platform keys per desktop triple (mirrors tauriPlatformKey).
const EXPECTED: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "aarch64-pc-windows-msvc": "windows-aarch64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
};

Deno.test("client.sh resolves client.json by the Tauri platform key, not the rust triple", async () => {
  const sh = await readScript("client.sh");
  // Builds the <os>-<arch> key for darwin + linux.
  assert(
    /PLATFORM_KEY="darwin-\$\{HOST_ARCH\}"/.test(sh),
    "client.sh must build darwin-<arch> key",
  );
  assert(/PLATFORM_KEY="linux-\$\{HOST_ARCH\}"/.test(sh), "client.sh must build linux-<arch> key");
  // The platform lookup uses $PLATFORM_KEY, never the rust $TRIPLE.
  assert(
    sh.includes('--arg t "$PLATFORM_KEY"'),
    "client.sh must look up .platforms by $PLATFORM_KEY",
  );
  assert(
    !/--arg t "\$TRIPLE"/.test(sh),
    "client.sh must NOT look up .platforms by the rust $TRIPLE (the pre-fix bug)",
  );
});

Deno.test("client.ps1 resolves client.json by the Tauri platform key, not the rust triple", async () => {
  const ps = await readScript("client.ps1");
  assert(/\$PlatformKey = "windows-\$arch"/.test(ps), "client.ps1 must build windows-<arch> key");
  assert(
    ps.includes("$manifest.platforms.$PlatformKey"),
    "client.ps1 must look up platforms by $PlatformKey",
  );
  assert(
    !/\$manifest\.platforms\.\$Triple/.test(ps),
    "client.ps1 must NOT look up platforms by the rust $Triple (the pre-fix bug)",
  );
});

Deno.test("the scripts' key formula reproduces the canonical Tauri keys for every triple", () => {
  // Reimplement the scripts' `<os-short>-<arch>` formula and confirm it equals
  // the manifest's keys, so the install scripts and tauriPlatformKey agree.
  for (const [triple, key] of Object.entries(EXPECTED)) {
    const arch = triple.startsWith("aarch64") ? "aarch64" : "x86_64";
    const osShort = triple.endsWith("apple-darwin")
      ? "darwin"
      : triple.endsWith("pc-windows-msvc")
        ? "windows"
        : "linux";
    assertEquals(`${osShort}-${arch}`, key, `key formula mismatch for ${triple}`);
  }
});
