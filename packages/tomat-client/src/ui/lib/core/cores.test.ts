// CoresRegistry: cores.json CRUD against an in-memory platform mock (registry
// file + keychain). select()/connection behavior needs a live core and is
// exercised by the e2e flows, not here.

import { describe, expect, it } from "vitest";
import { type Platform, setPlatform } from "$lib/platform";
import { cores, type PairedCoreEntry } from "./cores";

function makeMockPlatform(): {
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
  } as unknown as Platform;
  return { platform, files, tokens };
}

const entry = (id: string, name = "Local Core"): PairedCoreEntry => ({
  id,
  name,
  baseUrl: "https://127.0.0.1:7800",
  tlsPin: "pin",
  addedAtMs: 1,
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
