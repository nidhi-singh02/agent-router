# Model Router

Explicit TypeScript CLI that selects an eligible subscription, model, and reasoning
effort. TypeSafe ranks only the closed candidate set. Deterministic code enforces
quota, reserve, freshness, activity, privacy, and launch policy.

## Prerequisites

- Node.js 20 or newer (`nvm use` reads `.nvmrc`).
- **A TypeSafe API key.** `router run` asks TypeSafe to rank the eligible routes and pick
  the reasoning effort. There is no fallback: without a key, every run stops with
  `TypeSafe could not select a route (typesafe-unavailable)` and says where it looked.
  Each run makes live TypeSafe calls that send the task text. Store the key once in the
  macOS Keychain (the command prompts for it, so it never lands in shell history):

  ```sh
  security add-generic-password -a "$USER" -s model-router-typesafe -w
  ```

  and reference it in `.model-router/config.json`:

  ```json
  "typesafe": { "apiKeyRef": "keychain:model-router-typesafe" }
  ```

  Every pane and agent then finds the key without exporting anything, and it stays out of
  agents' environments. `TYPESAFE_API_KEY` in the environment still works as a fallback.
  To replace the key, add `-U` to the same command.

- At least one agent CLI you are logged in to: `agent` (Cursor), `claude` (Claude Code),
  `codex`, or `opencode`. The router uses those logins; provider API keys are not needed.
- Herdr (terminal workspace manager for AI coding agents) to launch agents. `router run` without `--dry-run` only
  launches inside a Herdr pane (`HERDR_ENV=1`).

```sh
npm install
npm run verify
```

## Local setup

`npm run build` does not put `router` on your PATH. Keep the config inside the repo
(`.model-router/` is gitignored) and either link the CLI or add an alias:

```sh
mkdir -p .model-router
cp config.example.json .model-router/config.json
```

Add to `~/.zshrc` (adjust the path to your checkout), then `source ~/.zshrc`:

```sh
export MODEL_ROUTER_HOME="$HOME/Code/model-router/.model-router"
```

Then put `router` on your PATH with `npm link`, or with an alias instead:

```sh
npm link -w @model-router/router
# or, in ~/.zshrc:
alias router="node $HOME/Code/model-router/packages/router/dist/cli.js"
```

## Accounts

There is no `router accounts add` command. Add accounts by editing the `accounts` array in
`.model-router/config.json` (hidden folder; open it with
`code .model-router/config.json`). Add one entry per agent login:

```json
{
  "id": "acct_personal_claude",
  "label": "personal claude",
  "provider": "anthropic",
  "agent": "claude-code",
  "ownership": "personal",
  "collectorPreference": ["official-cli"],
  "enabledModels": ["anthropic:claude-sonnet"],
  "enabled": true
}
```

- `agent`: `cursor`, `claude-code`, `codex`, or `opencode`.
- `ownership`: `personal` or `shared`. Shared accounts keep a `reserveFloor` of at least
  `0.40`. A shared account is excluded when the coordinator reports it constrained. When
  no coordinator signal is available (not configured, unreachable, unauthorized, or
  stale), it routes on its quota if usage is known (`--usage`), still subject to the
  reserve; with unknown usage it is excluded.
- `collectorPreference`: one or more of `official-api`, `official-cli`, `local-session`,
  `browser-dashboard`.
- `enabledModels`: IDs from `packages/router/config/models.json`. IDs not in that catalog
  are ignored.
- `credentialRef` (optional): `env:NAME` or `keychain:NAME`. Never put secret values in
  the file.

Run `router accounts` to confirm the file parses and lists every account. See
`docs/configuration.md` for the full schema.

## Quota from status lines

The Cursor and Claude Code CLIs do not report plan usage on the command line. The router
reads quota from small cache files that each tool's status line script writes. Enable it with
`"local-session"` in the account's `collectorPreference`. The router never reads auth
tokens. Data older than 15 minutes counts as unknown, and a cache only refreshes while a
session of that tool redraws its status line. Usage checks run only with `--usage` (see below).

### Cursor

`~/.cursor/statusline-quota-cache.json`, written by a Cursor agent status line script
(`statusLine` in `~/.cursor/cli-config.json`):

```json
{ "pct": 0, "auto_left": 80, "at": 1789643962.29 }
```

- `pct`: percent of included spend left. Grok models check this `spend` pool.
- `auto_left`: percent of the Auto pool left. Composer checks this `auto` pool.
- `at`: Unix time in seconds when the quota was read.

### Claude Code

`~/.claude/statusline-quota-cache.json`, written by a Claude Code status line script
(`statusLine` in `~/.claude/settings.json`) from the `rate_limits` it receives:

```json
{
  "at": 1789644776.2,
  "five_hour": { "used_percentage": 29, "resets_at": 1789659000 },
  "seven_day": { "used_percentage": 4, "resets_at": 1790110800 }
}
```

- `five_hour` and `seven_day`: percent used and reset time (Unix seconds). Either may be
  missing. A window whose reset time has passed counts as fully available.
- `at`: Unix time in seconds when the limits were written.

### Usage checks are opt-in

By default `router run` and `router status` skip every usage check, which keeps
`router run --dry-run` at about 0.1 s before TypeSafe instead of about 1.2 s. Without usage,
personal accounts still route (no quota check), shared accounts are excluded, and the
decision card shows
`Usage source: skipped (run with --usage to check quota)`. Pass `--usage` to read quota,
apply `quota-exhausted`, and show quota in `router status`.

## Commands

```sh
router run "<task>" [--dry-run] [--usage] [--session <id>] [--json]
router status [--usage]
router session [id] [--list] [--limit <n>] [--json]
router accounts
router usage refresh --dry-run
```

Every `router run` without `--dry-run` records a session in `.model-router/state.sqlite`:
the task, phase, chosen account, model, and effort, launch status (`launched` or
`launch-failed` with the error), Herdr pane, reservation, and handoff. `router session`
shows the latest one, `router session <id>` shows a specific one, and
`router session --list` lists recent sessions newest first. Dry runs are not recorded.

## Phases and the model-router skill

`router run` routes one phase per task (for example planning). A launched agent receives
`Router session: <id>` and instructions for the end of its phase: write the plan or handoff
notes to a file, ask you whether to route the next phase, then use the model-router skill
to run `router session <id>` and `router run --session <id> "<next-phase task>"`. The new
session records `previousSessionId`, the card shows
`Previous session: <id> (planning -> implementation)`, and the next agent gets the previous
phase and task. The next agent does not see the earlier conversation, so the task should
reference the file.

Install the skill for each agent by linking the repo copy, so updates arrive with `git pull`:

```sh
ln -s "$PWD/skills/model-router" ~/.claude/skills/model-router
ln -s "$PWD/skills/model-router" ~/.codex/skills/model-router
ln -s "$PWD/skills/model-router" ~/.cursor/skills/model-router
```

Do not deploy the Cloudflare coordinator, write into an external Hermes checkout,
install the skill globally, or consume live provider quota without explicit approval.
