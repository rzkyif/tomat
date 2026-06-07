// Single SQLite connection for tomat-core.
// WAL is persisted in the db file; foreign_keys + busy_timeout are
// connection-level and set here so they hold for every connection.

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
  // foreign_keys defaults to OFF and is NOT persisted, so it must be set per
  // connection rather than relying on schema.sql having run: a connection opened
  // without migrate() would otherwise silently lose ON DELETE CASCADE. busy_timeout
  // makes momentary lock contention retry instead of throwing SQLITE_BUSY.
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      // Fold the WAL back into the main db file on clean shutdown so the -wal
      // doesn't grow across the process lifetime and the next open is clean.
      _db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best-effort: a checkpoint failure must not block shutdown */
    }
    _db.close();
    _db = null;
  }
}
