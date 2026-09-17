# Operations

## Dry run

```sh
router usage refresh --source browser --dry-run
router run "<task>" --dry-run
```

Dry run prints a redacted decision or parsed facts and does not create a Herdr pane.

## Coordinator

Local Worker tests cover create/renew/status/release. Do not `wrangler deploy` until the
Cloudflare account and environment are approved. Apply D1 migrations locally only:

```sh
npx wrangler d1 migrations apply model-router-leases --local
```

## Hermes hook

See `packages/hermes-heartbeat/README.md`. Do not modify an external Hermes checkout
until its path and ownership are confirmed.

## Dashboard fallback

Requires an explicitly attached authenticated browser session. Cookie databases are
never copied into router storage.

## Recovery

Launch tokens and pane IDs make retries skip a second `herdr pane split`. Blocked
agents are reported; the handoff is not blindly resent. Heartbeat TTLs expire remote
leases after a crash.

## TypeSafe

Live `TYPESAFE_API_KEY` calls are opt-in. Default tests use a fake client.
