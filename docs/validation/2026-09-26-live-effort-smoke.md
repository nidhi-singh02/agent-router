# Live effort switching: manual smoke checklist

Run by hand before relying on `liveEffort.enabled`. The automated tests drive a scripted
fake of each TUI (`packages/router/test/live-effort/fake-pane.ts`); this checklist confirms
the real TUIs behave the way that fake assumes. Record the Claude Code, Codex, and Herdr
versions next to each result: the switch drives their screens and keys, so an upgrade can
break it.

Versions the implementation was written against: Claude Code 2.1.283, codex-cli 0.156.1,
Herdr 0.9.0.

## Setup

1. `"liveEffort": { "enabled": true }` in `config.json`, an account with
   `anthropic:claude-opus`, and one with `openai:gpt-6-astra`.
2. Back up `~/.claude/settings.json` and `~/.codex/config.toml` (`cp` to the scratch dir).
3. Start each agent with `router run "<a planning task>"` from a Herdr pane and note the
   session ids.

## Claude Code (Opus 5.5)

| #   | Check                                                                                                                                           | Result |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | `router effort <id> high` on an idle pane: slider opens, lands on `high`, pane prints `Set effort level to high (this session only)`, exit 0    |        |
| C2  | `cmp` the backed-up `~/.claude/settings.json` with the live one: unchanged                                                                      |        |
| C3  | The next request's transcript entry has `"effort":"high"` (`router session <id>` shows the switch)                                              |        |
| C4  | Status line cache stays warm after the switch (cache read tokens do not reset)                                                                  |        |
| C5  | From inside the agent (it runs `router effort --session <id> "…"` itself mid-turn), the level applies to its next request in the same turn      |        |
| C6  | With text typed in the input box, `router effort <id> low` exits 5 `pane-input-busy` and the text is untouched                                  |        |
| C7  | An empty input box with a dim placeholder suggestion reads as empty (switch proceeds). If it reads busy, note the placeholder's styling here    |        |
| C8  | Lowering from `xhigh` to `low`, and from a pane launched at `max` to `high`, both land on the right level                                       |        |
| C9  | (If a Bedrock or gateway setup is available) the `Change effort level?` dialog is declined, exit 5 `cache-warning`, later phases open new panes |        |

## Codex (GPT 6 Astra)

| #   | Check                                                                                                                                            | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| X1  | `router effort <id> xhigh` on an idle pane: status line changes to `GPT-6-Astra xhigh`, exit 0                                                   |        |
| X2  | `cmp` the backed-up `~/.codex/config.toml`: unchanged                                                                                            |        |
| X3  | Mid-turn agent call: the shortcut is accepted while working, the continuation appears as a queued message, and Codex sends it when the turn ends |        |
| X4  | The queued turn runs at the new level (rollout `turn_context.payload.effort`)                                                                    |        |
| X5  | In Plan mode (`shift+tab`), the switch exits 5 `codex-plan-mode` and nothing is sent                                                             |        |
| X6  | With the `/model` popup open, the switch fails with `verify-mismatch` and the popup is untouched                                                 |        |
| X7  | `Alt+,` from a pane launched at `ultra` steps down through `max` to the requested level                                                          |        |

If X3 fails (Codex does not send the queued message by itself), the design's fallback is a
detached waiter that prompts the pane once it is idle. It is not implemented, because the
Codex source at `rust-v0.156.1` queues Tab-submitted input while a turn is running
(`bottom_pane/chat_composer.rs`, `tab_queues_*_while_task_running` tests).

## Open questions from the adversarial review

| #   | Check                                                                                                                                       | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1  | Codex's shell-tool timeout: does a `router effort` call from a Codex agent (TypeSafe call plus two 5 s polls) finish before Codex kills it? |        |
| A2  | After `/model sonnet` in a router Claude pane, a switch to `xhigh` fails cleanly (`verify-mismatch`) and the record is not updated          |        |
| A3  | Tool output that prints `⎿  Set effort level to …` or the slider hint during a switch does not produce a false `applied`                    |        |

## Phase boundary

| #   | Check                                                                                                                                         | Result |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | From inside an Opus planning pane: `router run --session <id> "implement …"` picks Opus again; no new pane; the agent continues the new phase |        |
| P2  | Same from another pane: the router waits for idle, switches, then prompts the task into the original pane                                     |        |
| P3  | A top-tier choice (root task says "ultra", TypeSafe picks `max`) opens a new pane launched with `--effort max`                                |        |
| P4  | A different model winning opens a new pane as before                                                                                          |        |

## Results, 2026-09-26 (partial)

Claude Code 2.1.283, codex-cli 0.156.1, Herdr 0.9.0. Run against a throwaway router home, so
the real config and state database were not touched.

| #      | Result                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1     | Pass: `low -> xhigh`, status line `GPT-6-Astra xhigh`, exit 0                                                                                                                                                                                                                                             |
| X2     | Pass: `~/.codex/config.toml` byte-identical after four switches (`cmp`)                                                                                                                                                                                                                                   |
| X5     | Failed first, fixed, then pass. The live footer shows `Plan mode` without the `(shift+tab to cycle)` hint, so the first check missed it and a switch changed only the Plan-mode level. `codexInPlanMode` now reads `Plan mode` in the footer lines. After the fix: exit 5 `codex-plan-mode`, nothing sent |
| X7     | Partial: `xhigh -> medium` pass. Stepping down from `ultra` not run                                                                                                                                                                                                                                       |
| X3, X4 | Not run. The agent's self-call was mis-quoted by the test prompt (a trailing `.` became a stray argument, correctly rejected), and the account then dropped below 10% of its 5-hour limit                                                                                                                 |
| X6     | Not run                                                                                                                                                                                                                                                                                                   |
| C1–C9  | Not run: the Claude account is shared and was below its 40% reserve (7-day window 77% used); the reserve was not overridden                                                                                                                                                                               |
| P1–P4  | Not run                                                                                                                                                                                                                                                                                                   |

Also found:

- **Idle Codex input line.** Codex animates grey Braille particles across the empty input
  line. They are not dim, so the input check read the box as busy. Braille characters are
  now ignored.
- **Launch timeouts unrelated to this feature.** `router run` launches of Codex timed out
  because a new pane's shell opened with oh-my-zsh's `Would you like to update? [Y/n]`
  prompt, which swallowed the typed agent command. Answer it once (or set
  `DISABLE_UPDATE_PROMPT=true`) before launching.
