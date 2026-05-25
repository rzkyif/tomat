// Single SQLite connection for tomat-core.
// WAL mode + foreign keys enforced by schema.sql at boot.

import { Database } from "@db/sqlite";
import { paths } from "../paths.ts";

let _db: Database | null = null;

export function db(): Database {
  if (_db === null) {
    throw new Error("db() called before openDb()");
  }
  return _db;
}

export function openDb(): Database {
  if (_db !== null) return _db;
  // int64: true is required for INTEGER columns to round-trip values past
  // 2^31 (e.g. Date.now() ms timestamps). Without it, expires_at_ms etc.
  // come back truncated. Library returns plain `number` for values within
  // Number.MAX_SAFE_INTEGER, bigint above that.
  _db = new Database(paths().dbFile, { int64: true });
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
