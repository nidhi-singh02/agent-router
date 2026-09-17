# Model Router

Explicit TypeScript CLI that selects an eligible subscription, model, and reasoning
effort. TypeSafe ranks only the closed candidate set. Deterministic code enforces
quota, reserve, freshness, activity, privacy, and launch policy.

## Prerequisites

- Node.js 20 or newer (`nvm use` reads `.nvmrc`).
- **A TypeSafe API key.** `router run` asks TypeSafe to rank the eligible routes and pick
  the reasoning effort. There is no fallback: without `TYPESAFE_API_KEY`, every run stops
  with `TypeSafe could not select a route (typesafe-unavailable)`. Each run makes live
  TypeSafe calls that send the task text. Export the key in your shell, never in the
  config file:

  ```sh
  export TYPESAFE_API_KEY=...
  ```

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
  `0.40`.
- `collectorPreference`: one or more of `official-api`, `official-cli`, `local-session`,
  `browser-dashboard`.
- `enabledModels`: IDs from `packages/router/config/models.json`. IDs not in that catalog
  are ignored.
- `credentialRef` (optional): `env:NAME` or `keychain:NAME`. Never put secret values in
  the file.

Run `router accounts` to confirm the file parses and lists every account. See
`docs/configuration.md` for the full schema.

## Commands

```sh
router run "<task>" --dry-run
router status
router session [id] [--list] [--limit <n>] [--json]
router accounts
router usage refresh --dry-run
```

Every `router run` without `--dry-run` records a session in `.model-router/state.sqlite`:
the task, phase, chosen account, model, and effort, launch status (`launched` or
`launch-failed` with the error), Herdr pane, reservation, and handoff. `router session`
shows the latest one, `router session <id>` shows a specific one, and
`router session --list` lists recent sessions newest first. Dry runs are not recorded.

Do not deploy the Cloudflare coordinator, write into an external Hermes checkout,
install the skill globally, or consume live provider quota without explicit approval.
