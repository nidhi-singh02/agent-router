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
`router run --worktree --dry-run` also previews the worktree path, branch, and starting commit.
It checks that the checkout is a clean Git repository but creates no branch, worktree, pane,
session, or reservation (capacity is checked read-only).

## Worktrees

`router run --worktree` creates worktrees under `<router home>/worktrees/` and never removes
them. List and clean them up with Git from the source checkout:

```sh
git worktree list
git worktree remove "<path>"   # refuses if the worktree has uncommitted changes
git worktree prune             # forget worktrees whose directory was deleted by hand
```

A continued isolated session (`router run --session <id>`) whose worktree was removed, moved,
switched to another branch, or re-pointed at another repository stops with an error instead of
launching elsewhere. That check runs again after routing, immediately before the pane opens.
Pull request size for a continued session is read from the worktree. Start a new `--worktree`
run when the recorded workspace is no longer usable.

If the source checkout changes while a new `--worktree` run is routing (new commit, or
uncommitted files), the router does not create the worktree. Commit or clean up, then retry.

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
