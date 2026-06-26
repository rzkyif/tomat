// Minimal no-import, no-permission tool. The worker runs this directly with
// deno; nothing to install.
export function echoTool(args: { text?: string }): { echoed: string } {
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text) throw new Error("text is required");
  return { echoed: text };
}
