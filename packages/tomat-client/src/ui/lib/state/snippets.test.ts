// SnippetsState: directory-backed snippets against an in-memory platform
// mock. One file per snippet (filename stem = id); the directory listing is
// the registry, so load() is also the "rescan" used to pick up files the
// user copied in by hand.

import { beforeEach, describe, expect, it } from "vitest";
import { setPlatform, type Platform } from "$lib/platform";
import type { Snippet } from "$lib/shared/snippets";
import { snippetsState } from "./snippets.svelte";

function makeMockPlatform(): {
  platform: Platform;
  files: Record<string, Record<string, unknown>>;
} {
  const files: Record<string, Record<string, unknown>> = {};
  const platform = {
    snippetFiles: {
      async readAll() {
        return JSON.parse(JSON.stringify(files));
      },
      async write(name: string, data: Record<string, unknown>) {
        files[name] = JSON.parse(JSON.stringify(data));
      },
      async delete(name: string) {
        delete files[name];
      },
    },
  } as unknown as Platform;
  return { platform, files };
}

const snippet = (id: string, trigger: string, text: string): Snippet => ({
  id,
  name: id,
  trigger,
  placement: "insert-user",
  text,
});

beforeEach(() => {
  // Reset the singleton between tests.
  snippetsState.snippets = [];
});

describe("snippetsState", () => {
  it("load() lists the snippets directory, keyed and ordered by filename stem", async () => {
    const { platform, files } = makeMockPlatform();
    files["b-snippet"] = { name: "B", trigger: "@b", placement: "insert-user", text: "bee" };
    files["a-snippet"] = { name: "A", trigger: "@a", placement: "insert-user", text: "ay" };
    setPlatform(platform);

    await snippetsState.load();
    expect(snippetsState.snippets.map((s) => s.id)).toEqual(["a-snippet", "b-snippet"]);
    expect(snippetsState.snippets[0].trigger).toBe("@a");
  });

  it("load() coerces shared files: the filename wins over a body id, bad fields default", async () => {
    const { platform, files } = makeMockPlatform();
    files["shared"] = { id: "other-id", trigger: "@s", placement: "bogus" };
    setPlatform(platform);

    await snippetsState.load();
    const s = snippetsState.snippets[0];
    expect(s.id).toBe("shared");
    expect(s.name).toBe("shared");
    expect(s.placement).toBe("append-system");
    expect(s.text).toBe("");
  });

  it("create() derives a slug filename from the name and uniquifies it", async () => {
    const { platform, files } = makeMockPlatform();
    setPlatform(platform);

    const a = await snippetsState.create({
      name: "New snippet",
      trigger: "@a",
      placement: "insert-user",
      text: "",
    });
    const b = await snippetsState.create({
      name: "New snippet",
      trigger: "@b",
      placement: "insert-user",
      text: "",
    });
    expect(a.id).toBe("new-snippet");
    expect(b.id).toBe("new-snippet-2");
    expect(Object.keys(files).sort()).toEqual(["new-snippet", "new-snippet-2"]);
    // The body never carries the id; the filename is the identity.
    expect("id" in files["new-snippet"]).toBe(false);
  });

  it("save() and delete() round-trip a snippet file", async () => {
    const { platform, files } = makeMockPlatform();
    setPlatform(platform);

    await snippetsState.save(snippet("greet", "@hi", "hello"));
    expect(files["greet"]).toEqual({
      name: "greet",
      trigger: "@hi",
      placement: "insert-user",
      text: "hello",
    });
    expect(snippetsState.findByTrigger("@HI")?.id).toBe("greet");

    await snippetsState.delete("greet");
    expect(files["greet"]).toBeUndefined();
    expect(snippetsState.snippets).toEqual([]);
  });
});
