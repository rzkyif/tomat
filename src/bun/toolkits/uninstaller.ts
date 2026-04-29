import * as fs from "node:fs";
import * as path from "node:path";

/** Delete `node_modules/` and `bun.lock` inside the toolkit folder. Safe to
 *  call when neither exists. Returns true iff the folder is confirmed under
 *  the `toolkitsRoot`. */
export function uninstallDeps(folder: string, toolkitsRoot: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(folder);
  } catch {
    return false;
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(toolkitsRoot);
  } catch {
    return false;
  }
  if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
    return false;
  }

  const nm = path.join(real, "node_modules");
  if (fs.existsSync(nm)) {
    fs.rmSync(nm, { recursive: true, force: true });
  }
  const lock = path.join(real, "bun.lock");
  if (fs.existsSync(lock)) {
    fs.rmSync(lock, { force: true });
  }
  // Also remove the older bun.lockb if present (Bun has shipped both names
  // historically - we clean whichever we find).
  const lockb = path.join(real, "bun.lockb");
  if (fs.existsSync(lockb)) {
    fs.rmSync(lockb, { force: true });
  }
  return true;
}
