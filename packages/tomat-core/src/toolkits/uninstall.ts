// Uninstall a toolkit: drop its DB rows (tools/grants/embeddings cascade) and
// remove its installed files. Shared by the toolkits route (DELETE /:id) and
// the Storage settings view (deleting a disabled toolkit). Idempotent on the
// filesystem side (a missing dir is fine).

import { toolkitsRegistry } from "./registry.ts";
import { workerPool } from "./worker-pool.ts";

export async function uninstallToolkit(id: string): Promise<void> {
  const toolkit = toolkitsRegistry().getOrThrow(id);
  // Refresh the worker's permission view so an in-flight worker drops this
  // toolkit's grants before its rows vanish.
  await workerPool().refreshPermissions(id);
  toolkitsRegistry().delete(id);
  try {
    await Deno.remove(toolkit.installedPath, { recursive: true });
  } catch {
    /* already gone */
  }
}
