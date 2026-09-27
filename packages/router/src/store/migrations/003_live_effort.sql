CREATE TABLE IF NOT EXISTS effort_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'manual', 'phase-boundary')),
  from_effort TEXT NOT NULL,
  to_effort TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'no-change', 'failed')),
  reason TEXT NOT NULL,
  confidence REAL,
  signals_json TEXT,
  turn_break INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS effort_changes_session ON effort_changes (session_id, created_at);

-- `latestForPane`: the newest session recorded for a pane. The expressions must match the
-- query exactly for SQLite to use the index.
CREATE INDEX IF NOT EXISTS sessions_pane ON sessions (
  json_extract(payload, '$.paneId'),
  json_extract(payload, '$.createdAt')
);

-- Keyed by pane: every session continued in place shares its pane, and one pane must
-- never receive two keystroke sequences at once.
CREATE TABLE IF NOT EXISTS effort_locks (
  lock_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
