import type { ToolContext, ToolkitMetadata } from "../toolkits";

export const METADATA: ToolkitMetadata = {
  name: "Open Website",
  description: "Open a URL in the user's default browser.",
  tools: [
    {
      name: "open_website",
      description:
        "Open a web URL in the user's default browser. Use when the user asks to visit, open, or go to a website.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http:// or https:// URL to open.",
          },
        },
        required: ["url"],
      },
      triggers: [
        "open https://news.ycombinator.com",
        "take me to the github page",
        "visit example.com",
        "go to the docs website",
      ],
      function: "open",
      alwaysAvailable: true,
    },
  ],
};

export async function open(args: { url?: string }, ctx: ToolContext): Promise<{ opened: string }> {
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  if (!url) throw new Error("url is required");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("only http(s) URLs are allowed");
  }
  ctx.setProgress(0.5, "Opening browser", url);

  const cmd = pickOpenCmd();
  const proc = Bun.spawn({
    cmd: [...cmd, url],
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await (async () => {
      if (!proc.stderr) return "";
      try {
        return await new Response(proc.stderr).text();
      } catch {
        return "";
      }
    })();
    throw new Error(`open command exited ${code}: ${stderr.trim() || "no stderr"}`);
  }

  return { opened: url };
}

function pickOpenCmd(): string[] {
  const platform = process.platform;
  if (platform === "darwin") return ["open"];
  if (platform === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
}
