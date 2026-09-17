# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The `router`, `hermes-heartbeat`, and `coordinator` packages are versioned together
and released under a single tag.

## [Unreleased]

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
