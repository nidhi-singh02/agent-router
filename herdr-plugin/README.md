# Agent Router — Herdr plugin

Runs [Agent Router](../README.md) from inside Herdr: route a task, check account
status and quota, browse router sessions, and resume an earlier session.

## Install

```bash
herdr plugin install nidhi-singh02/agent-router
```

The manifest lives at the repository root, so the plugin id is
`nidhi-singh02.agent-router` and no subdirectory is needed.

Install runs `npm ci` and builds the router workspace, which needs **Node.js 20+**
and a C/C++ toolchain (`better-sqlite3` compiles natively). If you already have
`router` on your `PATH`, the plugin uses that binary instead of the checkout's
build.

Local development:

```bash
npm ci && npm run build          # plugin link does not run build commands
herdr plugin link /path/to/model-router
herdr plugin action list --plugin nidhi-singh02.agent-router
```

## Configure

The plugin does not own configuration. Agent Router reads its own config and
credentials as documented in the [main README](../README.md): a `TYPESAFE_API_KEY`
and at least one agent CLI you are logged in to.

## Actions

| Action          | What it does                                                       |
| --------------- | ------------------------------------------------------------------ |
| `route`         | Prompt for a task, route it, launch the chosen agent in a new pane |
| `status`        | Show configured accounts, optionally with live quota               |
| `sessions`      | List recent router sessions and open one in detail                 |
| `resume-latest` | Route the next phase of an earlier session                         |
| `usage-refresh` | Refresh local-session quota snapshots (headless)                   |

Invoke one directly:

```bash
herdr plugin action invoke route --plugin nidhi-singh02.agent-router
```

## Keybindings

Add to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "nidhi-singh02.agent-router.route"
description = "route a task"

[[keys.command]]
key = "prefix+R"
type = "plugin_action"
command = "nidhi-singh02.agent-router.status"
description = "router status"
```

## Environment overrides

| Variable               | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `ROUTER_BIN`           | Use a specific router executable                                            |
| `ROUTER_USAGE_SOURCE`  | `local-session` (default), `official-cli`, or `browser` for `usage-refresh` |
| `ROUTER_SESSION_LIMIT` | How many sessions the `sessions` pane lists (default 20)                    |

## Notes

- The panes are overlays: they close when you press Enter at the prompt.
- `router run` launches agents only from inside Herdr (`HERDR_ENV=1`), which
  every plugin command already has.
- Routing sends the task text to TypeSafe. See the security and privacy notes in
  the main README before routing anything sensitive.
