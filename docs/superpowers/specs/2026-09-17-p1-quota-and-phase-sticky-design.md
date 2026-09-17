# P1: Local Quota by Default + Phase-Sticky Resume

**Date:** 2026-09-17  
**Status:** Planning (awaiting implementation approval)  
**Product boundary:** Local `router` CLI only. No deploy, no Cloudflare, no Hermes checkout writes, no global skill install.

## Why these two

V1 shipped. Two product promises are currently false in a way users feel every run:

1. **Quota-aware routing.** `router run` skips _every_ collector unless `--usage`. Status-line caches are local JSON reads (milliseconds), but they are skipped with the slow CLI/browser collectors. Personal Cursor/Claude routes can therefore pick a pool at 0% (README already names Grok vs Auto as the example). Shared accounts stay excluded even when a fresh cache exists.
2. **Phase-sticky routing.** Design principle 4 and the decision card say a route stays stable within a phase. `shouldReconsiderRoute` exists and is unit-tested, but `executeRun` never calls it. `--session` only copies previous task text into the handoff; TypeSafe re-ranks from scratch. The card always prints `Cache decision: phase sticky unless eligibility changes`.

These are P1 because they are core routing behavior, already specified, and fixable without new infrastructure. They are not deferred v1 items (native Herdr plugin, prompt interception, identity-level activity).

## P1-A — Fast local quota on every run

### Behavior

| Invocation                                     | Collectors                                                                | Persist                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `router run` / `router status` (default)       | Only `local-session` collectors from the account's `collectorPreference`  | Save non-unknown snapshots to SQLite `usage_snapshots` |
| `router run --usage` / `router status --usage` | Full collector chain (official-cli/api, then local-session, then browser) | Same                                                   |
| `router usage refresh [--source …]`            | Selected source (default `local-session`)                                 | Save unless `--dry-run`                                |

`--usage` remains the opt-in for slow or quota-consuming official CLI/API and browser dashboard passes. Default is no longer "invent skipped/unknown for everyone."

If an account has no `local-session` collector, or the cache is missing/stale, the snapshot stays `certainty: unknown` with source `none` (not `skipped`). Personal accounts stay eligible; shared accounts stay excluded. That policy does not change.

### Codex local-session

Registry currently returns no `local-session` collector for Codex (`packages/router/test/collectors/registry.test.ts`). Add a reader matching Cursor/Claude:

- Path: `~/.codex/statusline-quota-cache.json`
- Schema: `{ "weekly_left": number, "at": number }` (`weekly_left` is percent remaining 0–100, `at` is Unix seconds)
- Max age: 15 minutes
- Window: `kind: "weekly"`, `certainty: "estimated"`, `source: "local-session"`

The router still does not write this file. Same contract as Cursor/Claude: the operator's status line (or a small script) writes it. Document the schema in README and `docs/provider-support.md`. OpenCode stays harness-only (quota belongs to the underlying provider).

### `router usage refresh`

Replace the stub in `packages/router/src/commands/usage.ts` that prints "live provider quota calls are not made from this command yet."

- `--dry-run` collects and prints a redacted one-line summary per account; does not write SQLite.
- Without `--dry-run`, collect and `UsageRepository.save`.
- `--source local-session` (default), `official-cli`, or `browser`. Browser still requires the existing approved bridge; dry-run browser with empty HTML stays unknown.
- Do not call provider endpoints that the live-collector tests mark as quota-consuming unless `--source official-cli` and not `--dry-run`. Default refresh is file reads.

### Runtime API

Replace `RuntimeOverrides.skipUsage?: boolean` with:

```ts
usageMode?: "local" | "full";
```

- CLI default: `usageMode: "local"`
- `--usage`: `usageMode: "full"`
- Tests that currently pass `skipUsage: true` become `usageMode` omitted with collectors that only expose official-cli, _or_ pass a filter; do not keep a silent skip-all path in production CLI.

`createDefaultRunDeps` filters collectors by kind before `collectUsageChain`. It does not skip `collectorsForAccount`.

## P1-B — Phase-sticky resume

### Behavior

On `router run --session <id>` (including `--dry-run`):

1. Load the previous session. Missing id stays exit 2 (`Session not found`).
2. Run eligibility as today.
3. Call TypeSafe **classification only** (family, phase, scores). TypeSafe still owns phase; do not infer phase from the task string in code.
4. If `previous.route` is present, map it to `opaqueId = `${accountId}:${modelId}``.
5. Call existing `shouldReconsiderRoute({ currentPhase: previous.phase, nextPhase: classifiedPhase, routeStillEligible })`.
   - `routeStillEligible` is true only when that opaque id is in the eligible set **and** `previous.effort` is in that model's `supportedEfforts`.
6. If it should **not** reconsider: skip route ranking and effort selection. Reuse account, model, and effort. Decision `reason` states reuse. Card: `Cache decision: reused previous route (same phase)`.
7. If it should reconsider: existing ranking + effort questions. Card:
   - phase differs: `phase change justifies a structured handoff`
   - previous ineligible: `previous route ineligible; re-ranked`
8. With no `--session`, card: `no previous session` (stop claiming sticky).
9. Persist `cacheAffinity` on the new session using `cacheAffinityKey` (field already on `RouterSessionSchema`, currently unused).

Sticky reuse still runs `revalidateDecision` before launch.

Same-phase resume where TypeSafe classifies a **new** phase (user said "implement" but classifier says "debugging") **must** re-rank. Code does not override TypeSafe phase.

### TypeSafe outage

Unchanged: classification failure is `typesafe-unavailable`, exit 2. Do not silently reuse the previous route without a phase judgment. Wiring `deterministicFallback` is **out of scope** (function exists, `executeRun` ignores it; separate change).

### Low-confidence `--choose`

Out of scope. Exit 3 stays print-two-options.

## Trust boundary

Unchanged. Quota arithmetic, reserve floor, eligibility, and sticky reuse are deterministic. TypeSafe still classifies phase and, when reconsidering, ranks only eligible opaque ids. No credentials, cookies, Telegram ids, or raw heartbeats in TypeSafe state.

## Success criteria

- Default `router run --dry-run` with a fresh Cursor or Claude status-line cache excludes a 0% pool without `--usage`.
- Default run does not invoke `agent status`, `claude` usage CLIs, `codex login status`, or browser fetch.
- `router usage refresh --dry-run` prints parsed local-session facts; without `--dry-run` a snapshot appears in SQLite.
- Codex accounts with `collectorPreference` including `local-session` and a valid cache file produce estimated weekly usage.
- `router run --session <same-phase task>` reuses the previous eligible route, does not call the TypeSafe route/effort questions, and the card tells the truth.
- Phase-boundary `--session` still re-ranks and still records `previousSessionId`.
- `npm run verify` passes. No deploy.

## NOT in scope

- Native Herdr plugin, prompt interception, automatic phase transitions without `--session`
- TypeSafe unavailable fallback, interactive `--choose`
- Coordinator/Hermes deploy or external checkout writes
- Cost estimator that varies by task length
- Filling handoff `relevantFiles` / acceptance-criteria from the repo
- Changing the 40% shared reserve
- Making TypeSafe optional for consequential tasks
