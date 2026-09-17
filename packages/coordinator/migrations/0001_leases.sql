CREATE TABLE IF NOT EXISTS leases (
  account_fingerprint TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  state TEXT NOT NULL,
  model_family TEXT,
  reserved_capacity REAL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_fingerprint, lease_id)
);
CREATE INDEX IF NOT EXISTS leases_account_expiry ON leases(account_fingerprint, expires_at);
