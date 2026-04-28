import type { ToolContext, ToolkitMetadata } from "../toolkits";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import mime from "mime-types";

export const METADATA: ToolkitMetadata = {
  name: "Download URL",
  description: "Download a file from a URL to the user's Downloads folder.",
  tools: [
    {
      name: "download_url",
      description:
        "Download the file at a URL into the user's Downloads folder, reporting progress.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http(s) URL of the file to download.",
          },
          filename: {
            type: "string",
            description:
              "Optional filename for the saved file. Defaults to the last segment of the URL.",
          },
        },
        required: ["url"],
      },
      triggers: [
        "download https://example.com/file.zip",
        "save that file to my downloads",
        "grab the pdf from this link",
        "fetch this archive for me",
      ],
      function: "download",
    },
  ],
};

export async function download(
  args: { url?: string; filename?: string },
  ctx: ToolContext,
): Promise<{ path: string; bytes: number }> {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs are allowed");

  ctx.setProgress(0, "Starting download", url);
  const res = await fetch(url, { signal: ctx.signal });
  if (!res.ok) throw new Error(`server returned ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  const downloadsDir = pickDownloadsDir();
  fs.mkdirSync(downloadsDir, { recursive: true });

  const baseName = deriveFilename(url, args?.filename);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const withExt = ensureExtension(baseName, contentType);
  const destPath = uniquePath(downloadsDir, withExt);

  ctx.log("info", `writing ${destPath}`);

  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const tmp = destPath + ".part";
  const file = Bun.file(tmp);
  const writer = file.writer();
  let written = 0;
  try {
    while (true) {
      if (ctx.signal.aborted) throw new Error("cancelled by user");
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
      written += value.byteLength;
      if (total > 0) {
        ctx.setProgress(
          written / total,
          "Downloading",
          `${(written / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
        );
      } else {
        ctx.setProgress(0, "Downloading", `${(written / 1024 / 1024).toFixed(1)} MB`);
      }
    }
    await writer.end();
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  ctx.setProgress(1, "Downloaded", path.basename(destPath));
  return { path: destPath, bytes: written };
}

function pickDownloadsDir(): string {
  // Cross-platform heuristic: honor XDG_DOWNLOAD_DIR when set, otherwise
  // fall back to ~/Downloads. Works for the three desktop platforms Tomat
  // supports.
  const xdg = process.env.XDG_DOWNLOAD_DIR;
  if (xdg && fs.existsSync(xdg)) return xdg;
  return path.join(os.homedir(), "Downloads");
}

function deriveFilename(url: string, override: string | undefined): string {
  if (override) return override;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    /* fall through */
  }
  return "download";
}

function ensureExtension(name: string, contentType: string): string {
  if (path.extname(name)) return name;
  if (!contentType) return name;
  const ext = mime.extension(contentType);
  return ext ? `${name}.${ext}` : name;
}

function uniquePath(dir: string, filename: string): string {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
}
