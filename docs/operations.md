# Operations

## Dry run

```sh
router usage refresh --dry-run
router usage refresh --source browser --dry-run
router run "<task>" --dry-run
```

`router usage refresh --dry-run` collects the selected source (default `local-session`) and
prints one line per account; it does not write SQLite. Omit `--dry-run` to persist.
`router run --dry-run` prints a redacted decision and does not create a Herdr pane.

## Coordinator

Local Worker tests cover create/renew/status/release. Do not `wrangler deploy` until the
Cloudflare account and environment are approved. Apply D1 migrations locally only:

```sh
npx wrangler d1 migrations apply model-router-leases --local
```

The Worker uses D1 for state; a missing binding returns `503`. Remote coordinator URLs
must use HTTPS. Plain HTTP is accepted only for loopback development hosts.

## Hermes hook

See `packages/hermes-heartbeat/README.md`. Do not modify an external Hermes checkout
until its path and ownership are confirmed.

## Dashboard fallback

Requires an explicitly attached authenticated browser session. Cookie databases are
never copied into router storage.

## Recovery

Launch tokens and pane IDs make retries skip a second `herdr pane split`. Blocked
agents are reported; the handoff is not blindly resent. Heartbeat TTLs expire remote
leases after a crash. Each provider operation owns a unique lease, renews it while the
operation runs, and releases only that lease. Local capacity reservations are acquired
atomically in SQLite so competing router processes cannot both consume the same reserve.

## TypeSafe

Live `TYPESAFE_API_KEY` calls are opt-in. Default tests use a fake client. A local
`router run --dry-run` without that key reports `typesafe-unavailable` rather than
inventing a semantic ranking. Task text containing a recognized credential is rejected
locally with a sanitized error before any TypeSafe request.
