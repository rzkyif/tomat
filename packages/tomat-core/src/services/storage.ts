// Storage view for the Settings "Storage" field: enumerates downloaded model
// files (the disk-space-significant content) and deletes selected ones. Ports
// the old Tauri storage.rs models-tree builder to the core. Sessions live in
// SQLite (managed from the session bar); snippets are client-local (stored in
// ~/.tomat/client/settings.json, managed in the Snippets settings field) and so
// aren't part of the core's disk view. Only core-owned model files are
// enumerated here.

import { basename, dirname, isAbsolute, join, normalize, relative } from "@std/path";
import type { StorageNode, StorageTree } from "@tomat/shared";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { notifyRequirementsChanged } from "./requirements.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("storage");

// Extensions that count as model / support files in the storage view: gguf
// (llama.cpp), bin (whisper.cpp + some ORT tensors), onnx + json (Kokoro /
// transformers.js), pt (PyTorch voice tensors). Matches the old storage.rs set.
const MODEL_FILE_EXTS = new Set(["gguf", "bin", "onnx", "json", "pt"]);

async function collectModelFiles(base: string, dir: string, out: StorageNode[]): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return;
  }
  for await (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory) {
      await collectModelFiles(base, p, out);
    } else if (e.isFile) {
      const ext = (e.name.includes(".") ? e.name.split(".").pop()! : "").toLowerCase();
      if (!MODEL_FILE_EXTS.has(ext)) continue;
      let size = 0;
      try {
        size = (await Deno.stat(p)).size;
      } catch {
        continue;
      }
      out.push({ kind: "file", name: relative(base, p).replaceAll("\\", "/"), path: p, size });
    }
  }
}

async function buildModelsTree(modelsDir: string): Promise<StorageNode[]> {
  const out: StorageNode[] = [];
  let users: AsyncIterable<Deno.DirEntry>;
  try {
    users = Deno.readDir(modelsDir);
  } catch {
    return out;
  }
  for await (const user of users) {
    if (!user.isDirectory) continue;
    const userPath = join(modelsDir, user.name);
    let repos: AsyncIterable<Deno.DirEntry>;
    try {
      repos = Deno.readDir(userPath);
    } catch {
      continue;
    }
    for await (const repo of repos) {
      if (!repo.isDirectory) continue;
      const repoPath = join(userPath, repo.name);
      const display = `${user.name}/${repo.name}`;
      const files: StorageNode[] = [];
      await collectModelFiles(repoPath, repoPath, files);
      files.sort((a, b) => a.name.localeCompare(b.name));
      if (files.length === 0) continue;
      const hasMmproj = files.some((f) => basename(f.name).toLowerCase().startsWith("mmproj"));
      if (hasMmproj || files.length > 1) {
        const size = files.reduce((s, f) => s + f.size, 0);
        out.push({ kind: "folder", name: display, path: repoPath, size, children: files });
      } else {
        // Single-file repo: render inline "user/repo/filename" so the list
        // stays dense when only one file matters (e.g. whisper).
        const f = files[0];
        out.push({ kind: "file", name: `${display}/${f.name}`, path: f.path, size: f.size });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function buildStorageTree(): Promise<StorageTree> {
  const p = paths();
  const models = await buildModelsTree(p.modelsDir);
  const models_size = models.reduce((s, n) => s + n.size, 0);
  let settings_size = 0;
  try {
    settings_size = (await Deno.stat(p.settingsFile)).size;
  } catch {
    /* no settings.json yet */
  }
  return {
    models,
    sessions: [],
    snippets: [],
    models_size,
    sessions_size: 0,
    snippets_size: 0,
    settings_size,
    total_size: models_size + settings_size,
    // `<root_path>/models` must equal the models dir so the UI can map an HF
    // spec to its on-disk path for in-use locking.
    root_path: dirname(p.modelsDir),
  };
}

/** Delete the given absolute paths. Each must resolve under the models dir (the
 *  only deletable storage here); anything else is rejected. Recomputes
 *  requirements afterward so a now-missing model re-surfaces as required. */
export async function deleteStoragePaths(targets: string[]): Promise<void> {
  const modelsDir = paths().modelsDir;
  for (const t of targets) {
    const safe = assertUnderModels(t, modelsDir);
    try {
      await Deno.remove(safe, { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        log.warn(`delete ${safe} failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }
    }
  }
  void notifyRequirementsChanged();
}

/** Remove every downloaded model (the contents of the models dir). */
export async function clearModels(): Promise<void> {
  const modelsDir = paths().modelsDir;
  try {
    await Deno.remove(modelsDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.mkdir(modelsDir, { recursive: true });
  void notifyRequirementsChanged();
}

// Reject any path that doesn't sit strictly inside the models dir (no escaping
// via `..`, no absolute re-roots, not the dir itself).
function assertUnderModels(target: string, modelsDir: string): string {
  const norm = normalize(target);
  const rel = relative(normalize(modelsDir), norm);
  if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AppError("validation_error", `path is not under the models dir: ${target}`);
  }
  return norm;
}
