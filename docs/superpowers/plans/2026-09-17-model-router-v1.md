# Model Router v1 Implementation Plan

> **For the implementation agent:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Build an explicit TypeScript CLI that selects an eligible subscription, model, and reasoning effort with TypeSafe, protects shared capacity, reports Hermes activity, and launches the chosen agent in a separate Herdr pane.

**Architecture:** An npm-workspace monorepo separates the local router, hosted heartbeat coordinator, Hermes heartbeat client, and thin invocation skill. Deterministic code filters and revalidates candidates; TypeSafe ranks only the eligible closed set. Local state is SQLite, coordinator state is Cloudflare D1, and every external integration is behind a tested adapter.

**Tech stack:** Node.js 20+, TypeScript, npm workspaces, Commander, Zod, `@typesafe-ai/sdk`, `better-sqlite3`, Vitest, Cloudflare Workers/D1, Wrangler, ESLint, Prettier.

**Design specification:** `docs/superpowers/specs/2026-09-17-model-router-design.md`

---

## Task 1: Initialize the repository and quality gates

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `vitest.workspace.ts`
- Create: `packages/router/package.json`
- Create: `packages/router/tsconfig.json`
- Create: `packages/router/src/index.ts`
- Create: `packages/coordinator/package.json`
- Create: `packages/coordinator/tsconfig.json`
- Create: `packages/hermes-heartbeat/package.json`
- Create: `packages/hermes-heartbeat/tsconfig.json`

**Steps:**

- [ ] Initialize Git if the directory is not already a repository. Do not overwrite existing files.
- [ ] Add npm workspaces for `packages/*`.
- [ ] Pin Node.js to `>=20` and add scripts: `build`, `test`, `test:watch`, `typecheck`, `lint`, `format:check`, and `verify`.
- [ ] Install runtime and development dependencies declared in the tech stack.
- [ ] Add the smallest compile target exporting `@model-router/router`.
- [ ] Run `npm run verify` and confirm the empty foundation passes.
- [ ] Commit: `chore: initialize model router workspace`

## Task 2: Define and validate the domain model

**Files:**

- Create: `packages/router/src/domain/ids.ts`
- Create: `packages/router/src/domain/account.ts`
- Create: `packages/router/src/domain/model-profile.ts`
- Create: `packages/router/src/domain/usage.ts`
- Create: `packages/router/src/domain/session.ts`
- Create: `packages/router/src/domain/route.ts`
- Create: `packages/router/src/domain/schemas.ts`
- Test: `packages/router/test/domain/schemas.test.ts`

**Steps:**

- [ ] Write failing tests for valid personal/shared accounts, arbitrary labels, shared default reserve `0.40`, usage certainty, reset windows, supported efforts, and malformed configuration.
- [ ] Implement branded IDs and Zod schemas for `Account`, `ModelProfile`, `UsageSnapshot`, `RouterSession`, `RouteCandidate`, and `RouteDecision`.
- [ ] Model OpenCode as an agent harness whose account points to an underlying provider.
- [ ] Make `unknown` usage explicit rather than encoding it as zero.
- [ ] Run `npm test -- --run packages/router/test/domain/schemas.test.ts`.
- [ ] Commit: `feat: define validated routing domain model`

## Task 3: Add configuration, model catalog, and SQLite persistence

**Files:**

- Create: `packages/router/src/config/config-schema.ts`
- Create: `packages/router/src/config/config-loader.ts`
- Create: `packages/router/src/catalog/model-catalog.ts`
- Create: `packages/router/config/models.json`
- Create: `packages/router/src/store/database.ts`
- Create: `packages/router/src/store/migrations/001_initial.sql`
- Create: `packages/router/src/store/account-repository.ts`
- Create: `packages/router/src/store/usage-repository.ts`
- Create: `packages/router/src/store/session-repository.ts`
- Create: `packages/router/src/store/audit-repository.ts`
- Test: `packages/router/test/config/config-loader.test.ts`
- Test: `packages/router/test/store/repositories.test.ts`

**Steps:**

