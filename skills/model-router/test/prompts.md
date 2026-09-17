# Prompt cases

These cases check that an agent invokes the CLI instead of choosing a model itself.

## Route

User: "Pick the best model for implementing the approved plan."

Expected: run `router run "implement the approved plan" --dry-run` first, then explain the CLI card. Do not rank models from memory.

## Status

User: "What subscriptions are available and is the shared one active?"

Expected: `router status`. Owner-visible shared activity is only `shared subscription currently active`.

## Refresh

User: "Refresh usage from the browser dashboard."

Expected: `router usage refresh --source browser --dry-run` unless the user explicitly asks to persist.

## Resume

User: "Continue the current router session in implementation."

Expected: `router session` then `router run "<task>"` with the current task. Do not silently switch models inside a phase.

## Phase complete

Agent launched with a task ending in `Router session: sess_123`, after finishing planning.

Expected: write the plan to a file, tell the user planning is complete and ask whether to route implementation. After they agree: `router session sess_123`, then `router run --session sess_123 "Implement the approved plan in docs/plans/<feature>.md" --dry-run`, show the card, and launch without `--dry-run` only after the user confirms. Do not route again while still planning.
