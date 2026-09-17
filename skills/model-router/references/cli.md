# CLI reference

Commands:

- `router run "<task>" [--dry-run] [--usage] [--session <id>] [--json]` (default reads local-session quota caches; `--usage` also runs official CLI/API and browser collectors. Personal accounts stay eligible without known quota; shared accounts still need known usage.)
- `router status [--usage]` (`--usage` shows each account's quota via the full collector chain; without it, accounts only)
- `router session [id] [--list] [--limit <n>] [--json]` (latest launched session by default; dry runs are not recorded)
- `router accounts`
- `router usage refresh [--source local-session|official-cli|browser] [--dry-run]` (default source is local-session; `--dry-run` does not persist)

JSON output is for plugins. Human output is the decision card.

Cursor launch mapping verified in this repo: `agent --model cursor-grok-4.6-medium`.

`router run --session <id>` classifies the next task's phase, then reuses the previous eligible route in the same phase (same model and effort) instead of re-ranking. A phase change or an ineligible previous route re-ranks. The card reports reuse, phase change, or ineligibility. Launched agents receive `Router session: <id>` and instructions to route the next phase after asking the user.
