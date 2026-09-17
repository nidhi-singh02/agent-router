# Security and Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and prove the seven verified security and reliability fixes across the router CLI, coordinator, and heartbeat client.

**Architecture:** D1 becomes the coordinator source of truth, while local SQLite becomes the atomic source of truth for capacity reservations. Heartbeat operations use unique renewable lease handles, external TypeSafe calls are guarded locally, and process/filesystem boundaries receive explicit least-privilege controls.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, better-sqlite3, Cloudflare Workers/D1, Zod

**Spec:** `docs/superpowers/specs/2026-09-17-security-reliability-hardening-design.md`

## Global Constraints

- Do not deploy Cloudflare resources or make live provider requests.
- Do not modify an external Hermes checkout.
- Preserve the existing CLI behavior except where the approved spec explicitly changes it.
- Write every regression test first and observe the expected failure before production changes.
- Do not touch pre-existing untracked research or handoff files.

---

### Task 1: Persistent multi-lease coordinator

**Files:**
- Modify: `packages/coordinator/src/schema.ts`
- Modify: `packages/coordinator/src/leases.ts`
- Modify: `packages/coordinator/src/index.ts`
- Modify: `packages/coordinator/migrations/0001_leases.sql`
- Modify: `packages/coordinator/test/coordinator.test.ts`
- Create: `packages/coordinator/test/worker-entry.test.ts`

**Interfaces:**
- Produces: `LeaseRepository` with asynchronous create/renew/release/activity operations.
- Produces: D1 implementation used by the Worker entry and in-memory implementation used by focused tests.
- Consumes: writer/reader bearer authentication and normalized `Activity` responses.

- [ ] Add failing tests proving separate Worker requests retain a lease, sibling leases survive one release, long-lived operations can renew, and malformed authenticated input returns `400`.
- [ ] Run `npm test --workspace @model-router/coordinator -- --run` and confirm failures are caused by the per-request `Map`, single-key lease model, and uncaught parsing.
- [ ] Implement the repository interface, D1 SQL operations, unique `(account_fingerprint, lease_id)` rows, safe decoding/JSON validation, and fail-closed Worker binding checks.
- [ ] Re-run the coordinator tests until green, then refactor only while they remain green.
- [ ] Commit coordinator persistence as one reviewable change.

### Task 2: Heartbeat HTTP contract, unique leases, and renewal

**Files:**
- Modify: `packages/hermes-heartbeat/src/client.ts`
- Modify: `packages/hermes-heartbeat/src/request-wrapper.ts`
- Modify: `packages/hermes-heartbeat/src/index.ts`
- Modify: `packages/hermes-heartbeat/test/client.test.ts`
- Modify: `packages/hermes-heartbeat/test/privacy.test.ts`

**Interfaces:**
- Produces: opaque `HeartbeatLeaseHandle` returned by `create` and consumed by `renew`/`release`.
- Produces: configurable timer hooks used to deterministically test renewal.
- Consumes: coordinator endpoints from Task 1.

- [ ] Add failing tests for non-2xx status rejection, trailing-slash normalization, two overlapping operations, periodic renewal beyond one TTL, and diagnostic redaction.
- [ ] Run `npm test --workspace @model-router/hermes-heartbeat -- --run` and confirm each test fails for the audited behavior.
- [ ] Implement URL normalization, status-only sanitized errors, unique lease handles, renewal scheduling, isolated release, and cleanup in `finally`.
- [ ] Re-run heartbeat tests until green and confirm provider operations remain non-fatal when heartbeat operations fail.
- [ ] Commit the heartbeat lifecycle change.

### Task 3: Atomic SQLite reservations

**Files:**
- Modify: `packages/router/src/store/migrations/001_initial.sql`
- Modify: `packages/router/src/store/database.ts`
- Create: `packages/router/src/store/reservation-repository.ts`
- Modify: `packages/router/src/reservations/reservation-service.ts`
- Modify: `packages/router/src/commands/runtime.ts`
- Modify: `packages/router/src/commands/run.ts`
- Modify: `packages/router/test/reservations/reservation-service.test.ts`
- Modify: `packages/router/test/commands/runtime.test.ts`
- Modify: `packages/router/test/cli/run.test.ts`

**Interfaces:**
- Produces: SQLite-backed `ReservationService.tryCreate(...)` that atomically cleans expired rows, sums active ratios, validates the reserve floor, and inserts or rejects.
- Consumes: selected account, current usage snapshot, estimated cost, and current time.

- [ ] Add failing integration tests using two database connections to prove only one competing reservation can cross the reserve boundary, persisted reservations affect a later process, and failed launches release reservations.
- [ ] Run the focused router tests and confirm the in-memory implementation allows the unsafe outcome.
- [ ] Add the reservation table/repository and wire one shared SQLite-backed service into runtime dependencies.
- [ ] Move final shared-account reservation acquisition into an immediate transaction and release on launch failure.
- [ ] Re-run focused router tests until green, including existing session and quota behavior.
- [ ] Commit atomic local reservations.