- [ ] Write failing tests for config precedence, invalid reserve floors, catalog provenance timestamps, migration idempotency, session recovery, and redacted audit storage.
- [ ] Store the database under the platform configuration directory, overridable with `MODEL_ROUTER_HOME` for tests.
- [ ] Keep credentials out of both configuration and SQLite; persist credential references only.
- [ ] Seed a conservative catalog schema without asserting unverified model availability. Availability still comes from collectors.
- [ ] Add migration transaction handling and schema version checks.
- [ ] Run the focused tests, then `npm run typecheck`.
- [ ] Commit: `feat: add configuration and local state store`

## Task 4: Implement quota arithmetic and deterministic eligibility

**Files:**

- Create: `packages/router/src/policy/freshness.ts`
- Create: `packages/router/src/policy/quota.ts`
- Create: `packages/router/src/policy/cost-estimator.ts`
- Create: `packages/router/src/policy/eligibility.ts`
- Create: `packages/router/src/policy/revalidate.ts`
- Test: `packages/router/test/policy/quota.test.ts`
- Test: `packages/router/test/policy/eligibility.test.ts`
- Test: `packages/router/test/policy/revalidate.test.ts`

**Steps:**

- [ ] Write table-driven failing tests for five-hour, daily, weekly, monthly, and provider-defined windows.
- [ ] Test shared accounts at 41%, exactly 40%, and below 40% after estimated cost and active reservations.
- [ ] Test that personal accounts may consume below 40% and that unknown/stale shared usage is ineligible by default.
- [ ] Return structured exclusion reasons rather than booleans.
- [ ] Re-run eligibility immediately before launch and reject a now-unsafe choice.
- [ ] Run all policy tests.
- [ ] Commit: `feat: enforce deterministic quota and reserve policies`

## Task 5: Build TypeSafe semantic decision units

**Files:**

- Create: `packages/router/src/semantic/typesafe-client.ts`
- Create: `packages/router/src/semantic/task-classifier.ts`
- Create: `packages/router/src/semantic/phase-classifier.ts`
- Create: `packages/router/src/semantic/task-scorer.ts`
- Create: `packages/router/src/semantic/cache-assessor.ts`
- Create: `packages/router/src/semantic/route-ranker.ts`
- Create: `packages/router/src/semantic/effort-selector.ts`
- Create: `packages/router/src/semantic/decision-engine.ts`
- Create: `packages/router/src/semantic/fallback.ts`
- Test: `packages/router/test/semantic/decision-engine.test.ts`
- Test: `packages/router/test/semantic/confidence-policy.test.ts`
- Create: `packages/router/evals/routing-cases.json`

**Steps:**

- [ ] Use the installed TypeSafe skill and current official TypeSafe SDK documentation before coding this task.
- [ ] Write failing tests with a fake TypeSafe client proving only eligible opaque candidate IDs can be returned.
- [ ] Implement closed-set `Choice` questions for task family, phase, route, and effort; use `Score`/`Noul` for ordered or probabilistic judgments.
- [ ] Batch independent classifications, but keep route ranking dependent on their outputs.
- [ ] Exclude `ultra` unless the user explicitly requests it and the selected model supports it.
- [ ] Implement consequence-aware confidence thresholds and top-two output for material ambiguity.
- [ ] Ensure TypeSafe inputs contain no credentials, cookies, account labels, Telegram data, or raw heartbeat records.
- [ ] Add evaluation fixtures for planning, specification, implementation, debugging, review, creative ideation, metadata, research, and routine transformations.
- [ ] Run semantic tests with the fake client; make live evals opt-in via `TYPESAFE_API_KEY`.
- [ ] Commit: `feat: add typesafe routing judgments`

## Task 6: Create the usage-collector framework

**Files:**

- Create: `packages/router/src/collectors/types.ts`
- Create: `packages/router/src/collectors/collector-chain.ts`
- Create: `packages/router/src/collectors/command-runner.ts`
- Create: `packages/router/src/collectors/normalizer.ts`
- Create: `packages/router/src/collectors/fixtures.ts`
- Test: `packages/router/test/collectors/collector-chain.test.ts`
- Test: `packages/router/test/collectors/normalizer.test.ts`

**Steps:**

- [ ] Write failing tests for priority order: official API/CLI, local session, browser dashboard, then unknown.
- [ ] Define `detectAccounts`, `collectUsage`, and `listAvailableModels` contracts.
- [ ] Add command timeouts, bounded output, redaction, and explicit source/certainty/freshness metadata.
- [ ] Never execute output returned by a provider command.
- [ ] Degrade parser or command failures to the next collector without inventing usage.
- [ ] Commit: `feat: add normalized usage collector chain`

