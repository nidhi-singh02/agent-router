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
