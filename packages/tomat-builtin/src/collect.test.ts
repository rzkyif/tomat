// collect_table over a scripted askUser and a recording ctx.db: the user's
// edited rows are what gets persisted, and nothing is written when the
// table comes back empty.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { collectTable } from "./collect.ts";
import type { AskUserAnswer, AskUserQuestion, ToolContext } from "./types.ts";

interface RecordedCtx extends ToolContext {
  asked: AskUserQuestion[][];
  executed: Array<{ sql: string; params?: Array<string | number | boolean | null> }>;
}

function makeCtx(tableAnswer: AskUserAnswer): RecordedCtx {
  const ctx = {
    asked: [],
    executed: [],
    setProgress() {},
    askUser(questions: AskUserQuestion[]) {
      ctx.asked.push(questions);
      return Promise.resolve([tableAnswer]);
    },
    log() {},
    display: { markdown() {}, image() {}, table() {}, diff() {} },
    memories: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("not scripted")),
      write: () => Promise.reject(new Error("not scripted")),
      edit: () => Promise.reject(new Error("not scripted")),
    },
    db: {
      query: () => Promise.resolve([]),
      execute(sql: string, params?: Array<string | number | boolean | null>) {
        ctx.executed.push({ sql, params });
        return Promise.resolve({
          changes: 1,
          lastInsertRowId: ctx.executed.length,
        });
      },
    },
    llm: { complete: () => Promise.reject(new Error("not scripted")) },
    tts: { speak: () => Promise.reject(new Error("not scripted")) },
    stt: { transcribe: () => Promise.reject(new Error("not scripted")) },
    schedulePrompt: () => Promise.reject(new Error("not scripted")),
    signal: new AbortController().signal,
    getChatContext: () => ({ userMessage: "", sessionId: null }),
  } as RecordedCtx;
  return ctx;
}

Deno.test("collect_table: saves the user-edited rows via ctx.db", async () => {
  const edited = [
    { item: "coffee", amount: "4.50" },
    { item: "lunch", amount: "12.00" },
  ];
  const ctx = makeCtx(edited);

  const result = await collectTable(
    {
      collection: "expenses",
      columns: ["item", "amount"],
      rows: [["coffee", "4.50"]],
    },
    ctx,
  );

  assertEquals(result.collection, "expenses");
  assertEquals(result.saved, 2);
  assertEquals(result.rows, edited);

  // One CREATE TABLE, then one INSERT per edited row.
  assertStringIncludes(ctx.executed[0].sql, "CREATE TABLE IF NOT EXISTS collected_rows");
  assertEquals(ctx.executed.length, 3);
  assertEquals(ctx.executed[1].params?.[0], "expenses");
  assertEquals(ctx.executed[1].params?.[1], JSON.stringify(edited[0]));

  // The proposed rows reach the user padded to the column count.
  const q = ctx.asked[0][0];
  assertEquals(q.kind, "table");
  if (q.kind === "table") {
    assertEquals(q.rows, [["coffee", "4.50"]]);
  }
});

Deno.test("collect_table: pads and trims proposed rows to the columns", async () => {
  const ctx = makeCtx([]);
  await collectTable(
    {
      collection: "scores",
      columns: ["name", "score"],
      rows: [["amy"], ["bo", "7", "extra"]],
    },
    ctx,
  );
  const q = ctx.asked[0][0];
  assert(q.kind === "table");
  assertEquals(q.rows, [
    ["amy", ""],
    ["bo", "7"],
  ]);
});

Deno.test("collect_table: an emptied table saves nothing", async () => {
  const ctx = makeCtx([]);
  const result = await collectTable(
    { collection: "expenses", columns: ["item"], rows: [["coffee"]] },
    ctx,
  );
  assertEquals(result, { collection: "expenses", saved: 0, rows: [] });
  assertEquals(ctx.executed.length, 0);
});

Deno.test("collect_table: rejects missing collection or columns", async () => {
  await assertRejects(
    () => collectTable({ columns: ["a"] }, makeCtx([])),
    Error,
    "collection is required",
  );
  await assertRejects(
    () => collectTable({ collection: "x", columns: [] }, makeCtx([])),
    Error,
    "at least one column",
  );
});
