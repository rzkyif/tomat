// Toolkit removal + uninstall.
//
// `deleteToolkit` drops the DB rows (tools/grants/embeddings cascade) and removes
// the installed files entirely. Shared by the toolkits route (DELETE /:id) and
// the Storage settings view (deleting a toolkit).
//
// `uninstallToolkit` reverts an installed, deps-bearing toolkit back to
// 'downloaded' by removing the generated dependency artifacts (node_modules +
// deno.lock) and unpinning the hash, keeping the source files so it can be
// re-Installed. A no-dep toolkit has nothing to uninstall (it is delete-only).
//
// Both are idempotent on the filesystem side (a missing path is fine).

import { join } from "@std/path";
import { AppError } from "../shared/errors.ts";
import { toolkitsRegistry } from "./registry.ts";
import { workerPool } from "./worker-pool.ts";

export async function deleteToolkit(id: string): Promise<void> {
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

export async function uninstallToolkit(id: string): Promise<void> {
  const tk = toolkitsRegistry().getOrThrow(id);
  if (tk.status !== "installed" || !tk.hasDeps) {
    throw new AppError(
      "validation_error",
      `toolkit ${id} has nothing to uninstall (delete it instead)`,
    );
  }
  await workerPool().refreshPermissions(id);
  // Remove the generated dependency artifacts; the source files stay so the user
  // can re-Install. Both are hash-excluded, so a later re-Install re-pins the
  // same content hash.
  for (const rel of ["node_modules", "deno.lock"]) {
    try {
      await Deno.remove(join(tk.installedPath, rel), { recursive: true });
    } catch {
      /* not present */
    }
  }
  toolkitsRegistry().markDownloaded(id);
}
