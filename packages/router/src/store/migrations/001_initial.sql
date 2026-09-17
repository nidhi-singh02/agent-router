CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  agent TEXT NOT NULL,
  ownership TEXT NOT NULL,
  reserve_floor REAL NOT NULL,
  collector_preference TEXT NOT NULL,
  enabled_models TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  credential_ref TEXT
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  account_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (account_id, collected_at)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