### Task 4: Filesystem permissions

**Files:**
- Modify: `packages/router/src/config/config-loader.ts`
- Modify: `packages/router/src/store/database.ts`
- Modify: `packages/router/test/config/config-loader.test.ts`
- Modify: `packages/router/test/store/repositories.test.ts`

**Interfaces:**
- Produces: `ensurePrivateDirectory(path)` and database permission enforcement performed on every open.

- [ ] Add a failing POSIX test that starts with permissive directory/database modes and expects `0700`/`0600`, including WAL/SHM when present.
- [ ] Run the focused tests and observe the current `0755`/`0644` failure.
- [ ] Implement explicit creation modes plus corrective `chmod` calls; surface permission errors.
- [ ] Re-run the focused tests and a real `stat` runtime probe until both confirm restrictive modes.
- [ ] Commit local-state permission hardening.

### Task 5: TypeSafe sensitive-state gate

**Files:**
- Modify: `packages/router/src/semantic/typesafe-client.ts`
- Modify: `packages/router/test/semantic/typesafe-client.test.ts`
- Modify: `packages/router/test/semantic/decision-engine.test.ts`

**Interfaces:**
- Produces: `assertSafeState` category-based rejection without matched-value disclosure.

- [ ] Add table-driven failing tests for GitHub/provider tokens, password assignments, cookies, PEM private keys, credential-bearing URLs, `<digits>:<secret>` bot-token-shaped credentials, and safe ordinary task text.
- [ ] Add a failing decision-engine test proving no TypeSafe call occurs when classification state is sensitive.
- [ ] Run the focused semantic tests and confirm the unsupported secret formats currently pass.
- [ ] Implement deterministic category patterns and sanitized error messages.
- [ ] Re-run semantic tests until green and mutation-check every category by removing its pattern temporarily or reasoning against the table.
- [ ] Commit the TypeSafe privacy gate.

### Task 6: Herdr environment isolation

**Files:**
- Modify: `packages/router/src/launch/herdr-client.ts`
- Modify: `packages/router/src/commands/runtime.ts`
- Modify: `packages/router/test/launch/herdr-client.test.ts`
- Modify: `packages/router/test/commands/runtime.test.ts`

**Interfaces:**
- Produces: `buildChildProcessEnv` allowlist and `createProcessCommandAdapter({ env })`.

- [ ] Add a failing real-child-process test proving a supplied credential variable is absent while `PATH`, terminal, locale, temporary-directory, home/user, and Herdr variables are retained when present.
- [ ] Run focused launch/runtime tests and observe inherited-secret failure.
- [ ] Implement the allowlist and pass it explicitly to `spawn` through runtime construction.
- [ ] Re-run focused tests and a compiled runtime child-process probe until green.
- [ ] Commit subprocess environment isolation.

### Task 7: Coordinator transport security and documentation

**Files:**
- Modify: `packages/router/src/config/config-schema.ts`
- Modify: `packages/router/src/activity/coordinator-client.ts`
- Modify: `packages/router/test/config/config-loader.test.ts`
- Modify: `packages/router/test/activity/activity-service.test.ts`
- Modify: `README.md`
- Modify: `docs/privacy.md`
- Modify: `docs/operations.md`
- Modify: `docs/configuration.md`
- Modify: `packages/coordinator/README.md`
- Modify: `packages/hermes-heartbeat/README.md`

**Interfaces:**
- Produces: shared coordinator URL validator allowing HTTPS and HTTP loopback only.

- [ ] Add failing tests rejecting remote HTTP at config parsing and programmatic client construction while accepting HTTPS and loopback HTTP.
- [ ] Run focused configuration/activity tests and confirm remote HTTP is currently accepted.
- [ ] Implement URL validation at both boundaries and ensure bearer credentials are never sent before validation.
- [ ] Update documentation for D1 persistence, unique leases, renewal, sensitive-task rejection, local-state permissions, environment isolation, and deployment boundaries.
- [ ] Re-run focused tests and `npm run format:check` until green.
- [ ] Commit transport validation and documentation.

### Task 8: Independent review and full verification

**Files:**
- Review all changed files; modify only to resolve verified review findings.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: verified implementation evidence and final branch state.

- [ ] Review the full diff against the approved spec and run an independent read-only review agent if available.
- [ ] Reproduce every accepted review finding before changing code; add a failing regression test before each correction.
- [ ] Run `npm audit` and record the vulnerability count.
- [ ] Run `npm run verify` and require a zero exit code from typecheck, ESLint, Prettier, all tests, and builds.
- [ ] Run real runtime probes for D1-style separate requests, overlapping/renewed heartbeat leases, SQLite concurrency, filesystem modes, TypeSafe blocking, and child-process environment isolation.
- [ ] Run `git diff --check`, inspect `git status --short`, and confirm pre-existing untracked files are untouched.
- [ ] Commit any review fixes separately and prepare the branch for handoff without deploying or pushing unless requested.