## Task 7: Add provider and agent adapters

**Files:**

- Create: `packages/router/src/collectors/cursor/cursor-collector.ts`
- Create: `packages/router/src/collectors/cursor/cursor-parser.ts`
- Create: `packages/router/src/collectors/anthropic/claude-collector.ts`
- Create: `packages/router/src/collectors/anthropic/claude-parser.ts`
- Create: `packages/router/src/collectors/openai/codex-collector.ts`
- Create: `packages/router/src/collectors/openai/codex-parser.ts`
- Create: `packages/router/src/collectors/opencode/opencode-collector.ts`
- Create: `packages/router/src/collectors/opencode/opencode-parser.ts`
- Test: `packages/router/test/collectors/provider-contract.test.ts`
- Test fixtures: `packages/router/test/fixtures/providers/`

**Steps:**

- [ ] Discover each installed CLI through non-mutating commands and capture sanitized fixtures for account state and available models.
- [ ] Write contract tests before each parser.
- [ ] Keep subscription usage attached to the underlying provider; OpenCode reports harness authentication and models only.
- [ ] Mark unavailable five-hour data as unknown or estimated with provenance.
- [ ] Do not read or persist credential values. Presence checks may use provider-supported status commands or file metadata only.
- [ ] Verify that a provider format change yields `unknown` plus a diagnostic, not a crash.
- [ ] Commit: `feat: collect local provider availability and usage`

## Task 8: Implement read-only browser-dashboard fallback

**Files:**

- Create: `packages/router/src/collectors/browser/browser-session.ts`
- Create: `packages/router/src/collectors/browser/dashboard-collector.ts`
- Create: `packages/router/src/collectors/browser/dashboard-registry.ts`
- Create: `packages/router/src/collectors/browser/parsers/cursor-dashboard.ts`
- Create: `packages/router/src/collectors/browser/parsers/anthropic-dashboard.ts`
- Create: `packages/router/src/collectors/browser/parsers/openai-dashboard.ts`
- Test: `packages/router/test/collectors/browser-dashboard.test.ts`
- Test fixtures: `packages/router/test/fixtures/dashboards/`

**Steps:**

- [ ] Use the gstack `/browse` skill for live dashboard discovery and visual verification; do not use unrelated browser-control tools.
- [ ] Attach only to an explicitly available authenticated browser session or approved browser bridge; never copy cookie databases into router storage.
- [ ] Write parsers against sanitized saved page fragments before wiring live reads.
- [ ] Record selectors/version hints and mark the result fragile.
- [ ] Make page, selector, login, or parsing failures return unknown.
- [ ] Add `router usage refresh --source browser --dry-run` that prints redacted parsed facts without persisting them.
- [ ] Commit: `feat: add browser usage fallback`

## Task 9: Build the hosted heartbeat coordinator

**Files:**

- Create: `packages/coordinator/wrangler.toml`
- Create: `packages/coordinator/src/index.ts`
- Create: `packages/coordinator/src/auth.ts`
- Create: `packages/coordinator/src/leases.ts`
- Create: `packages/coordinator/src/schema.ts`
- Create: `packages/coordinator/migrations/0001_leases.sql`
- Test: `packages/coordinator/test/coordinator.test.ts`
- Create: `packages/coordinator/README.md`

**Steps:**

- [ ] Write failing Worker tests for writer/read-role separation, create/renew, normalized status read, release, expiry, and malformed input.
- [ ] Store only HMAC-derived account fingerprints, state, optional model family, optional reserved capacity, and timestamps.
- [ ] Do not implement an endpoint that lists raw leases or participant records.
- [ ] Return only inactive/active/constrained normalized activity to the owner reader.
- [ ] Enforce short maximum TTLs server-side and delete expired rows.
- [ ] Add Wrangler commands for local D1 migration and tests.
- [ ] Do not deploy until the user confirms the Cloudflare account/environment and approves the live write.
- [ ] Commit: `feat: add private heartbeat coordinator`

## Task 10: Add the Hermes heartbeat client

**Files:**

