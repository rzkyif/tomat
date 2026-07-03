// Re-export shim: the single SQLite connection accessor now lives in
// @tomat/core-engine's platform layer, opened through host.openDb (the DenoHost
// wires the @db/sqlite adapter). Both the shell (auth, downloads, ...) and the
// engine's services share the one cached handle. Core keeps importing db() /
// openDb() / closeDb() from this path unchanged; this file forwards.

export { closeDb, db, openDb } from "@tomat/core-engine";
