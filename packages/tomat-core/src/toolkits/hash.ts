// Toolkit content hash, used as the trust anchor against tampering.
//
// Algorithm (deterministic across platforms):
//   1. Walk the folder; for each regular file, decide whether to include it.
//   2. Always exclude `node_modules/...`.
//   3. If `<root>/.gitignore` exists, exclude any path it matches (but
//      the .gitignore file itself is INCLUDED so changes to ignore rules
//      drift the hash too).
//   4. Sort included paths lexicographically (forward-slash form).
//   5. Hash the concatenation of `path\0sizeBytes\0content` for each file
//      into a single SHA-256 digest, hex-encoded lowercase.
//
// Uses npm:ignore for gitignore parsing (battle-tested by ESLint/Prettier).

import { join, relative } from "@std/path";
import ignore from "ignore";

const NODE_MODULES = "node_modules";

export async function hashToolkit(rootDir: string): Promise<string> {
  const ig = await loadGitignore(rootDir);
  const files: string[] = [];
  await walk(rootDir, rootDir, files, ig);
  files.sort();

  const digestStream = new DigestStream("SHA-256");
  for (const rel of files) {
    const abs = join(rootDir, rel);
    let size: number;
    try {
      size = (await Deno.stat(abs)).size;
    } catch {
      // File vanished mid-walk; skip it (next call will get a different hash).
      continue;
    }
    digestStream.update(new TextEncoder().encode(rel + "\0" + size + "\0"));
    const file = await Deno.open(abs, { read: true });
    try {
      for await (const chunk of file.readable) {
        digestStream.update(chunk);
      }
    } finally {
      try {
        file.close();
      } catch { /* already closed via readable */ }
    }
    digestStream.update(new Uint8Array([0]));
  }
  return await digestStream.hexDigest();
}

async function loadGitignore(rootDir: string): Promise<ignore.Ignore> {
  const ig = ignore();
  try {
    const text = await Deno.readTextFile(join(rootDir, ".gitignore"));
    ig.add(text);
  } catch { /* no .gitignore */ }
  return ig;
}

async function walk(
  root: string,
  dir: string,
  out: string[],
  ig: ignore.Ignore,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).replaceAll("\\", "/");
    if (entry.isDirectory) {
      if (entry.name === NODE_MODULES) continue;
      if (rel && ig.ignores(rel + "/")) continue;
      await walk(root, full, out, ig);
    } else if (entry.isFile) {
      if (rel && ig.ignores(rel)) continue;
      out.push(rel);
    }
    // symlinks and other entries intentionally skipped to keep hashing deterministic
  }
}

// Streaming hasher backed by Web Crypto. SubtleCrypto.digest is one-shot;
// we accumulate chunks and hash on finalize. For toolkit-sized folders
// (~tens of MB) this is fine in memory.
class DigestStream {
  private chunks: Uint8Array[] = [];
  constructor(private readonly algo: "SHA-256") {}
  update(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  async hexDigest(): Promise<string> {
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    const buf = await crypto.subtle.digest(this.algo, merged);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
