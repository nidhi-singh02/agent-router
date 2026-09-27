# Privacy

- TypeSafe state must not include credentials, cookies, account labels, or raw heartbeats. Recognizable credentials are rejected locally before the first TypeSafe call; arbitrary sensitive narrative text still remains the caller's responsibility.
- Task enrichment sends a bucketed pull request size to TypeSafe: one of five size
  buckets, one of five file-count buckets, and a boolean — at most ~5.6 bits per run
  describing a repository's diff. No file path, branch name, pull request title, or
  repository name is sent. Disable it with `router run --no-enrich`, or by setting
  `enrichment.enabled` to `false` in config.
- `router effort --session` (live effort switching, off by default) sends TypeSafe the
  agent's one-line sub-step, the session phase, the current effort, and bucketed signals:
  step kind, consecutive failures (`0`, `1`, `2`, `3+`), files touched (`0`, `1-5`,
  `6-20`, `21+`), diff lines (`<50`, `50-300`, `300-1000`, `1000+`), and two booleans. It
  never sends the conversation. The sub-step text is not stored; the local `effort_changes`
  table keeps the source, from/to effort, outcome, confidence, and those bucketed signals.
  Pane text read to confirm a switch is parsed in memory and not stored.
- Coordinator rows store HMAC account fingerprints, opaque lease IDs, state, optional model family, optional reserved capacity, and timestamps.
- Owner UI may show `shared subscription currently active` only.
- Audit storage redacts `sk-` tokens and `Bearer` headers.
- Heartbeat payloads are `{ accountFingerprint, leaseId, modelFamily?, reservedCapacity?, ttlSeconds }`.
- Router state directories are restricted to the current user (`0700`); SQLite, WAL, and SHM files are `0600`.
- Launched Herdr commands receive an allowlisted environment rather than inheriting credential variables.
