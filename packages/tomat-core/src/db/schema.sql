-- tomat-core SQLite schema. Idempotent: every CREATE uses IF NOT EXISTS, so
-- running this on boot is safe regardless of prior state.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Paired clients
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,           -- ULID
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,       -- sha256(bearer token)
  created_at_ms   INTEGER NOT NULL,
  last_seen_ms    INTEGER NOT NULL,
  revoked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clients_token ON clients(token_hash);

-- Short-lived pairing codes. The code is stored in the clear (not hashed): the
-- pairing PAKE keys off the code value itself, so core needs it for the ≤10-min
-- code lifetime. Only one row is ever unclaimed at a time (mintPairingCode wipes
-- prior unclaimed rows), so lookups select the single claimed=0 row.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL,              -- plaintext 6-digit pairing code
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed         INTEGER NOT NULL DEFAULT 0
);

-- Sessions are owned by a single client
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,           -- ULID (sortable by time)
  owner_client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT '',
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  token_usage     TEXT                        -- JSON {prompt,completion,total}
);
CREATE INDEX IF NOT EXISTS sessions_owner_updated
  ON sessions(owner_client_id, updated_at_ms DESC);

-- Messages: one row per bubble; full JSON content. Append-only typical, but
-- PATCH (edit) is supported and rewrites a single row.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,             -- client-supplied or core-generated
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,             -- monotonic within session
  role          TEXT NOT NULL,                -- user|assistant|system|tool|reasoning|tool_filter|error
  content_json  TEXT NOT NULL,                -- serialized Message minus id/role
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_ord ON messages(session_id, ord);

-- Session attachments stored on disk under sessions/<id>/attachments/.
-- One row per attachment for accounting + GC on session delete.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime          TEXT,
  size_bytes    INTEGER NOT NULL,
  abs_path      TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

-- Installed toolkits (one row per npm package or local folder)
CREATE TABLE IF NOT EXISTS toolkits (
  id              TEXT PRIMARY KEY,           -- flat folder name
  source          TEXT NOT NULL,              -- 'npm' | 'local'
  display_name    TEXT NOT NULL,
  description     TEXT,
  version         TEXT NOT NULL,
  installed_path  TEXT NOT NULL,
  tools_json_hash TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  installed_at_ms INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL
);

-- Tools (per toolkit)
CREATE TABLE IF NOT EXISTS tools (
  id                       TEXT PRIMARY KEY,          -- ${toolkit_id}::${name}
  toolkit_id               TEXT NOT NULL REFERENCES toolkits(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL,
  parameters_json          TEXT NOT NULL,
  triggers_json            TEXT NOT NULL,
  fn_export                TEXT NOT NULL,
  always_available         INTEGER NOT NULL DEFAULT 0,
  enabled                  INTEGER NOT NULL DEFAULT 0,
  required_permissions_json TEXT NOT NULL DEFAULT '[]',  -- flattened PermissionDecl[]
  UNIQUE(toolkit_id, name)
);

-- Per-tool embedding (for phase-1 relevance)
CREATE TABLE IF NOT EXISTS tool_embeddings (
  tool_id     TEXT PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  source_hash TEXT NOT NULL
);

-- Per-tool granular permission grants. A tool is runnable iff every
-- non-optional permission its tools.json declares has a row here with
-- state='granted'. The worker flag set is the union of grants across the
-- toolkit's currently-enabled tools.
CREATE TABLE IF NOT EXISTS grants (
  tool_id         TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  permission_key  TEXT NOT NULL,              -- e.g. 'net:api.example.com:443'
  permission_kind TEXT NOT NULL,              -- 'net'|'read'|'write'|'run'|'env'|'ffi'|'sys'
  state           TEXT NOT NULL DEFAULT 'granted',  -- granted|denied
  granted_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (tool_id, permission_key)
);

-- Downloads (ported from the existing Rust download manager)
CREATE TABLE IF NOT EXISTS downloads (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  destination      TEXT NOT NULL,             -- 'models'|'binaries'|'toolkits'
  rel_path         TEXT NOT NULL,
  abs_path         TEXT NOT NULL,
  filename         TEXT NOT NULL,
  group_id         TEXT NOT NULL,
  size_bytes       INTEGER,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,             -- Pending|Downloading|Completed|Error|Cancelled
  error            TEXT,
  added_at_ms      INTEGER NOT NULL
);