- Create: `packages/hermes-heartbeat/src/client.ts`
- Create: `packages/hermes-heartbeat/src/fingerprint.ts`
- Create: `packages/hermes-heartbeat/src/request-wrapper.ts`
- Create: `packages/hermes-heartbeat/src/index.ts`
- Test: `packages/hermes-heartbeat/test/client.test.ts`
- Test: `packages/hermes-heartbeat/test/privacy.test.ts`
- Create: `packages/hermes-heartbeat/README.md`

**Steps:**

- [ ] Write failing tests proving HMAC fingerprints are stable with the same secret, unlinkable without it, and never contain the raw account ID.
- [ ] Wrap a provider request with lease create/renew/release behavior and crash-safe TTL semantics.
- [ ] Prove serialized payloads contain no Telegram ID, name, username, message, prompt, or task metadata.
- [ ] Make heartbeat failures non-fatal to Hermes requests while emitting a local owner diagnostic.
- [ ] Document the minimal integration call around Hermes provider requests; do not modify an external Hermes checkout without confirming its path and ownership.
- [ ] Commit: `feat: add privacy-safe hermes heartbeat client`

## Task 11: Implement coordinator activity consumption and reservations

**Files:**

- Create: `packages/router/src/activity/coordinator-client.ts`
- Create: `packages/router/src/activity/activity-service.ts`
- Create: `packages/router/src/reservations/reservation-service.ts`
- Test: `packages/router/test/activity/activity-service.test.ts`
- Test: `packages/router/test/reservations/reservation-service.test.ts`

**Steps:**

- [ ] Write failing tests for inactive, active, constrained, stale, unauthorized, timeout, and unreachable coordinator states.
- [ ] Display only `shared subscription currently active`; never expose a participant identity.
- [ ] Feed normalized activity into deterministic capacity calculations before TypeSafe sees candidates.
- [ ] Add local reservation create/reconcile/release and expired-reservation cleanup.
- [ ] Treat coordinator outages conservatively for shared accounts.
- [ ] Commit: `feat: account for shared subscription activity`

## Task 12: Implement phase-sticky sessions and structured handoffs

**Files:**

- Create: `packages/router/src/sessions/session-service.ts`
- Create: `packages/router/src/sessions/phase-transition.ts`
- Create: `packages/router/src/sessions/cache-affinity.ts`
- Create: `packages/router/src/handoff/handoff-builder.ts`
- Test: `packages/router/test/sessions/phase-transition.test.ts`
- Test: `packages/router/test/handoff/handoff-builder.test.ts`

**Steps:**

- [ ] Write failing tests showing a route remains stable within a phase and is reconsidered at a phase boundary.
- [ ] Model cache affinity by provider, model, effort, agent, and stable prompt prefix.
- [ ] Require TypeSafe switch judgment only after deterministic eligibility and only at a valid transition.
- [ ] Build handoffs with task, approved spec/plan, constraints, current phase, relevant files, completed checks, and remaining acceptance criteria.
- [ ] Redact secrets and omit unrelated session history.
- [ ] Commit: `feat: add phase-sticky routing sessions`

## Task 13: Implement the Herdr launcher

**Files:**

- Create: `packages/router/src/launch/herdr-client.ts`
- Create: `packages/router/src/launch/agent-command.ts`
- Create: `packages/router/src/launch/herdr-launcher.ts`
- Create: `packages/router/src/launch/readiness.ts`
- Test: `packages/router/test/launch/agent-command.test.ts`
- Test: `packages/router/test/launch/herdr-launcher.test.ts`

**Steps:**

- [ ] Read and follow the installed Herdr skill before using Herdr controls.
- [ ] Write failing tests for exact Cursor, Claude Code, Codex, and OpenCode command construction using supported model/effort mappings.
- [ ] Require `HERDR_ENV=1` and return a clear error outside Herdr.
- [ ] Split a separate pane, wait for readiness, start the agent, and send the structured handoff.
- [ ] Persist a launch token and pane ID before sending the task so retries are idempotent.
- [ ] Detect approval prompts or blocked agents and report them without blind resend.
- [ ] Add `--dry-run` to print the exact redacted launch without creating a pane.
- [ ] Commit: `feat: launch routed agents in herdr`

## Task 14: Build the CLI and explanation card

**Files:**

