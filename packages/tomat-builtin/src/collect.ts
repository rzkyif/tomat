// Collect structured rows into the extension's private database: the model
// proposes a table (columns + rows pulled from the conversation), the user
// reviews and edits it in an askUser `table` question, and the accepted
// rows are stored via ctx.db. Doubles as the worked example for the table
// kind and the per-extension database.

import type { ToolContext } from "./types.ts";

export async function collectTable(
  args: { collection?: string; columns?: string[]; rows?: string[][] },
  ctx: ToolContext,
): Promise<{ collection: string; saved: number; rows: Array<Record<string, string>> }> {
  const collection = typeof args?.collection === "string" ? args.collection.trim() : "";
  if (!collection) throw new Error("collection is required");
  const columns = (Array.isArray(args?.columns) ? args.columns : [])
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim());
  if (columns.length === 0) {
    throw new Error("columns must name at least one column");
  }
  // Pad or trim each proposed row to the column count.
  const rows = (Array.isArray(args?.rows) ? args.rows : []).map((row) =>
    columns.map((_c, i) => (Array.isArray(row) && typeof row[i] === "string" ? row[i] : "")),
  );

  const [rawEdited] = await ctx.askUser([
    {
      kind: "table",
      question: `Check the rows to save into "${collection}". Edit anything that is off.`,
      columns,
      rows,
    },
  ]);
  const edited = (Array.isArray(rawEdited) ? rawEdited : []).filter(
    (r): r is Record<string, string> =>
      typeof r === "object" &&
      r !== null &&
      !Array.isArray(r) &&
      Object.values(r).every((v) => typeof v === "string"),
  );
  if (edited.length === 0) {
    return { collection, saved: 0, rows: [] };
  }

  ctx.setProgress(0.7, "Saving", `${edited.length} rows`);
  await ctx.db.execute(
    `CREATE TABLE IF NOT EXISTS collected_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      row_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
  );
  for (const row of edited) {
    await ctx.db.execute(
      "INSERT INTO collected_rows (collection, row_json, created_at_ms) VALUES (?, ?, ?)",
      [collection, JSON.stringify(row), Date.now()],
    );
  }
  ctx.setProgress(1, "Saved", `${edited.length} rows in "${collection}"`);
  return { collection, saved: edited.length, rows: edited };
}
