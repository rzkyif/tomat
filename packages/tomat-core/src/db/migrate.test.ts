// migrate() must be idempotent. Every CREATE in schema.sql uses
// IF NOT EXISTS. Running it twice against the same DB must not throw and
// must not change the schema.

import { assertEquals } from "@std/assert";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { db } from "./connection.ts";
import { migrate } from "./migrate.ts";

function tableNames(): string[] {
  return (
    db().prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

Deno.test("migrate: running twice is idempotent (no throw, schema unchanged)", async () => {
  const env = await setupTestEnv();
  try {
    const before = tableNames();
    migrate();
    const after = tableNames();
    assertEquals(before, after);
    // Spot-check that the canonical tables exist after migration.
    assertEquals(before.includes("sessions"), true);
    assertEquals(before.includes("messages"), true);
    assertEquals(before.includes("clients"), true);
    assertEquals(before.includes("pairing_codes"), true);
  } finally {
    await env.teardown();
  }
});
