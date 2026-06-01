// Open a URL in the user's default browser. Uses macOS's `open`, Linux's
// `xdg-open`, or Windows's `cmd /c start` depending on the host.

import type { ToolContext } from "./types.ts";

export async function open(args: { url?: string }, ctx: ToolContext): Promise<{ opened: string }> {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!url) throw new Error("url is required");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("only http(s) URLs are allowed");
  }
  ctx.setProgress(0.5, "Opening browser", url);

  const [bin, ...prefix] = pickOpenCmd();
  const proc = new Deno.Command(bin, {
    args: [...prefix, url],
    stdout: "null",
    stderr: "piped",
    signal: ctx.signal,
  }).spawn();
  const { code, stderr } = await proc.output();
  if (code !== 0) {
    const msg = new TextDecoder().decode(stderr).trim();
    throw new Error(`open command exited ${code}: ${msg || "no stderr"}`);
  }

  return { opened: url };
}

function pickOpenCmd(): string[] {
  switch (Deno.build.os) {
    case "darwin":
      return ["open"];
    case "windows":
      // `start` is a cmd builtin; the empty quoted arg is the window title
      // (otherwise cmd would treat the URL as the title).
      return ["cmd", "/c", "start", ""];
    default:
      return ["xdg-open"];
  }
}
