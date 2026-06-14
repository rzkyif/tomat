// Document tools over the host's `ctx.documents` module: write (create or
// replace), edit (exact find/replace), read, and show (render the content
// as a markdown bubble). Write/edit return a `document_diff` result and
// read a `document_content` result; the client renders those kinds
// specially (diff view / markdown).

import type { ToolContext } from "./types.ts";

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

export async function writeDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{
  kind: "document_diff";
  title: string;
  before: string;
  after: string;
  created: boolean;
}> {
  const title = stringArg(args, "title");
  const content = stringArg(args, "content", true);
  const result = await ctx.documents.write(title, content);
  ctx.setProgress(1, result.created ? "Document created" : "Document replaced", result.title);
  return { kind: "document_diff", ...result };
}

export async function editDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ kind: "document_diff"; title: string; before: string; after: string }> {
  const title = stringArg(args, "title");
  const find = stringArg(args, "find");
  const replace = stringArg(args, "replace", true);
  const result = await ctx.documents.edit(title, find, replace);
  ctx.setProgress(1, "Document edited", result.title);
  return { kind: "document_diff", ...result };
}

export async function readDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ kind: "document_content"; title: string; content: string }> {
  const title = stringArg(args, "title");
  const doc = await ctx.documents.get(title);
  return { kind: "document_content", ...doc };
}

export async function showDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ title: string; shown: boolean }> {
  const title = stringArg(args, "title");
  const doc = await ctx.documents.get(title);
  ctx.display.markdown(doc.content);
  return { title: doc.title, shown: true };
}
