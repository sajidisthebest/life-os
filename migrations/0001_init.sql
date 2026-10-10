-- Life OS D1 migration 0001: initial schema.
-- Mirrors server.py init_db(). Idempotent: IF NOT EXISTS everywhere, no
-- destructive statements. Seed rows use INSERT OR IGNORE.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, source, external_id)
);
CREATE INDEX IF NOT EXISTS ix_kind ON records(kind, updated_at);
CREATE INDEX IF NOT EXISTS ix_source ON records(source, kind);

CREATE TABLE IF NOT EXISTS sync_status (
  source TEXT PRIMARY KEY,
  updated_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_connected',
  error TEXT,
  freshness TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_queue (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  response TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  specification TEXT NOT NULL,
  affected_pages TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review_required'
);

CREATE TABLE IF NOT EXISTS login_failures (
  client_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_login_failures ON login_failures(client_key, attempted_at);

-- Seed one freshness row per known source (server.py init_db parity).
INSERT OR IGNORE INTO sync_status(source) VALUES ('ticktick');
INSERT OR IGNORE INTO sync_status(source) VALUES ('instantly');
INSERT OR IGNORE INTO sync_status(source) VALUES ('calendar');
INSERT OR IGNORE INTO sync_status(source) VALUES ('gmail');
INSERT OR IGNORE INTO sync_status(source) VALUES ('notion');
INSERT OR IGNORE INTO sync_status(source) VALUES ('other');
