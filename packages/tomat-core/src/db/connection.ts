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
  _db = new Database(paths().dbFile);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
