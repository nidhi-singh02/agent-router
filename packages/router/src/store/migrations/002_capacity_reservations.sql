CREATE TABLE IF NOT EXISTS capacity_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ratio REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capacity_reservations_account_expiry
  ON capacity_reservations(account_id, expires_at);
