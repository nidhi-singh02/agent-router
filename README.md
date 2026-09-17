# Agent Router

Local-first, quota-aware routing for AI coding agents in Herdr.

`router` is a command-line tool that picks an AI coding agent, model, and reasoning effort
for a task, then starts that agent for you in a Herdr pane.

```sh
router run "implement the approved plan in docs/plans/billing.md"
```

It filters your subscriptions with fixed rules (enabled models, quota, the 40% reserve on
shared accounts), asks TypeSafe to rank what is left and choose an effort, starts the chosen
agent (Cursor, Claude Code, Codex, or OpenCode), and hands it the task.

> **Pre-release:** the project is under active development. Review the security and privacy
> notes below before using real credentials or shared accounts.

## Demo

[![Agent Router demo](https://img.youtube.com/vi/7w8eRWnUUA8/maxresdefault.jpg)](https://youtu.be/7w8eRWnUUA8 "Agent Router demo — click to play")

## Why Agent Router?

- **Quota-aware:** routes around depleted or reserved subscription capacity.
- **Policy-first:** deterministic eligibility rules run before semantic ranking.
- **Local-first:** configuration, usage snapshots, decisions, and session history stay on
  your machine unless an explicitly configured integration needs them.
- **Agent-agnostic:** supports Cursor, Claude Code, Codex, and OpenCode through one command.

## Prerequisites

- **Node.js 20 or newer** (`nvm use` reads `.nvmrc`).
- **A TypeSafe API key.** Routing always calls TypeSafe; there is no fallback. Each run sends
  the task text to TypeSafe. Recognizable credentials are rejected locally before the call;
  do not place other sensitive narrative data in routing tasks.
- **At least one agent CLI you are logged in to:** `agent` (Cursor), `claude` (Claude Code),
  `codex`, or `opencode`. The router uses those logins; no provider API keys are needed.
- **Herdr**, to launch agents. `router run` without `--dry-run` only launches from inside a
  Herdr pane (`HERDR_ENV=1`).

## Setup

### 1. Install and build

```sh
git clone https://github.com/nidhi-singh02/agent-router.git
cd model-router
npm install
npm run build
```

### 2. Put `router` on your PATH

```sh
npm link -w @model-router/router
```

Or add an alias to `~/.zshrc`:

```sh
alias router="node $HOME/Code/model-router/packages/router/dist/cli.js"
```

After `git pull`, run `npm run build` again.

### 3. Create your config

The config lives in `.model-router/` inside the repo (gitignored). Point the router at it
from `~/.zshrc`, then `source ~/.zshrc`:

```sh
export MODEL_ROUTER_HOME="$HOME/Code/model-router/.model-router"
```

```sh
mkdir -p .model-router
cp config.example.json .model-router/config.json
```

Without `MODEL_ROUTER_HOME`, the router uses `~/Library/Application Support/model-router`
on macOS (`~/.config/model-router` elsewhere).

### 4. Store the TypeSafe key in the macOS Keychain

```sh
security add-generic-password -a "$USER" -s model-router-typesafe -w
```

The command prompts for the key, so it never lands in shell history. The config refers to
it with `"typesafe": { "apiKeyRef": "keychain:model-router-typesafe" }`. Every pane and agent
then finds the key without exporting anything, and it stays out of agents' environments. To
replace the key, add `-U`. If macOS asks to allow `security` access the first time, choose
"Always Allow". `TYPESAFE_API_KEY` in the environment still works as a fallback.

### 5. Add your accounts

There is no `router accounts add` command. Edit the `accounts` array in
`.model-router/config.json` (hidden folder; for example `code .model-router/config.json`) with
one entry per agent login:

```json
{
  "id": "acct_personal_claude",
  "label": "personal claude",
  "provider": "anthropic",
  "agent": "claude-code",
  "ownership": "personal",
  "collectorPreference": ["local-session"],
  "enabledModels": ["anthropic:claude-sonnet", "anthropic:claude-opus"],
  "enabled": true
}
```

| Field                 | Values                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `agent`               | `cursor`, `claude-code`, `codex`, `opencode`                                                 |
| `provider`            | Matches the models: `cursor`, `anthropic`, `openai`                                          |
| `ownership`           | `personal`, or `shared` for a subscription other people also use (see below)                 |
| `reserveFloor`        | Optional, 0 to 1. Shared accounts default to `0.40` and cannot go lower                      |
| `collectorPreference` | Where usage comes from: `local-session`, `official-cli`, `official-api`, `browser-dashboard` |
| `enabledModels`       | Model IDs from the table below                                                               |
| `enabled`             | `true` or `false`                                                                            |
| `credentialRef`       | Optional `env:NAME` or `keychain:NAME`. Never put secret values in the file                  |

Run `router accounts` to check that the file parses. `docs/configuration.md` has the full
schema.

### 6. Install the model-router skill (optional, recommended)

The skill lets an agent route the next phase of your work (see
[Phases](#phases-planning-then-implementation)). Link the repo copy so updates arrive with
`git pull`:

```sh
ln -s "$PWD/skills/model-router" ~/.claude/skills/model-router
ln -s "$PWD/skills/model-router" ~/.codex/skills/model-router
ln -s "$PWD/skills/model-router" ~/.cursor/skills/model-router
```

The links follow whatever branch is checked out in this repo.

## Models

Defined in `packages/router/config/models.json`. Add an ID to an account's `enabledModels` to
use it.

| Model ID                  | Agent       | Starts as                                                        | Efforts                  | Quota pool |
| ------------------------- | ----------- | ---------------------------------------------------------------- | ------------------------ | ---------- |
| `cursor:grok-4.6`         | Cursor      | `agent --model cursor-grok-4.6-<effort>`                         | low, medium, high        | spend      |
| `cursor:grok-4.5`         | Cursor      | `agent --model cursor-grok-4.5-high`                             | high                     | spend      |
| `cursor:composer-2.5`     | Cursor      | `agent --model composer-2.5`                                     | none                     | auto       |
| `anthropic:claude-sonnet` | Claude Code | `claude --model sonnet --effort <effort>`                        | low, medium, high        |            |
| `anthropic:claude-opus`   | Claude Code | `claude --model opus --effort <effort>`                          | low, medium, high        |            |
| `openai:gpt-6-astra`      | Codex       | `codex --model gpt-6-astra -c model_reasoning_effort="<effort>"` | low, medium, high, ultra |            |
| `openai:gpt-5.6-sol`      | Codex       | `codex --model gpt-5.6-sol …`                                    | low, medium, high, ultra |            |
| `openai:gpt-5.6-terra`    | Codex       | `codex --model gpt-5.6-terra …`                                  | low, medium, high, ultra |            |
| `openai:gpt-5.6-luna`     | Codex       | `codex --model gpt-5.6-luna …`                                   | low, medium, high        |            |
| `openai:gpt-5.5`          | Codex       | `codex --model gpt-5.5 …`                                        | low, medium, high        |            |
| `openai:opencode`         | OpenCode    | `opencode --model openai`                                        | low, medium, high        |            |

TypeSafe picks the effort from the model's list. `ultra` is only offered when your task text
contains the word "ultra". Capability, cost, and latency numbers in `models.json` are
estimates you can adjust.

## Everyday use

```sh
router run "<task>" --dry-run    # see which agent, model, and effort would be used
router run "<task>"              # start that agent in a new Herdr pane and send the task
router status                    # list accounts; add --usage to show quota
router session                   # the latest launch; router session --list for more
```

`--dry-run` prints the decision card and the command it would start, without opening a pane
or sending anything. A real run splits a new pane next to the current one, starts the agent,
waits for it to finish starting up, sends the task, and confirms the agent began working. You
can run the router any number of times, in the same tab or different ones; each launch gets
its own agent name such as `router-codex-3c356c`.

### The decision card

```text
Selected: cursor / composer-2.5 / none
Phase: implementation
Why: TypeSafe selected acct_personal_cursor:cursor:composer-2.5 for implementation in phase implementation
Reserve policy: personal account
Cache decision: no previous session
Usage source: estimated local-session
Quota: auto 70% left (spend 45% left)
Freshness: refreshed at 2026-09-17T12:00:00.000Z
```

The router routes **one phase per task** (planning, implementation, debugging, review,
research, and so on). It does not answer your question itself; the launched agent does.

### Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Route selected (and launched, unless `--dry-run`)                       |
| 1    | Launch failed; the reason is printed and recorded in the session        |
| 2    | No route: no eligible model, TypeSafe unavailable, or session not found |
| 3    | Low confidence on a consequential task; choose one of the two routes    |

## Quota and usage

Usage checks on `router run` are **local-session by default**: the router reads status-line
cache files (milliseconds) and persists non-unknown snapshots to SQLite. Official CLI/API
and browser collectors stay behind `--usage` (slower, and some live commands may consume
quota). Personal accounts stay eligible when quota is missing, stale, or at 0%. Shared
accounts still need _known_ usage above the reserve.

`router status` without `--usage` still lists accounts only. `router status --usage` runs
the full collector chain.

Quota on the card is informational. For a personal account, a model at 0% remaining is
still eligible. Shared accounts still exclude `quota-exhausted` and `unknown-usage`.

### Where quota comes from

The Cursor, Claude Code, and Codex CLIs do not report plan usage on the command line. The
router reads quota from cache files that **your own status line scripts** write; the router
does not install those scripts. Enable it with `"local-session"` in the account's
`collectorPreference`. Cache data older than 15 minutes counts as unknown, and a cache only
refreshes while a session of that tool is open and redrawing its status line.

**Cursor:** `~/.cursor/statusline-quota-cache.json`

```json
{ "pct": 45, "auto_left": 70, "at": 1700000000 }
```

`pct` is the percent of included spend left (Grok models), `auto_left` the percent of the Auto
pool left (Composer), and `at` the Unix time in seconds.

**Claude Code:** `~/.claude/statusline-quota-cache.json`, written from the `rate_limits`
Claude Code passes to its status line:

```json
{
  "at": 1700000000,
  "five_hour": { "used_percentage": 20, "resets_at": 1700013600 },
  "seven_day": { "used_percentage": 10, "resets_at": 1700604800 }
}
```

Either window may be missing, and a window whose reset time has passed counts as fully
available.

**Codex:** `~/.codex/statusline-quota-cache.json`

```json
{ "weekly_left": 40, "at": 1700000000 }
```

`weekly_left` is the percent of weekly quota remaining (0–100), and `at` is Unix time in
seconds. The router does not write this file.

**OpenCode:** harness-only; quota belongs to the underlying provider.

### Personal and shared accounts

- **Personal:** stays eligible even if quota is missing, stale, or at 0%. The card may still
  show remaining quota when a cache exists.
- **Shared:** needs known usage (a fresh local-session cache, or `--usage`) and keeps 40% of
  its quota in reserve. It is excluded when the coordinator reports someone else using it.
  Without a coordinator (the usual local setup), it routes on its quota alone.

## Phases: planning, then implementation

Each `router run` records a session in `.model-router/state.sqlite`. A launched agent's task
ends with `Router session: <id>` and instructions for when its phase is done. With the skill
installed, the flow is:

The router repairs the state directory to `0700` and SQLite-related files to `0600` whenever
it opens the database. Treat the task and handoff history as sensitive local data.

1. `router run "plan feature X"` starts, for example, Grok for planning.
2. The agent writes the plan to a file and asks you whether to route the next phase.
3. When you agree, it runs `router session <id>` and
   `router run --session <id> "implement the plan in docs/plans/x.md" --dry-run`, shows you
   the card, and launches without `--dry-run` after you confirm.
4. The new session records the previous one. The card shows
   `Previous session: <id> (planning -> implementation)`, and the new agent gets the previous
   phase and task.

The next agent starts in a new pane without the earlier conversation, so the task must point
to the file. You can run the same commands yourself:

```sh
router session <id>
router run --session <id> "implement the plan in docs/plans/x.md"
```

## Commands

```sh
router run "<task>" [--dry-run] [--usage] [--session <id>] [--json]
router status [--usage]
router session [id] [--list] [--limit <n>] [--json]
router accounts
router usage refresh [--source local-session|official-cli|browser] [--dry-run]
```

`--json` prints machine-readable output for plugins, including `sessionId`, `agentName`, and
`paneId`. `router usage refresh` defaults to local-session file reads; `--dry-run` prints
facts and does not persist. Without `--dry-run` it writes snapshots to SQLite.

## Herdr plugin

Agent Router also ships as a Herdr plugin, so routing, status, sessions, and usage refresh are
reachable from Herdr actions and keybindings instead of a shell prompt:

```sh
herdr plugin install nidhi-singh02/agent-router
herdr plugin action list --plugin nidhi-singh02.agent-router
```

The manifest is `herdr-plugin.toml` at the repository root; the scripts it runs live in
`herdr-plugin/`. See [`herdr-plugin/README.md`](herdr-plugin/README.md) for the action list,
keybinding examples, and local development with `herdr plugin link`.

## Troubleshooting

| Message                                                                                 | What to do                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TypeSafe could not select a route (typesafe-unavailable). No TypeSafe API key found …` | Store the key (setup step 4)                                                                     |
| `No eligible route. Exclusions: [...]`                                                  | Read each `reason` below                                                                         |
| `quota-exhausted`                                                                       | That model's quota pool is at 0%; if unexpected, refresh the status-line cache or pass `--usage` |
| `shared-activity-constrained`                                                           | Shared account without known usage (missing/stale cache, or coordinator busy)                    |
| `below-reserve`                                                                         | Shared account would drop below its 40% reserve                                                  |
| `stale-usage`, `unknown-usage`                                                          | Usage data too old or missing; open a session of that tool to refresh its cache                  |
| `model-not-enabled`, `account-disabled`                                                 | Check `enabledModels` and `enabled` in the config                                                |
| `HERDR_ENV=1 is required to launch a pane`                                              | Run from a Herdr pane, or add `--dry-run`                                                        |
| `herdr agent start failed: <code>: <message>`                                           | Herdr's own error; the router closes the pane it created                                         |
| `handoff not received by agent <name> in pane <id> …`                                   | The agent is open but never started the task; paste the task there or run again                  |
| `agent is blocked; not resending the handoff`                                           | The agent is waiting on a question or approval in its pane                                       |
| `Session not found: <id>`                                                               | Check the id with `router session --list`                                                        |
| `zsh: command not found: router`                                                        | Setup step 2, then open a new shell                                                              |

## Development

```sh
npm run verify   # typecheck, lint, format check, tests, build
npm test         # tests only
```

Do not deploy the Cloudflare coordinator (`packages/coordinator`) or write into an external
Hermes checkout (`packages/hermes-heartbeat`) without explicit approval. See `docs/` for
configuration, operations, privacy, and provider support.

## Security and privacy

- Never commit `.model-router/`, `.env`, API keys, bearer tokens, cookies, or provider cache
  files. The repository ignores the local state directories and environment files by default.
- Store the TypeSafe key in the macOS Keychain as shown above. Environment variables are a
  supported fallback, but are easier to expose accidentally through child processes or logs.
- Task text is sent to TypeSafe for classification and ranking. Do not route secrets,
  credentials, private client data, or other sensitive text.
- `router run` starts local agent processes with the permissions of your current user. Review
  the selected route and task before launching it.
- The optional coordinator and heartbeat packages are not required for ordinary personal
  accounts. Treat them as pre-release components and review their deployment configuration
  before exposing them to a network.

See [Privacy](docs/privacy.md), [Operations](docs/operations.md), and
[Configuration](docs/configuration.md) for the detailed data flow and deployment guidance.

## Contributing

Issues and focused pull requests are welcome. Before opening a pull request, run:

```sh
npm run verify
```

Please do not include credentials, private account data, local quota caches, generated state,
or provider dashboard exports in issues, tests, or commits.

## License

Agent Router is available under the [MIT License](LICENSE).
