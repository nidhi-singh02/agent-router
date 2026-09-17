CREATE TABLE IF NOT EXISTS leases (
  account_fingerprint TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  model_family TEXT,
  reserved_capacity REAL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
