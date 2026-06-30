// Tidy the user's Downloads folder: list its loose files, let the user pick
// which to organize (a `files` multiselect question), propose moves into
// per-category subfolders as a `diff` question, and apply the plan only on
// accept. Doubles as the worked example for the file-picker and diff
// askUser kinds.

import * as path from "node:path";
import * as fs from "node:fs";
import type { ToolContext } from "./types.ts";
import { pickDownloadsDir, uniquePath } from "./download.ts";

const CATEGORIES: Array<{ name: string; exts: string[] }> = [
  {
    name: "Images",
    exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "bmp", "tiff"],
  },
  {
    name: "Documents",
    exts: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "csv", "epub"],
  },
  {
    name: "Archives",
    exts: ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "iso"],
  },
  { name: "Audio", exts: ["mp3", "wav", "flac", "m4a", "ogg", "aac"] },
  { name: "Video", exts: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] },
  {
    name: "Installers",
    exts: ["dmg", "pkg", "msi", "exe", "deb", "rpm", "appimage"],
  },
];

export async function organizeDownloads(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ applied: boolean; moved: Array<{ from: string; to: string }> }> {
  const dir = pickDownloadsDir();
  ctx.setProgress(0.1, "Listing Downloads", dir);

  const files = listLooseFiles(dir);
  if (files.length === 0) {
    throw new Error("no loose files found in the Downloads folder");
  }

  const [rawPicked] = await ctx.askUser([
    {
      kind: "files",
      question: "Which files should I organize?",
      entries: files.map((f) => ({
        path: f.path,
        label: f.name,
        description: humanSize(f.bytes),
      })),
      multiselect: true,
    },
  ]);
  const picked = (Array.isArray(rawPicked) ? rawPicked : []).filter(
    (p): p is string => typeof p === "string",
  );
  const chosen = files.filter((f) => picked.includes(f.path));
  if (chosen.length === 0) {
    return { applied: false, moved: [] };
  }

  // Plan: each chosen file moves into its category subfolder. Shown as a
  // before/after layout diff the user accepts or rejects as a whole.
  const plan = chosen.map((f) => ({ ...f, category: categoryOf(f.name) }));
  const before = plan
    .map((p) => p.name)
    .sort()
    .join("\n");
  const after = plan
    .map((p) => `${p.category}/${p.name}`)
    .sort()
    .join("\n");
  const [verdict] = await ctx.askUser([
    {
      kind: "diff",
      question: "Move these files into category folders?",
      title: "Planned layout",
      before,
      after,
    },
  ]);
  if (verdict !== "accept") {
    return { applied: false, moved: [] };
  }

  const moved: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    ctx.setProgress(0.5 + (0.5 * i) / plan.length, "Moving", p.name);
    if (!fs.existsSync(p.path)) {
      ctx.log("warn", `skipping ${p.name}: no longer exists`);
      continue;
    }
    const targetDir = path.join(dir, p.category);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = uniquePath(targetDir, p.name);
    fs.renameSync(p.path, target);
    moved.push({ from: p.path, to: target });
  }
  ctx.setProgress(1, "Organized", `${moved.length} files moved`);
  return { applied: true, moved };
}

function listLooseFiles(dir: string): Array<{ path: string; name: string; bytes: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    throw new Error(`Downloads folder not readable: ${dir}`);
  }
  const out: Array<{ path: string; name: string; bytes: number }> = [];
  for (const name of names) {
    // Skip dotfiles and in-flight downloads.
    if (name.startsWith(".") || name.endsWith(".part") || name.endsWith(".crdownload")) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ path: full, name, bytes: stat.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function categoryOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const c of CATEGORIES) {
    if (c.exts.includes(ext)) return c.name;
  }
  return "Other";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