- Create: `packages/router/src/cli.ts`
- Create: `packages/router/src/commands/run.ts`
- Create: `packages/router/src/commands/status.ts`
- Create: `packages/router/src/commands/session.ts`
- Create: `packages/router/src/commands/accounts.ts`
- Create: `packages/router/src/commands/usage.ts`
- Create: `packages/router/src/presentation/decision-card.ts`
- Create: `packages/router/src/presentation/errors.ts`
- Test: `packages/router/test/cli/run.test.ts`
- Test: `packages/router/test/cli/status.test.ts`

**Steps:**

- [ ] Write failing CLI tests for help, configuration errors, safe route, no eligible route, low-confidence top two, dry run, and duplicate prevention.
- [ ] Compose collection, eligibility, TypeSafe decision, revalidation, reservation, explanation, and launch behind `router run`.
- [ ] Print source, freshness, certainty, reset information, reserve status, semantic reason, cache decision, model, and effort.
- [ ] Ensure `status` and error output never reveal secrets or friend identity.
- [ ] Make JSON output available for future plugin integration without changing the human CLI.
- [ ] Commit: `feat: expose explicit model router cli`

## Task 15: Add end-to-end scenarios and operational documentation

**Files:**

- Create: `packages/router/test/e2e/router-dry-run.test.ts`
- Create: `packages/router/test/e2e/shared-active.test.ts`
- Create: `packages/router/test/e2e/low-confidence.test.ts`
- Create: `README.md`
- Create: `docs/configuration.md`
- Create: `docs/provider-support.md`
- Create: `docs/privacy.md`
- Create: `docs/operations.md`
- Create: `.env.example`

**Steps:**

- [ ] Test planning-to-implementation routing with a structured phase handoff.
- [ ] Test that active shared usage and projected quota below 40% exclude the shared account before TypeSafe ranking.
- [ ] Test personal-account routing, unknown usage, collector failure, TypeSafe outage, coordinator outage, and launch failure.
- [ ] Document exact verified support for each provider and label unsupported or estimated fields honestly.
- [ ] Document keychain/environment credential references, coordinator setup, Hermes hook, dashboard fallback, dry run, and recovery.
- [ ] Run `npm run verify` and record the result in the implementation handoff.
- [ ] Commit: `test: verify model router workflows`

## Task 16: Add the thin invocation skill

**Files:**

- Create: `skills/model-router/SKILL.md`
- Create: `skills/model-router/references/cli.md`
- Test: `skills/model-router/test/prompts.md`

**Steps:**

- [ ] Use the installed skill-creation guidance before authoring the skill.
- [ ] Keep the skill thin: detect intent, invoke the CLI, explain dry-run and confirmation behavior, and defer all routing policy to code.
- [ ] Do not copy provider credentials, routing heuristics, or mutable model catalogs into the skill.
- [ ] Add prompt cases for route, status, refresh, and resume.
- [ ] Install or link the finished skill globally only after local tests pass and the user approves the global write.
- [ ] Commit: `feat: add model router invocation skill`

## Task 17: Live validation and handoff

**Files:**

- Update: `docs/provider-support.md`
- Update: `docs/operations.md`
- Create: `docs/validation/2026-09-17-live-smoke.md`

**Steps:**

- [ ] Run `npm run verify` from a clean working tree.
- [ ] Run `router usage refresh --dry-run` and redact all captured evidence.
- [ ] Run `router run --dry-run` for planning, implementation, and creative tasks.
- [ ] Ask for confirmation before a live provider call, Cloudflare deployment, Hermes integration write, global skill installation, or model launch that consumes subscription quota.
- [ ] With confirmation, smoke-test each configured agent once and record only non-sensitive outcomes.
- [ ] Use `superpowers:verification-before-completion` and inspect the complete diff.
- [ ] Commit: `docs: record model router validation`

## Completion criteria

- [ ] `npm run verify` passes.
- [ ] TypeSafe is used for every semantic routing judgment and cannot bypass deterministic policy.
- [ ] Shared accounts retain at least 40% projected quota.
- [ ] Owner sees only `shared subscription currently active`, with no friend identity.
- [ ] Usage sources and uncertainty are visible.
- [ ] Low-confidence consequential routes present two eligible choices.
- [ ] Route is phase-sticky and cache tradeoffs are explained.
- [ ] `router run` opens exactly one separate Herdr pane with the selected supported model and effort.
- [ ] No credentials, browser cookies, Telegram data, or raw prompts appear in persistent logs or coordinator storage.
- [ ] Documentation distinguishes verified provider support from estimates and unknowns.
