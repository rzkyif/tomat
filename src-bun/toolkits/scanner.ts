import * as fs from "node:fs";
import * as path from "node:path";
import { deriveStatus, type ToolkitsRegistry } from "./registry";
import type { ScanResult, ToolkitKind, ToolkitRow, UntrustedRow } from "./types";

/** Raw entry as seen on disk (pre-DB merge). */
interface DiscoveredEntry {
  id: string;
  kind: ToolkitKind;
  entryPath: string;
  entryMtimeMs: number | null;
}

/** Enumerate `~/.tomat/toolkits/` and return the raw on-disk state.
 *  - `.ts` files become `kind: "file"` entries with the file as entry path.
 *  - Subfolders containing `index.ts` become `kind: "folder"` entries.
 *  - `.d.ts` files and other reserved files are skipped.
 *  - Symlinks are rejected if their canonical path escapes the toolkits dir.
 */
export function discoverToolkitsOnDisk(toolkitsDir: string): DiscoveredEntry[] {
  const out: DiscoveredEntry[] = [];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(toolkitsDir);
  } catch {
    return out;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(toolkitsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    // Reserved files shipped alongside toolkits.
    if (
      ent.name === "toolkits.d.ts" ||
      ent.name === "registry.sqlite" ||
      ent.name.startsWith("registry.sqlite-")
    ) {
      continue;
    }
    if (ent.name.startsWith(".")) continue;

    const abs = path.join(toolkitsDir, ent.name);
    // Canonicalize to defeat symlink escapes.
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue;
    }
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      // real resolves outside the toolkits root; skip.
      continue;
    }

    let realStat: fs.Stats;
    try {
      realStat = fs.statSync(real);
    } catch {
      continue;
    }

    if (realStat.isFile()) {
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".d.ts")) continue;
      const id = ent.name.slice(0, -".ts".length);
      if (!id) continue;
      out.push({
        id,
        kind: "file",
        entryPath: abs,
        entryMtimeMs: realStat.mtimeMs,
      });
    } else if (realStat.isDirectory()) {
      const indexPath = path.join(abs, "index.ts");
      try {
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile()) continue;
        out.push({
          id: ent.name,
          kind: "folder",
          entryPath: indexPath,
          entryMtimeMs: indexStat.mtimeMs,
        });
      } catch {
        /* no index.ts - skip */
      }
    }
  }

  return out;
}

/** Reconcile the on-disk state with the DB. Inserts new entries, updates
 *  mutable fields on existing rows, and removes rows whose files have been
 *  deleted from disk (cascading tools + embeddings).
 *  Returns the trusted/untrusted split for API responses. */
export function scanToolkitsDir(registry: ToolkitsRegistry, toolkitsDir: string): ScanResult {
  const discovered = discoverToolkitsOnDisk(toolkitsDir);
  const discoveredIds = new Set(discovered.map((e) => e.id));

  // Drop DB rows for entries no longer on disk. CASCADE drops their tools
  // + embeddings.
  for (const rec of registry.listToolkits()) {
    if (!discoveredIds.has(rec.id)) {
      registry.deleteToolkit(rec.id);
    }
  }

  for (const entry of discovered) {
    registry.upsertDiscovered(entry);
  }

  const trusted: ToolkitRow[] = [];
  const untrusted: UntrustedRow[] = [];

  for (const rec of registry.listToolkits()) {
    if (rec.state !== "untrusted") {
      const tools = rec.state === "enabled" ? toolsFor(registry, rec.id) : [];
      trusted.push(registry.rowToPublic(rec, tools));
    } else {
      const { hasDeps } = deriveStatus(rec.entry_path, rec.kind);
      untrusted.push({
        id: rec.id,
        kind: rec.kind,
        entryPath: rec.entry_path,
        hasPackage: hasDeps,
      });
    }
  }

  trusted.sort((a, b) => a.id.localeCompare(b.id));
  untrusted.sort((a, b) => a.id.localeCompare(b.id));

  return { trusted, untrusted };
}

function toolsFor(
  registry: ToolkitsRegistry,
  toolkitId: string,
): ReturnType<typeof registry.listToolsByIds> {
  return registry.db
    .query("SELECT * FROM tools WHERE toolkit_id = ? ORDER BY name")
    .all(toolkitId) as ReturnType<typeof registry.listToolsByIds>;
}
