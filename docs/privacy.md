# Privacy

- TypeSafe state must not include credentials, cookies, account labels, Telegram data, or raw heartbeats.
- Coordinator rows store HMAC account fingerprints, state, optional model family, optional reserved capacity, and timestamps.
- Owner UI may show `shared subscription currently active` only.
- Audit storage redacts `sk-` tokens and `Bearer` headers.
- Heartbeat payloads are `{ accountFingerprint, modelFamily?, reservedCapacity?, ttlSeconds }`.
