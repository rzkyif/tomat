// Runs schema.sql against the open DB. Idempotent — every statement is
// CREATE TABLE / CREATE INDEX … IF NOT EXISTS, plus PRAGMAs.
//
// Future schema changes will need a versioned migrations table; for v1 the
// shape is frozen and we just (re-)apply schema.sql at boot.

import { db } from "./connection.ts";

// schema.sql is loaded as a string at build time. Inlined via raw import to
// avoid runtime path resolution after `deno compile`.
import schemaSqlContent from "./schema.sql" with { type: "text" };

export function migrate(): void {
  db().exec(schemaSqlContent);
}
