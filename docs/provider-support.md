# Provider support

Availability and quota still come from collectors. The catalog is operator-curated
launch profiles, not a claim that a model is currently offered.

| Agent                | Verified locally (this workspace)                                                                                              | Usage collection                                                                                                                  | Notes                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cursor `agent`       | `--model cursor-grok-4.6-medium`. No `--thinking`. Do not pass `--force` by default. Medium effort is encoded in the model ID. | Parser fixtures only. Live usage commands are not wired.                                                                          | `--list-models` was not run; it may consume quota.                                                                        |
| Claude Code `claude` | `--model` and `--effort` (`low`, `medium`, `high`; `xhigh` and `max` for Opus 5.5). The router does not map `ultra` to Claude. | Fixture: five-hour window missing → estimated weekly + diagnostic.                                                                | Opus 5.5 live effort switching: `/effort` slider, "this session only" (Claude Code 2.1.283).                              |
| Codex `codex`        | `--model` only. No reasoning-effort flag in `codex --help`.                                                                    | Local-session: `~/.codex/statusline-quota-cache.json` `{ weekly_left, at }` (percent remaining, Unix seconds, 15-minute max age). | The router does not write this file. GPT 6 Astra live effort switching: `Alt+.` / `Alt+,`, next turn (codex-cli 0.156.1). |
| OpenCode             | Interactive start: `--model provider/model`. `--variant` exists on `opencode run`, not the TUI flags used for Herdr start.     | Harness auth/models only; quota belongs to the underlying provider.                                                               |                                                                                                                           |

Browser dashboard parsers are fragile estimated fallbacks against sanitized HTML fixtures.
They never copy cookie databases.

Local 2026-09-17 CLI dry runs did not attach a live dashboard; browser `--dry-run` reported unknown five-hour usage.
