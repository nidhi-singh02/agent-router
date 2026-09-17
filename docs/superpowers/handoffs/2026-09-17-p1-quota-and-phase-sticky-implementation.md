# Handoff: P1 local quota + phase-sticky (implementation complete)

**Date:** 2026-09-17  
**Branch:** `feat/p1-quota-and-phase-sticky` (uncommitted; user did not ask to commit)  
**Spec:** `docs/superpowers/specs/2026-09-17-p1-quota-and-phase-sticky-design.md`  
**Plan:** `docs/superpowers/plans/2026-09-17-p1-quota-and-phase-sticky.md`  
**Previous router session:** `sess_26fe87b8-df17-44b9-837f-d77c93b4c76b`  
**Suggested next phase:** review (code review of this branch vs spec), then merge/PR if the user wants.

## What shipped in this checkout

1. **P1-A — Local quota by default.** `createDefaultRunDeps` uses `usageMode: "local" | "full"` (default local). Default `router run` only runs `kind === "local-session"` collectors. `--usage` sets `"full"`. Snapshots with `certainty !== "unknown"` are saved to SQLite. `router usage refresh` collects and prints; persists unless `--dry-run`. Codex reads `~/.codex/statusline-quota-cache.json` `{ weekly_left, at }` (15-minute max age).
2. **P1-B — Phase-sticky resume.** After TypeSafe classification, `decideRoute` calls `shouldReconsiderRoute`. Same-phase eligible previous route skips ranking/effort and sets `sticky: true`. `executeRun` passes `previousRoute`, sets honest `Cache decision:` strings, and stores `cacheAffinity`. `revalidateDecision` still runs on sticky reuse. TypeSafe outage still does not reuse a route.

## Rulings

- **Status CLI:** Plan Task 4 lock wins over the spec table: `router status` without `--usage` still prints accounts only; `--usage` is the full chain. If wrong, operators will not see local-cache quota on `status` until someone opts in.
- **No worktree:** Work happened on a feature branch in the main checkout (`GIT_DIR == GIT_COMMON`).
- **No commits:** Plan said commit only if the user asked; they did not.
- **Prettier:** Formatted the P1 plan/spec and an existing research note so `npm run verify` could pass.
- **Dry-run isolation:** Did not call TypeSafe or start Herdr. A local-session dry-run against the operator Cursor cache excluded Grok as `quota-exhausted` without `--usage`.

## Verify

- `npm run verify` passed (360 tests).
- Must not print `Cache decision: phase sticky unless eligibility changes` (removed from production card).
- Do not deploy, publish, wrangler, or write an external Hermes checkout.

## Out of scope (still)

TypeSafe `deterministicFallback` wiring, `--choose` after exit 3, coordinator deploy, Hermes checkout, task-length cost estimator.

## Next agent prompt (if the user agrees to route)

Review the implementation on `feat/p1-quota-and-phase-sticky` against `docs/superpowers/specs/2026-09-17-p1-quota-and-phase-sticky-design.md` and this handoff. Do not deploy or publish. Do not start another agent for the same review phase.
