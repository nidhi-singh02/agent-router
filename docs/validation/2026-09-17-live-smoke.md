# Local validation 2026-09-17

## `npm run verify`

From `feat/model-router-v1` after Tasks 15-16:

- typecheck, lint, format, tests, build: pass
- Vitest: **29 files, 108 tests, 0 failures**

A follow-up default-deps freshness fix was then applied so unknown usage is not also marked stale (`expiresAt` is now one minute ahead of `collectedAt`). Re-run verify as part of landing this note.

## CLI dry runs (no live provider or TypeSafe calls)

`MODEL_ROUTER_HOME` pointed at a temp config with one personal Cursor account and `credentialRef: env:CURSOR_API_KEY` (no secret values present).

| Command                                                            | Result                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `router usage refresh --dry-run`                                   | `usage refresh is a local collector pass; live provider quota calls are not made from this command yet` |
| `router usage refresh --source browser --dry-run`                  | `browser cursor five-hour=unknown; certainty=unknown; fragile=true`                                     |
| `router run "Draft an architecture..." --dry-run`                  | exit 2: `TypeSafe could not select a route (typesafe-unavailable).`                                     |
| `router run "Implement the already approved plan..." --dry-run`    | same TypeSafe-unavailable outcome                                                                       |
| `router run "Brainstorm names and a visual identity..." --dry-run` | same TypeSafe-unavailable outcome                                                                       |

No Herdr pane was created. No provider quota command was executed. Browser dry-run used an empty page fragment, not a live dashboard.

## Remaining approval gates

Do not proceed without an explicit user yes:

1. Live TypeSafe call (`TYPESAFE_API_KEY`)
2. Live provider usage/status commands that may consume quota
3. Cloudflare Worker/D1 deploy
4. Write into an external Hermes checkout
5. Global skill install/link
6. `router run` without `--dry-run` inside Herdr (`HERDR_ENV=1`) that starts an agent

## P1 local quota + phase-sticky (2026-09-17, `feat/p1-quota-and-phase-sticky`)

`npm run verify` on this branch: typecheck, lint, format, **73 files / 360 tests**, build: pass.

Isolated `MODEL_ROUTER_HOME` (no TypeSafe key, no Herdr):

| Command                                                                                             | Result                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `router run "Implement the approved plan…" --dry-run` with `collectorPreference: ["local-session"]` | exit 2 `quota-exhausted` for `cursor:grok-4.6` from a fresh local Cursor cache (no `--usage`)    |
| same command with `collectorPreference: ["official-cli"]` only                                      | exit 2 `typesafe-unavailable`; no `phase sticky unless eligibility changes`                      |
| `router usage refresh --dry-run`                                                                    | one line: `acct_personal source=local-session certainty=estimated remaining=…` (did not persist) |

No Herdr pane. No official CLI/browser collectors. No deploy.
