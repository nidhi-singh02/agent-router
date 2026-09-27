# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The `router`, `hermes-heartbeat`, and `coordinator` packages are versioned together
and released under a single tag.

## [Unreleased]

### Added

- Live effort switching for Opus 5.5 and GPT 6 Astra, opt-in with `liveEffort.enabled`.
  `router run --session <id>` continues the next phase in the previous pane when TypeSafe
  picks the same account and model, changing the effort in place instead of opening a new
  pane. `router effort --session <id> "<sub-step>"` lets an agent ask TypeSafe for a new
  level mid-phase, with a cooldown, a per-session cap, a confidence floor, and a quota
  recheck before raising effort; `router effort <id> <level>` is the manual override.
  Claude Code switches through its `/effort` slider with "this session only", so the saved
  default is never changed; Codex switches with its reasoning shortcut, which applies from
  the next turn, so the continuation is queued for that turn. Every switch is confirmed on
  screen and recorded in a new `effort_changes` table, shown by `router session`. An agent
  can switch only its own pane, its sub-step must be one line of plain text, and the manual
  form is refused inside an agent.
- Opus 5.5 gains `xhigh` and `max`; GPT 6 Astra gains `xhigh` and `max`.
- `router --version` (and `-V`) reports the package version.
- `router run --worktree` launches the agent in a new Git worktree and branch created from
  the committed `HEAD` of a clean checkout, outside the checkout. The session records the
  worktree path, branch, repository identity, and starting commit; `router session` and its
  `--json` output show them. `router run --session <id>` on an isolated session reuses and
  validates that worktree instead of the current directory, both before routing and again
  immediately before launch. If the source checkout becomes dirty or HEAD changes while
  routing, creation stops and the reservation is released. A continued isolated session
  resolves pull request size from its worktree. `--worktree --dry-run` previews the
  worktree without creating anything. Runs without `--worktree` are unchanged.

### Changed

- `max` and `ultra` are unlocked only by the word "ultra" in the root `router run` task,
  and the unlock is inherited by continued sessions. Previously any task, including a
  continued one an agent wrote, could unlock `ultra`; a next-phase task typed into the Herdr
  plugin's resume prompt no longer unlocks it either.
- The state database moves to schema version 3 (`effort_changes`, `effort_locks`). Sessions
  may now record `xhigh` or `max`, which older router builds cannot read: after using them,
  do not run an older build against the same state directory.
- Renamed the npm scope from `@model-router/*` to `@agent-router/*` to match the
  repository name. Nothing was published under the old scope; a local checkout
  needs `npm install` and a re-run of `npm link -w @agent-router/router`.

## [0.1.0] - 2026-09-18

Initial public release. Pre-release software: the routing, quota, and account
contracts may still change.

### Added

- `router run`, `status`, `session`, `accounts`, and `usage refresh` commands.
- Deterministic eligibility filtering over configured subscriptions: enabled
  models, authentication, usage certainty, quota exhaustion, and the 40% reserve
  floor on shared accounts.
- TypeSafe ranking and reasoning-effort selection over the eligible candidate set
  only, with a privacy gate that rejects credential-shaped state before any call.
- Usage collectors for Cursor, Claude, Codex, and OpenCode, with local-session
  status-line caches by default and slower CLI/browser collectors behind `--usage`.
- Phase-sticky routing: sessions recorded in SQLite, phase transitions from
  planning to implementation, and structured handoff to the launched agent.
- Agent launch into a separate Herdr pane, with launch tokens and pane IDs that
  prevent duplicate panes on retry, plus handoff delivery confirmation.
- Hosted heartbeat coordinator (Cloudflare Workers/D1) and a heartbeat client for
  reporting shared-account activity without transmitting identities or task content.
- Herdr plugin manifest and actions.
- Documentation: configuration, operations, privacy, and provider support.

### Known limitations

- The CLI does not yet report its own version (`router --version` is unsupported).
- The coordinator is not deployed; without it, shared accounts route on quota alone.
