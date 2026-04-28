import * as path from "node:path";
import * as fs from "node:fs";

export interface InstallEvent {
  stream: "stdout" | "stderr";
  line: string;
}

export interface InstallOutcome {
  ok: boolean;
  code: number;
}

/** Run `bun install` in the toolkit folder, streaming per-line output via
 *  the `onLine` callback. Rejects if the spawn itself fails; resolves with
 *  `{ ok, code }` otherwise so the caller can distinguish "install failed"
 *  (non-zero exit) from "I couldn't even spawn bun". */
export async function runBunInstall(
  folder: string,
  opts: { ignoreScripts: boolean },
  onLine: (ev: InstallEvent) => void,
): Promise<InstallOutcome> {
  // Require package.json to exist - refuse to run `bun install` in an empty
  // folder which would create a phantom lockfile/node_modules out of nowhere.
  if (!fs.existsSync(path.join(folder, "package.json"))) {
    throw new Error("package.json not found in toolkit folder");
  }

  const args = ["install"];
  if (opts.ignoreScripts) args.push("--ignore-scripts");

  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: folder,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });

  const stdout = streamLines(proc.stdout, (line) => onLine({ stream: "stdout", line }));
  const stderr = streamLines(proc.stderr, (line) => onLine({ stream: "stderr", line }));

  const [code] = await Promise.all([proc.exited, stdout, stderr]);
  return { ok: code === 0, code };
}

async function streamLines(
  stream: ReadableStream<Uint8Array> | null,
  emit: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) emit(line);
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) emit(buf);
  } catch {
    // swallow - the caller already observes exit code
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
