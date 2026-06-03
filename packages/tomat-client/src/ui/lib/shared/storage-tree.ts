/**
 * Pure tree algorithms for the Storage settings field. The component owns
 * the reactive `tree` / `expanded` / `selected` state and the IPC calls;
 * everything that's a function of (tree, settings) lives here so it stays
 * easy to follow and unit-testable.
 */

import type { StorageNode, StorageTree } from "@tomat/shared";
import { EMBED_BASE_FILES, TTS_BASE_FILES } from "@tomat/shared";

// The tree shape now lives in @tomat/shared (it's a core/client wire type);
// re-export so existing importers of these from this module keep working.
export type { StorageFile, StorageFolder, StorageNode, StorageTree } from "@tomat/shared";

const ROOTS = ["models", "sessions", "snippets"] as const;

function* iterateRoots(tree: StorageTree): Generator<StorageNode> {
  for (const key of ROOTS) {
    for (const n of tree[key]) yield n;
  }
}

export function collectPaths(node: StorageNode, into: Set<string>): void {
  into.add(node.path);
  if (node.kind === "folder") {
    for (const c of node.children) collectPaths(c, into);
  }
}

export function findNode(tree: StorageTree, path: string): StorageNode | null {
  for (const n of iterateRoots(tree)) {
    if (n.path === path) return n;
    if (n.kind === "folder") {
      for (const c of n.children) if (c.path === path) return c;
    }
  }
  return null;
}

/** Expand any folder paths into their direct file children. Files are kept as-is. */
export function expandToFiles(tree: StorageTree, paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const n = findNode(tree, p);
    if (!n) continue;
    if (n.kind === "file") files.push(n.path);
    else for (const c of n.children) if (c.kind === "file") files.push(c.path);
  }
  return files;
}

export function collectModelFiles(tree: StorageTree): string[] {
  const out: string[] = [];
  for (const n of tree.models) {
    if (n.kind === "file") out.push(n.path);
    else for (const c of n.children) if (c.kind === "file") out.push(c.path);
  }
  return out;
}

export function isSnippetPath(tree: StorageTree, path: string): boolean {
  return tree.snippets.some((n) => n.path === path);
}

/** Flat list of currently-visible rows given the expanded set. Used for shift-range selection. */
export function visibleRows(tree: StorageTree, expanded: ReadonlySet<string>): StorageNode[] {
  const rows: StorageNode[] = [];
  const groups: { key: string; nodes: StorageNode[] }[] = [
    { key: "__models__", nodes: tree.models },
    { key: "__sessions__", nodes: tree.sessions },
    { key: "__snippets__", nodes: tree.snippets },
  ];
  for (const { key, nodes } of groups) {
    if (!expanded.has(key)) continue;
    for (const n of nodes) {
      rows.push(n);
      if (n.kind === "folder" && expanded.has(n.path)) {
        for (const c of n.children) rows.push(c);
      }
    }
  }
  return rows;
}

/** Convert a HuggingFace-style path (@user/repo/branch/file) to the on-disk path. */
function resolveHfToDisk(hfPath: unknown, rootPath: string): string | null {
  if (typeof hfPath !== "string" || !hfPath.startsWith("@")) return null;
  const parts = hfPath.slice(1).split("/");
  if (parts.length < 4) return null;
  const user = parts[0];
  const repo = parts[1];
  const rest = parts.slice(3).join("/");
  return `${rootPath}/models/${user}/${repo}/${rest}`;
}

/**
 * Build a path → reason map of every locked file plus every folder whose
 * entire subtree is locked. `.has(p)` answers "is this row locked?",
 * `.get(p)` gives the tooltip text.
 */
export function computeLockReasons(
  tree: StorageTree,
  settings: Record<string, unknown>,
): Map<string, string> {
  const reasons = new Map<string, string>();
  const protect = (hf: unknown, reason: string) => {
    const p = resolveHfToDisk(hf, tree.root_path);
    if (p) reasons.set(p, reason);
  };

  if (settings["llm.provider"] !== "external") {
    protect(settings["llm.modelPath"], "Used by LLM");
    if (settings["llm.supportImages"]) {
      protect(settings["llm.mmprojPath"], "Used by LLM vision");
    }
  }
  if (settings["stt.enabled"] && settings["stt.provider"] !== "external") {
    protect(settings["stt.modelPath"], "Used by Speech-to-Text");
  }
  // TTS has no "external" mode - whenever it's enabled, the Kokoro model
  // + tokenizer files are required.
  if (settings["tts.enabled"]) {
    for (const hf of TTS_BASE_FILES) protect(hf, "Used by Text-to-Speech");
  }
  // Toolkit tool-relevance filtering loads the embedding model at request
  // time, so deleting it would break the next tool-using turn.
  if (settings["tools.enabled"] && settings["tools.filteringEnabled"] !== false) {
    for (const hf of EMBED_BASE_FILES) protect(hf, "Used by tool filtering");
  }

  // Promote a folder to "locked" iff every leaf under it is locked. The
  // reason is the union of child reasons so the tooltip stays informative
  // even when a repo mixes (say) LLM + vision files.
  const visit = (node: StorageNode): string | null => {
    if (node.kind === "file") return reasons.get(node.path) ?? null;
    if (node.children.length === 0) return null;
    const childReasons = new Set<string>();
    for (const c of node.children) {
      const r = visit(c);
      if (r === null) return null;
      for (const part of r.split(", ")) childReasons.add(part);
    }
    if (childReasons.size === 0) return null;
    const merged = [...childReasons].join(", ");
    reasons.set(node.path, merged);
    return merged;
  };
  for (const n of iterateRoots(tree)) visit(n);

  return reasons;
}
