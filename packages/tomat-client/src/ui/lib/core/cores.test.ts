// CoresRegistry: cores.json CRUD against an in-memory platform mock (registry
// file + keychain). select()/connection behavior needs a live core and is
// exercised by the e2e flows, not here.

import { describe, expect, it } from "vitest";
import { type Platform, setPlatform } from "$lib/platform";
import { cores, isLoopbackUrl, type PairedCoreEntry, pruneUninstalledLocalCores } from "./cores";

// Mutable knob for platform().pairing.isLocalCoreInstalled: `true`/`false`
// return that, `"throw"` rejects (the best-effort error path).
type LocalCoreInstalled = boolean | "throw";

function makeMockPlatform(localCoreInstalled: LocalCoreInstalled = true): {
  platform: Platform;
  files: Record<string, Record<string, unknown>>;
  tokens: Record<string, string>;
} {
  const files: Record<string, Record<string, unknown>> = {};
  const tokens: Record<string, string> = {};
  const platform = {
    clientFiles: {
      async read(file: string) {
        return JSON.parse(JSON.stringify(files[file] ?? {}));
      },
      async write(file: string, data: Record<string, unknown>) {
        files[file] = JSON.parse(JSON.stringify(data));
      },
    },
    keychain: {
      async set(coreId: string, token: string) {
        tokens[coreId] = token;
      },
      async get(coreId: string) {
        return tokens[coreId] ?? null;
      },
      async delete(coreId: string) {
        delete tokens[coreId];
      },
    },
    pairing: {
      async isLocalCoreInstalled() {
        if (localCoreInstalled === "throw") throw new Error("check failed");
        return localCoreInstalled;
      },
    },
  } as unknown as Platform;
  return { platform, files, tokens };
}

const entry = (id: string, name = "Local Core"): PairedCoreEntry => ({
  id,
  name,
  baseUrl: "https://127.0.0.1:7800",
  trustMode: "pin",
  tlsPin: "pin",
  addedAtMs: 1,
});

const remoteEntry = (id: string, name = "Remote Core"): PairedCoreEntry => ({
  id,
  name,
  baseUrl: "https://192.168.1.5:7800",
  trustMode: "pin",
  tlsPin: "pin",
  addedAtMs: 1,
});

describe("isLoopbackUrl", () => {
  it("matches loopback hosts", () => {
    expect(isLoopbackUrl("https://127.0.0.1:7800")).toBe(true);
    expect(isLoopbackUrl("https://localhost:7800")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.2:7800")).toBe(true);
    expect(isLoopbackUrl("https://[::1]:7800")).toBe(true);
  });

  it("does NOT match remote hosts that merely contain a loopback substring", () => {
    // The old substring check would misread these as local and delete them.
    expect(isLoopbackUrl("https://localhost.example.com:7800")).toBe(false);
    expect(isLoopbackUrl("https://127.0.0.1.evil.com:7800")).toBe(false);
    expect(isLoopbackUrl("https://mylocalhost.net")).toBe(false);
    expect(isLoopbackUrl("https://192.168.1.5:7800")).toBe(false);
  });

  it("treats an unparseable URL as remote (never pruned)", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("cores registry", () => {
  it("addPaired writes cores.json and the keychain; list reads it back", async () => {
    const { platform, files, tokens } = makeMockPlatform();
    setPlatform(platform);

    await cores().addPaired(entry("core-a"), "token-a");
    expect(tokens["core-a"]).toBe("token-a");
    expect(files.cores).toEqual({
      cores: [entry("core-a")],
      currentCoreId: "core-a",
    });
    expect(await cores().list()).toEqual([entry("core-a")]);
  });

  it("addPaired rejects (and records nothing) when the keychain write doesn't persist", async () => {
    const { platform, files } = makeMockPlatform();
    // Simulate a silently-failing keychain: set() resolves but stores nothing.
    platform.keychain.set = async () => {};
    setPlatform(platform);

    await expect(cores().addPaired(entry("core-a"), "token-a")).rejects.toThrow(/keychain/i);
    // The core must NOT be recorded: a registry entry with no readable token is
    // exactly the dead-connection state this guards against.
    expect(files.cores).toBeUndefined();
  });

  it("removePaired drops the entry, its token, and re-points current", async () => {
    const { platform, files, tokens } = makeMockPlatform();
    setPlatform(platform);
    await cores().addPaired(entry("core-a"), "token-a");
    await cores().addPaired(entry("core-b"), "token-b");

    await cores().removePaired("core-b");
    expect(tokens["core-b"]).toBeUndefined();
    expect(files.cores).toEqual({
      cores: [entry("core-a")],
      currentCoreId: "core-a",
    });

    // Removing the last core leaves an empty registry with no current pointer.
    await cores().removePaired("core-a");
    expect(files.cores).toEqual({ cores: [] });
  });

  it("pruneUninstalledLocalCores drops local cores when no core is installed on disk", async () => {
    const { platform, files, tokens } = makeMockPlatform(false);
    setPlatform(platform);
    await cores().addPaired(entry("local-a"), "token-a");

    await pruneUninstalledLocalCores();
    // The local core's record and token are gone: a reinstall over it starts clean.
    expect(tokens["local-a"]).toBeUndefined();
    expect(files.cores).toEqual({ cores: [] });
  });

  it("pruneUninstalledLocalCores keeps local cores when a core is installed on disk", async () => {
    const { platform, files } = makeMockPlatform(true);
    setPlatform(platform);
    await cores().addPaired(entry("local-a"), "token-a");

    await pruneUninstalledLocalCores();
    expect(files.cores).toEqual({ cores: [entry("local-a")], currentCoreId: "local-a" });
  });

  it("pruneUninstalledLocalCores never touches remote cores", async () => {
    // No local core on disk, but the paired core is remote (LAN host), so it must
    // survive: only loopback cores depend on a local install.
    const { platform, files } = makeMockPlatform(false);
    setPlatform(platform);
    await cores().addPaired(remoteEntry("remote-a"), "token-a");

    await pruneUninstalledLocalCores();
    expect(files.cores).toEqual({
      cores: [remoteEntry("remote-a")],
      currentCoreId: "remote-a",
    });
  });

  it("pruneUninstalledLocalCores does not drop a remote core whose host contains 'localhost'", async () => {
    // Regression guard for the substring-vs-host bug: a remote core at
    // localhost.example.com is NOT local and must survive even with no local core.
    const { platform, files } = makeMockPlatform(false);
    setPlatform(platform);
    const trap = { ...remoteEntry("remote-a"), baseUrl: "https://localhost.example.com:7800" };
    await cores().addPaired(trap, "token-a");

    await pruneUninstalledLocalCores();
    expect(files.cores).toEqual({ cores: [trap], currentCoreId: "remote-a" });
  });

  it("pruneUninstalledLocalCores leaves cores paired when the install check throws", async () => {
    // Best-effort: an errored on-disk check must not unpair a possibly-valid core.
    const { platform, files } = makeMockPlatform("throw");
    setPlatform(platform);
    await cores().addPaired(entry("local-a"), "token-a");

    await pruneUninstalledLocalCores();
    expect(files.cores).toEqual({ cores: [entry("local-a")], currentCoreId: "local-a" });
  });

  it("rename updates the entry in place and keeps the current pointer", async () => {
    const { platform, files } = makeMockPlatform();
    setPlatform(platform);
    await cores().addPaired(entry("core-a"), "token-a");

    await cores().rename("core-a", "Desk Core");
    expect(files.cores).toEqual({
      cores: [entry("core-a", "Desk Core")],
      currentCoreId: "core-a",
    });
  });
});
