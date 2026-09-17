# CLI reference

Commands:

- `router run "<task>" [--dry-run] [--usage] [--json]` (usage checks are off by default for speed; pass `--usage` to check quota. Without it shared accounts are excluded)
- `router status [--usage]` (`--usage` shows each account's quota)
- `router session [id] [--list] [--limit <n>] [--json]` (latest launched session by default; dry runs are not recorded)
- `router accounts`
- `router usage refresh [--source official-cli|browser] [--dry-run]`

JSON output is for plugins. Human output is the decision card.

Cursor launch mapping verified in this repo: `agent --model cursor-grok-4.6-medium`.
