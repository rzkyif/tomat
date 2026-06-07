// Client-side storage provider for the "Client → Storage" usage field. Mirrors
// the core StorageApi shape (get / deletePaths / clearCategory) so StorageField
// can drive either side. The tree comes from a Tauri command; deletes use
// platform.fs.remove; the settings "clear" is a reset that preserves the
// things the user shouldn't lose to a settings reset (paired cores + snippets).

import type { StorageTree } from "@tomat/shared";
import { platform } from "$lib/platform";
import { getLogger } from "$lib/shared/log";

const log = getLogger("client-storage");

// Keys in client settings.json that a "reset" must keep: paired cores (losing
// them forces a re-pair) and saved snippets.
const PRESERVE_KEYS = ["cores", "snippets"];

// The live log file: it's held open by the logger, so it's cleared by
// truncation (logging continues) rather than deletion. Rotated backups
// (client.log.N) are removed outright.
const ACTIVE_LOG = "client.log";

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

async function clearLogFile(path: string): Promise<void> {
  try {
    if (basename(path) === ACTIVE_LOG) {
      await platform().clientStorage.truncateActiveLog();
    } else {
      await platform().fs.remove(path);
    }
  } catch (e) {
    log.warn(`clear log failed: ${path}`, e);
  }
}

export const clientStorageProvider = {
  get(): Promise<StorageTree> {
    return platform().clientStorage.tree();
  },

  /** Clear the given log files: the active log is truncated, backups removed.
   *  The settings node is never selectable, so it doesn't reach here. */
  async deletePaths(paths: string[]): Promise<void> {
    for (const p of paths) await clearLogFile(p);
  },

  async clearCategory(id: string): Promise<void> {
    if (id === "settings") {
      // Reset to defaults, preserving paired cores + snippets.
      const cur = await platform().clientSettings.read();
      const preserved: Record<string, unknown> = {};
      for (const k of PRESERVE_KEYS) if (k in cur) preserved[k] = cur[k];
      await platform().clientSettings.write(preserved);
      return;
    }
    if (id === "logs") {
      const tree = await platform().clientStorage.tree();
      const cat = tree.categories.find((c) => c.id === "logs");
      if (!cat) return;
      for (const n of cat.nodes) await clearLogFile(n.path);
    }
  },
};
