// DenoHost filesystem: the engine's async HostFs implemented over Deno FS +
// @std/fs. Atomic writers do tmp-file + rename; `restrictPermissions` sets 0600
// at creation (Unix) so a secret file is never briefly world-readable. `stat`
// maps a missing path to null so callers branch without catching a Deno-specific
// error type.

import type { HostFs, WriteOpts } from "@tomat/core-engine";
import { errMessage } from "@tomat/shared";

function tmpPath(path: string): string {
  return `${path}.tmp`;
}

async function tightenMode(path: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    /* best-effort: a chmod failure must not fail the write */
  }
}

async function writeBytesAtomic(path: string, bytes: Uint8Array, opts?: WriteOpts): Promise<void> {
  const tmp = tmpPath(path);
  const mode = opts?.restrictPermissions ? { mode: 0o600 } : undefined;
  // mode at creation closes the world-readable window before the chmod fallback.
  await Deno.writeFile(tmp, bytes, mode);
  if (opts?.restrictPermissions) await tightenMode(tmp);
  await Deno.rename(tmp, path);
}

export const denoFs: HostFs = {
  readTextFile(path: string): Promise<string> {
    return Deno.readTextFile(path);
  },

  async writeTextFileAtomic(path: string, text: string, opts?: WriteOpts): Promise<void> {
    await writeBytesAtomic(path, new TextEncoder().encode(text), opts);
  },

  readFile(path: string): Promise<Uint8Array> {
    return Deno.readFile(path);
  },

  writeFileAtomic(path: string, bytes: Uint8Array, opts?: WriteOpts): Promise<void> {
    return writeBytesAtomic(path, bytes, opts);
  },

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    try {
      const st = await Deno.stat(path);
      return { size: st.size, isDir: st.isDirectory };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw new Error(`stat ${path} failed: ${errMessage(err)}`);
    }
  },

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await Deno.mkdir(path, { recursive: opts?.recursive ?? false });
  },

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    try {
      await Deno.remove(path, { recursive: opts?.recursive ?? false });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return; // idempotent delete
      throw err;
    }
  },

  rename(from: string, to: string): Promise<void> {
    return Deno.rename(from, to);
  },

  async readDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const out: Array<{ name: string; isDir: boolean }> = [];
    for await (const entry of Deno.readDir(path)) {
      out.push({ name: entry.name, isDir: entry.isDirectory });
    }
    return out;
  },
};
