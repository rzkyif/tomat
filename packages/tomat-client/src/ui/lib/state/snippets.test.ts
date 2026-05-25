// SnippetsState — load/save/delete against an in-memory platform mock.
// Verifies the round-trip through platform().clientSettings + the reactive
// `snippets` field.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPlatform, type Platform } from "$lib/platform";
import type { Snippet } from "$lib/shared/snippets";
import { snippetsState } from "./snippets.svelte";

function makeMockPlatform(): {
  platform: Platform;
  settingsFile: Record<string, unknown>;
} {
  const settingsFile: Record<string, unknown> = {};
  const platform = {
    clientSettings: {
      async read() {
        return JSON.parse(JSON.stringify(settingsFile));
      },
      async write(s: Record<string, unknown>) {
        for (const k of Object.keys(settingsFile)) delete settingsFile[k];
        Object.assign(settingsFile, s);
      },
    },
  } as unknown as Platform;
  return { platform, settingsFile };
}

const snippet = (id: string, trigger: string, text: string): Snippet => ({
  id,
  name: id,
  trigger,
  placement: "insert-user",
  text,
});

beforeEach(async () => {
  // Reset the singleton between tests.
  snippetsState.snippets = [];
});

describe("snippetsState", () => {
  it("load() reads from platform().clientSettings under key 'snippets'", async () => {
    const { platform, settingsFile } = makeMockPlatform();
    settingsFile.snippets = [snippet("a", "@hi", "hello")];
    setPlatform(platform);

    await snippetsState.load();
    expect(snippetsState.snippets).toEqual([snippet("a", "@hi", "hello")]);
  });

  it("load() coerces non-array values to []", async () => {
    const { platform, settingsFile } = makeMockPlatform();
    settingsFile.snippets = "not an array";
    setPlatform(platform);

    await snippetsState.load();
    expect(snippetsState.snippets).toEqual([]);
  });

  it("save() upserts (replaces by id) and persists", async () => {
    const { platform, settingsFile } = makeMockPlatform();
    settingsFile.snippets = [snippet("a", "@hi", "hello")];
    setPlatform(platform);
    await snippetsState.load();

    await snippetsState.save(snippet("a", "@hi", "edited"));
    expect(snippetsState.snippets).toEqual([snippet("a", "@hi", "edited")]);
    expect(settingsFile.snippets).toEqual([snippet("a", "@hi", "edited")]);

    await snippetsState.save(snippet("b", "@bye", "later"));
    expect(snippetsState.snippets.length).toBe(2);
  });

  it("delete() removes by id and persists the truncated array", async () => {
    const { platform, settingsFile } = makeMockPlatform();
    settingsFile.snippets = [snippet("a", "@hi", "hello"), snippet("b", "@bye", "later")];
    setPlatform(platform);
    await snippetsState.load();

    await snippetsState.delete("a");
    expect(snippetsState.snippets.map((s) => s.id)).toEqual(["b"]);
    expect((settingsFile.snippets as Snippet[]).map((s) => s.id)).toEqual(["b"]);
  });

  it("findByTrigger() is case-insensitive on @-trigger lookup", async () => {
    snippetsState.snippets = [snippet("a", "@HI", "hello")];
    expect(snippetsState.findByTrigger("@hi")?.id).toBe("a");
    expect(snippetsState.findByTrigger("@HI")?.id).toBe("a");
  });

  it("load() recovers gracefully when platform throws", async () => {
    setPlatform({
      clientSettings: {
        read() {
          return Promise.reject(new Error("disk full"));
        },
        write() {
          return Promise.resolve();
        },
      },
    } as unknown as Platform);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    snippetsState.snippets = [snippet("z", "@old", "stale")];
    await snippetsState.load();
    // On error the slice is left untouched (the warn-and-swallow path).
    expect(snippetsState.snippets.map((s) => s.id)).toEqual(["z"]);
    warn.mockRestore();
  });
});
