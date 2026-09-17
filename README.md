# Model Router

Explicit TypeScript CLI that selects an eligible subscription, model, and reasoning
effort. TypeSafe ranks only the closed candidate set. Deterministic code enforces
quota, reserve, freshness, activity, privacy, and launch policy.

```sh
npm install
npm run verify
```

## Local setup

`npm run build` does not put `router` on your PATH. Keep the config inside the repo
(`.model-router/` is gitignored) and add an alias:

```sh
mkdir -p .model-router
cp config.example.json .model-router/config.json
```

Add to `~/.zshrc` (adjust the path to your checkout), then `source ~/.zshrc`:

```sh
export MODEL_ROUTER_HOME="$HOME/Code/model-router/.model-router"
alias router="node $HOME/Code/model-router/packages/router/dist/cli.js"
```

Use an alias or a wrapper script that runs `node .../dist/cli.js`. Do not symlink
`dist/cli.js` or use `npm link`: the CLI does nothing when started through a symlink.

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
router session
router accounts
router usage refresh --dry-run
```

Do not deploy the Cloudflare coordinator, write into an external Hermes checkout,
install the skill globally, or consume live provider quota without explicit approval.
