# Review: P1 local quota + phase-sticky (feat/p1-quota-and-phase-sticky)

**Date:** 2026-09-17
**Reviewed against:** `docs/superpowers/specs/2026-09-17-p1-quota-and-phase-sticky-design.md` and `docs/superpowers/handoffs/2026-09-17-p1-quota-and-phase-sticky-implementation.md`
**Verdict:** Matches spec. No blocking issues. `npm run verify` reconfirmed clean (73 files / 360 tests, lint, format, build).

## What I checked

- P1-A: `usageMode` replaces `skipUsage` end to end (`RuntimeOverrides`, `createDefaultRunDeps`, `cli.ts` `run`/`status`). Default filters collectors to `kind === "local-session"`; `--usage` runs the full chain. Non-unknown snapshots save to SQLite via one shared `openDatabase` call (also now backs `SessionRepository`, so no duplicate DB handle).
- Codex local-session collector (`codex-statusline-collector.ts`): reads `~/.codex/statusline-quota-cache.json`, `{ weekly_left, at }`, 15-min max age, `kind: "weekly"`, `certainty: "estimated"`. Matches spec exactly; registered in `collectorsForAccount` for `agent === "codex"`.
- `router usage refresh`: rewritten from a stub to real collect+persist, `--source local-session|official-cli|browser` (default local-session), `--dry-run` skips persistence. CLI wiring filters collectors by kind and opens/closes its own DB handle.
- P1-B: `decideRoute` takes `previousRoute`, computes `routeStillEligible` (candidate present in eligible set **and** previous effort in `supportedEfforts`), calls existing `shouldReconsiderRoute`, and short-circuits to `sticky: true` reuse before ranking when it should not reconsider. Classification-failure path (`typesafe-unavailable`) is checked before the sticky branch, so a TypeSafe outage still can't silently reuse a route.
- `executeRun` builds `previousRoute` from the loaded session, sets `cacheAffinity` via `cacheAffinityKey` (unused schema field is now populated), and the three honest card strings (`reused previous route (same phase)`, `phase change justifies a structured handoff`, `previous route ineligible; re-ranked`, `no previous session`) replace the old blanket claim. `revalidateDecision` still runs unconditionally before launch, including on sticky reuse.
- Missing-session-id still returns exit 2 `Session not found: <id>` before any routing work.
- Docs (README, configuration.md, operations.md, provider-support.md, skill files) updated consistently and accurately, including the documented deviation from the spec's table: `router status` without `--usage` still prints accounts only (no local-session pass), per the plan's Task 4 lock. This is called out in the handoff and in the docs, not a silent gap — flagging only so the next reader doesn't mistake it for spec drift.

## Findings (non-blocking)

1. **Card-string branch untested at the run/CLI layer.** `previous route ineligible; re-ranked` (packages/router/src/commands/run.ts:283) has no test exercising it — only the phase-boundary and no-session branches are covered in `test/cli/session.test.ts`. The underlying re-rank _logic_ for an ineligible previous route is covered at the `decideRoute` unit level (`test/semantic/decision-engine.test.ts`, "re-ranks when the previous opaque id is not in the eligible set"), so this is a presentation-layer gap, not a logic gap. Low severity.
2. **`router usage refresh` persists `unknown` snapshots; `createDefaultRunDeps` does not.** `commands/usage.ts`'s `persist` callback (wired in `cli.ts`) saves every collected snapshot when `--dry-run` is absent, including `certainty: "unknown"` ones, whereas `createDefaultRunDeps` explicitly filters `snapshot.certainty !== "unknown"` before saving. `UsageRepository.latest()` isn't called anywhere in `src` yet, so there's no live behavioral impact today, but if something later reads `.latest()` to decide routing, an `unknown` row from a stale/missing cache could shadow a still-valid older snapshot for that account. Worth a one-line filter (`if (snapshot.certainty !== "unknown") persist(snapshot)`) for consistency, but not required by the spec text and not urgent.

Neither finding blocks merge; both are small follow-ups if you want them.

## Not re-litigated

Everything explicitly out of scope in the spec (`deterministicFallback` wiring, `--choose` after exit 3, coordinator/Hermes deploy, cost estimator, reserve floor changes) was confirmed still untouched — no scope creep found.
