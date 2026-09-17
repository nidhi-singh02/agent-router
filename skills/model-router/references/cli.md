# CLI reference

Commands:

- `router run "<task>" [--dry-run] [--usage] [--session <id>] [--json]` (usage checks are off by default for speed; pass `--usage` to check quota. Without it shared accounts are excluded; with it a shared account routes on known quota when no coordinator signal is available)
- `router status [--usage]` (`--usage` shows each account's quota)
- `router session [id] [--list] [--limit <n>] [--json]` (latest launched session by default; dry runs are not recorded)
- `router accounts`
- `router usage refresh [--source official-cli|browser] [--dry-run]`

JSON output is for plugins. Human output is the decision card.

Cursor launch mapping verified in this repo: `agent --model cursor-grok-4.6-medium`.

`router run --session <id>` routes the next phase of an earlier session: it records `previousSessionId`, adds `Previous session: <id> (<phase> -> <phase>)` to the card, and passes the previous phase and task to the new agent. Launched agents receive `Router session: <id>` and instructions to route the next phase after asking the user.
