// pure tree algorithms for the Storage settings field. Drives every
// non-trivial transformation (collectPaths / findNode / expandToFiles /
// visibleRows / computeLockReasons) against in-memory tree fixtures.

import { describe, expect, it } from "vitest";
import {
  collectModelFiles,
  collectPaths,
  computeLockReasons,
  expandToFiles,
  findNode,
  isSnippetPath,
  type StorageNode,
  type StorageTree,
  visibleRows,
} from "./storage-tree";

function file(name: string, path: string, size = 1): StorageNode {
  return { kind: "file", name, path, size };
}

function folder(name: string, path: string, children: StorageNode[], size = 0): StorageNode {
  return {
    kind: "folder",
    name,
    path,
    size: size || children.reduce((a, c) => a + c.size, 0),
    children,
  };
}

const TREE: StorageTree = {
  models: [
    folder("u", "/root/models/u", [
      folder("r", "/root/models/u/r", [
        file("m.gguf", "/root/models/u/r/m.gguf", 10),
        file("mm.gguf", "/root/models/u/r/mm.gguf", 5),
      ]),
    ]),
  ],
  sessions: [file("s1", "/root/sessions/s1", 2)],
  snippets: [file("snippet.md", "/root/snippets/snippet.md", 1)],
  total_size: 18,
  models_size: 15,
  sessions_size: 2,
  snippets_size: 1,
  settings_size: 0,
  root_path: "/root",
};

describe("collectPaths", () => {
  it("walks a folder and adds every descendant path + the folder itself", () => {
    const out = new Set<string>();
    collectPaths(TREE.models[0], out);
    expect([...out].sort()).toEqual([
      "/root/models/u",
      "/root/models/u/r",
      "/root/models/u/r/m.gguf",
      "/root/models/u/r/mm.gguf",
    ]);
  });
});

describe("findNode", () => {
  it("finds a top-level folder by path", () => {
    expect(findNode(TREE, "/root/models/u")?.name).toBe("u");
  });

  it("finds a session leaf", () => {
    expect(findNode(TREE, "/root/sessions/s1")?.kind).toBe("file");
  });

  it("returns null for unknown paths", () => {
    expect(findNode(TREE, "/no/such/path")).toBeNull();
  });
});

describe("expandToFiles", () => {
  it("a file path passes through", () => {
    expect(expandToFiles(TREE, ["/root/sessions/s1"])).toEqual(["/root/sessions/s1"]);
  });

  it("a folder path expands to its direct file children only", () => {
    // /root/models/u has a single folder child (r), not a file — so
    // expandToFiles emits no files for it (only DIRECT file children are
    // returned). This catches a regression where the function would recurse.
    expect(expandToFiles(TREE, ["/root/models/u"])).toEqual([]);
  });

  it("unknown paths are silently dropped", () => {
    expect(expandToFiles(TREE, ["/no/such"])).toEqual([]);
  });
});

describe("collectModelFiles", () => {
  it("returns direct file children of every top-level models folder", () => {
    // TREE.models is [u] (folder, no direct file children), so this is empty.
    expect(collectModelFiles(TREE)).toEqual([]);
  });
});

describe("isSnippetPath", () => {
  it("true when path matches a snippets top-level entry", () => {
    expect(isSnippetPath(TREE, "/root/snippets/snippet.md")).toBe(true);
  });
  it("false for non-snippet paths", () => {
    expect(isSnippetPath(TREE, "/root/sessions/s1")).toBe(false);
  });
});

describe("visibleRows", () => {
  it("renders nothing when no groups are expanded", () => {
    expect(visibleRows(TREE, new Set())).toEqual([]);
  });
  it("expanding __models__ surfaces top-level model entries", () => {
    const rows = visibleRows(TREE, new Set(["__models__"]));
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/root/models/u");
  });
  it("expanding a folder under an expanded group surfaces its children", () => {
    const rows = visibleRows(TREE, new Set(["__models__", "/root/models/u"]));
    // expanding the folder reveals direct children only (its single child is a folder).
    expect(rows.map((r) => r.path)).toEqual(["/root/models/u", "/root/models/u/r"]);
  });
});

describe("computeLockReasons", () => {
  it("locks the active LLM model file and its mmproj when supportImages is on", () => {
    const settings = {
      "llm.provider": "local",
      "llm.modelPath": "@u/r/main/m.gguf",
      "llm.supportImages": true,
      "llm.mmprojPath": "@u/r/main/mm.gguf",
    };
    const reasons = computeLockReasons(TREE, settings);
    expect(reasons.get("/root/models/u/r/m.gguf")).toContain("LLM");
    expect(reasons.get("/root/models/u/r/mm.gguf")).toContain("vision");
  });

  it("external provider does NOT lock the LLM model file", () => {
    const settings = {
      "llm.provider": "external",
      "llm.modelPath": "@u/r/main/m.gguf",
    };
    const reasons = computeLockReasons(TREE, settings);
    expect(reasons.has("/root/models/u/r/m.gguf")).toBe(false);
  });

  it("promotes a folder to locked when every leaf below it is locked", () => {
    const settings = {
      "llm.provider": "local",
      "llm.modelPath": "@u/r/main/m.gguf",
      "llm.supportImages": true,
      "llm.mmprojPath": "@u/r/main/mm.gguf",
    };
    const reasons = computeLockReasons(TREE, settings);
    // Both leaves under /root/models/u/r are locked, so the folder itself
    // gets a merged reason.
    expect(reasons.has("/root/models/u/r")).toBe(true);
  });
});
