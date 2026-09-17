# Privacy

- TypeSafe state must not include credentials, cookies, account labels, Telegram data, or raw heartbeats. Recognizable credentials are rejected locally before the first TypeSafe call; arbitrary sensitive narrative text still remains the caller's responsibility.
- Coordinator rows store HMAC account fingerprints, opaque lease IDs, state, optional model family, optional reserved capacity, and timestamps.
- Owner UI may show `shared subscription currently active` only.
- Audit storage redacts `sk-` tokens and `Bearer` headers.
- Heartbeat payloads are `{ accountFingerprint, leaseId, modelFamily?, reservedCapacity?, ttlSeconds }`.
- Router state directories are restricted to the current user (`0700`); SQLite, WAL, and SHM files are `0600`.
- Launched Herdr commands receive an allowlisted environment rather than inheriting credential variables.
